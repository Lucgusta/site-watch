import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { Prisma, type PrismaClient, type Monitor } from "@prisma/client";
import { checkUrl, type CheckResult } from "./transport.js";
import type { EmailSender } from "./mailer.js";

export type CheckTransport = (
  url: string,
  timeoutMs: number,
) => Promise<CheckResult>;
interface ClaimedMonitor {
  monitor: Monitor;
  token: string;
  requestId?: string;
}
export const MAX_CONCURRENCY = 3;
export const MAX_EMAIL_ATTEMPTS = 5;

export async function deliverNotifications(
  db: PrismaClient,
  sender?: EmailSender,
  now = new Date(),
): Promise<void> {
  if (!sender) return;
  // A singleton worker owns delivery. After a crash, an unsent row is retried (at-least-once).
  const pending = await db.notification.findMany({
    where: { sentAt: null, abandonedAt: null, nextTryAt: { lte: now } },
    orderBy: { nextTryAt: "asc" },
    take: 10,
  });
  for (const row of pending) {
    const attempts = row.attempts + 1;
    try {
      await sender({
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
      });
      await db.notification.update({
        where: { id: row.id },
        data: { sentAt: new Date(), attempts, lastError: null },
      });
    } catch (error) {
      const providerCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z_]{1,30}$/.test(error.code)
          ? ` (${error.code})`
          : "";
      await db.notification.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: `Email delivery failed${providerCode}`,
          nextTryAt: new Date(
            now.getTime() + Math.min(3600000, 60000 * 2 ** (attempts - 1)),
          ),
          abandonedAt: attempts >= MAX_EMAIL_ATTEMPTS ? now : null,
        },
      });
    }
  }
}

export async function persistCheck(
  db: PrismaClient,
  claimed: ClaimedMonitor,
  result: CheckResult,
  now = new Date(),
): Promise<void> {
  const { monitor, token, requestId } = claimed;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Monitor" WHERE "id" = ${monitor.id} FOR UPDATE`,
    );
    const current = await tx.monitor.findUnique({ where: { id: monitor.id } });
    if (!current || current.leaseToken !== token) return;
    if (requestId)
      await tx.checkRequest.updateMany({
        where: { id: requestId },
        data: { completedAt: now },
      });
    if (current.paused) {
      await tx.monitor.update({
        where: { id: monitor.id },
        data: { leaseToken: null, leaseUntil: null },
      });
      return;
    }
    await tx.check.create({
      data: {
        monitorId: monitor.id,
        checkedAt: now,
        source: requestId ? "MANUAL" : "AUTOMATIC",
        ...result,
      },
    });
    const nextCheckAt = new Date(
      now.getTime() + current.intervalSeconds * 1000,
    );
    if (result.errorCategory === "INTERNAL") {
      await tx.observationGap.create({
        data: {
          monitorId: monitor.id,
          startedAt: new Date(now.getTime() - result.elapsedMs),
          endedAt: now,
        },
      });
      await tx.monitor.update({
        where: { id: monitor.id },
        data: { nextCheckAt, leaseToken: null, leaseUntil: null },
      });
      return;
    }
    if (
      current.lastCheckAt &&
      now.getTime() - current.lastCheckAt.getTime() >
        current.intervalSeconds * 2000 + current.timeoutMs
    ) {
      await tx.observationGap.create({
        data: {
          monitorId: monitor.id,
          startedAt: new Date(
            current.lastCheckAt.getTime() + current.intervalSeconds * 1000,
          ),
          endedAt: now,
        },
      });
    }
    const consecutiveFails = result.success ? 0 : current.consecutiveFails + 1;
    const firstFailureAt = result.success
      ? null
      : (current.firstFailureAt ?? now);
    const open = await tx.incident.findFirst({
      where: { monitorId: monitor.id, recoveredAt: null },
    });
    if (!result.success && consecutiveFails >= 2 && !open) {
      const incident = await tx.incident.create({
        data: {
          monitorId: monitor.id,
          firstFailureAt: firstFailureAt!,
          confirmedAt: now,
          errorCategory: result.errorCategory,
        },
      });
      if (current.notificationEmail)
        await tx.notification.create({
          data: {
            incidentId: incident.id,
            kind: "INCIDENT",
            recipient: current.notificationEmail,
            subject: `[SiteWatch] ${current.name} is down`,
            body: `${current.name}\n${current.url}\n\nTwo consecutive checks failed.\nFirst failure: ${firstFailureAt!.toISOString()}\nConfirmed: ${now.toISOString()}\nCategory: ${result.errorCategory ?? "unknown"}\n${result.errorMessage ?? ""}\n\nSign in to SiteWatch to inspect this incident.`,
          },
        });
    }
    if (result.success && open) {
      await tx.incident.update({
        where: { id: open.id },
        data: { recoveredAt: now },
      });
      if (current.notificationEmail)
        await tx.notification.create({
          data: {
            incidentId: open.id,
            kind: "RECOVERY",
            recipient: current.notificationEmail,
            subject: `[SiteWatch] ${current.name} recovered`,
            body: `${current.name}\n${current.url}\n\nA successful check confirmed recovery at ${now.toISOString()}.\nHTTP status: ${result.httpStatus ?? "unknown"}\nResponse time: ${result.responseTimeMs ?? "unknown"} ms.`,
          },
        });
    }
    await tx.monitor.update({
      where: { id: monitor.id },
      data: {
        consecutiveFails,
        firstFailureAt,
        lastCheckAt: now,
        nextCheckAt,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });
}

export async function claimChecks(
  db: PrismaClient,
  now = new Date(),
): Promise<ClaimedMonitor[]> {
  return db.$transaction(async (tx) => {
    const ids = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT m."id" FROM "Monitor" m
      WHERE NOT m."paused" AND (m."leaseUntil" IS NULL OR m."leaseUntil" < ${now})
        AND (m."nextCheckAt" <= ${now} OR EXISTS (SELECT 1 FROM "CheckRequest" r WHERE r."monitorId" = m."id" AND r."completedAt" IS NULL))
      ORDER BY EXISTS (SELECT 1 FROM "CheckRequest" r WHERE r."monitorId" = m."id" AND r."completedAt" IS NULL) DESC, m."nextCheckAt" ASC
      LIMIT ${MAX_CONCURRENCY} FOR UPDATE OF m SKIP LOCKED`);
    const claimed: ClaimedMonitor[] = [];
    for (const { id } of ids) {
      const current = await tx.monitor.findUniqueOrThrow({ where: { id } });
      const request = await tx.checkRequest.findFirst({
        where: { monitorId: id, completedAt: null },
        orderBy: { createdAt: "asc" },
      });
      const token = randomUUID();
      const monitor = await tx.monitor.update({
        where: { id },
        data: {
          leaseToken: token,
          leaseUntil: new Date(now.getTime() + current.timeoutMs + 60000),
        },
      });
      if (request)
        await tx.checkRequest.update({
          where: { id: request.id },
          data: { claimedAt: now },
        });
      claimed.push({ monitor, token, requestId: request?.id });
    }
    return claimed;
  });
}

export async function cleanupHistory(
  db: PrismaClient,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  const deleted = await db.$executeRaw(
    Prisma.sql`DELETE FROM "Check" WHERE "id" IN (SELECT "id" FROM "Check" WHERE "checkedAt" < ${cutoff} ORDER BY "checkedAt" LIMIT 5000)`,
  );
  await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await db.checkRequest.deleteMany({
    where: { completedAt: { lt: new Date(now.getTime() - 86400000) } },
  });
  await db.observationGap.deleteMany({ where: { endedAt: { lt: cutoff } } });
  // Incident and notification history is intentionally preserved.
  return deleted;
}

export class MonitorWorker {
  private readonly transport: CheckTransport;
  private readonly pool: Pool;
  private lock?: PoolClient;
  private stopped = false;
  private closed = false;
  private notificationTask?: Promise<void>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      db: PrismaClient;
      databaseUrl: string;
      sender?: EmailSender;
      transport?: CheckTransport;
      log?: (message: string) => void;
    },
  ) {
    this.transport = options.transport ?? checkUrl;
    this.pool = new Pool({ connectionString: options.databaseUrl, max: 1 });
  }
  async start(): Promise<void> {
    try {
      this.lock = await this.pool.connect();
      const result = await this.lock.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(718022) AS acquired",
      );
      if (!result.rows[0]?.acquired)
        throw new Error(
          "Another monitoring worker already holds the singleton lock.",
        );
      // Losing the lock-owning connection ends this process instead of running uncoordinated.
      this.lock.on("error", () => {
        this.stopped = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.options.log?.("Worker lock connection lost; stopping.");
      });
      const db = this.options.db;
      const now = new Date();
      await db.monitor.updateMany({
        where: { leaseUntil: { not: null } },
        data: { leaseToken: null, leaseUntil: null },
      });
      const overdue = await db.monitor.findMany({
        where: { paused: false, nextCheckAt: { lte: now } },
      });
      for (const monitor of overdue)
        await db.monitor.update({
          where: { id: monitor.id },
          data: {
            nextCheckAt: new Date(
              now.getTime() + 1000 + Math.floor(Math.random() * 14000),
            ),
          },
        });
      await db.workerHeartbeat.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", startedAt: now, lastSeenAt: now },
        update: { startedAt: now, lastSeenAt: now },
      });
      this.heartbeatTimer = setInterval(() => {
        void db.workerHeartbeat
          .update({
            where: { id: "singleton" },
            data: { lastSeenAt: new Date() },
          })
          .catch(() => {
            this.options.log?.("Heartbeat write failed.");
          });
      }, 10000);
      this.options.log?.("Worker started. Maximum concurrent checks: 3.");
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async tick(): Promise<void> {
    const { db } = this.options;
    const claimed = await claimChecks(db);
    await Promise.all(
      claimed.map(async (item) => {
        let result: CheckResult;
        const started = Date.now();
        try {
          result = await this.transport(
            item.monitor.url,
            item.monitor.timeoutMs,
          );
        } catch {
          result = {
            success: false,
            httpStatus: null,
            responseTimeMs: null,
            elapsedMs: Date.now() - started,
            errorCategory: "INTERNAL",
            errorMessage:
              "The monitoring transport encountered an internal error.",
          };
        }
        await persistCheck(db, item, result);
      }),
    );
  }
  async run(): Promise<void> {
    await this.start();
    let lastCleanup = 0;
    try {
      while (!this.stopped) {
        if (!this.notificationTask && this.options.sender)
          this.notificationTask = deliverNotifications(
            this.options.db,
            this.options.sender,
          )
            .catch(() => {
              this.options.log?.(
                "Notification outbox cycle failed; durable messages remain queued.",
              );
            })
            .finally(() => {
              this.notificationTask = undefined;
            });
        try {
          await this.tick();
          if (Date.now() - lastCleanup > 60000) {
            await cleanupHistory(this.options.db);
            lastCleanup = Date.now();
          }
        } catch {
          this.options.log?.(
            "Worker cycle failed; retrying without changing website health.",
          );
        }
        await new Promise((done) => setTimeout(done, 1000));
      }
    } finally {
      await this.close();
    }
  }
  requestStop(): void {
    this.stopped = true;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.notificationTask;
    if (this.lock) {
      await this.lock
        .query("SELECT pg_advisory_unlock(718022)")
        .catch(() => undefined);
      this.lock.release();
      this.lock = undefined;
    }
    await this.pool.end();
  }
}
