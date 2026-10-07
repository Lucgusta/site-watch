import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, type PrismaClient, type Session } from "@prisma/client";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  constantEquals,
  newToken,
  sessionHash,
  verifyPassword,
} from "./auth.js";
import { demoData } from "./demo.js";
import {
  checkView,
  incidentView,
  monitorView,
  PERIOD_MS,
  type Metrics,
  type Period,
} from "./domain.js";
import { validateUrl } from "./transport.js";

declare module "fastify" {
  interface FastifyRequest {
    authSession: Session | null;
  }
}
const COOKIE = "sitewatch_session";
const monitorInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.string().min(1).max(2048),
    intervalSeconds: z
      .union([z.literal(60), z.literal(300), z.literal(900)])
      .default(300),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    slowThresholdMs: z.number().int().min(100).max(30000).default(2000),
    notificationEmail: z
      .email()
      .max(254)
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .strict();
// Keep PATCH free of creation defaults: omitted fields must stay unchanged.
const patchInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.string().min(1).max(2048).optional(),
    intervalSeconds: z
      .union([z.literal(60), z.literal(300), z.literal(900)])
      .optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
    slowThresholdMs: z.number().int().min(100).max(30000).optional(),
    notificationEmail: z.email().max(254).nullable().optional(),
    paused: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).length > 0,
    "Provide at least one field to update.",
  );
const queryInput = z.object({
  period: z.enum(["24h", "7d", "30d"]).default("24h"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(100).optional(),
  state: z
    .enum(["UP", "SLOW", "PENDING", "DOWN", "STALE", "PAUSED", "NO_DATA"])
    .optional(),
});
class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
function idOf(request: FastifyRequest) {
  return z.object({ id: z.string().min(1).max(80) }).parse(request.params).id;
}
function cutoff(period: Period) {
  return new Date(Date.now() - PERIOD_MS[period]);
}

export async function databaseMetrics(
  db: PrismaClient,
  monitorId: string,
  period: Period,
): Promise<Metrics> {
  const rows = await db.$queryRaw<
    {
      samples: bigint;
      successfulSamples: bigint;
      averageMs: number | null;
      p95Ms: number | null;
    }[]
  >(Prisma.sql`
    SELECT count(*) AS "samples", count(*) FILTER (WHERE "success") AS "successfulSamples",
      avg("responseTimeMs") FILTER (WHERE "success") AS "averageMs",
      percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") FILTER (WHERE "success" AND "responseTimeMs" IS NOT NULL) AS "p95Ms"
    FROM "Check" WHERE "monitorId" = ${monitorId} AND "checkedAt" >= ${cutoff(period)} AND ("errorCategory" IS NULL OR "errorCategory" <> 'INTERNAL')`);
  const row = rows[0]!;
  const samples = Number(row.samples);
  const successfulSamples = Number(row.successfulSamples);
  return {
    samples,
    successfulSamples,
    availability: samples ? (successfulSamples / samples) * 100 : null,
    averageMs:
      row.averageMs === null ? null : Math.round(Number(row.averageMs)),
    p95Ms: row.p95Ms === null ? null : Number(row.p95Ms),
  };
}
export async function databaseChart(
  db: PrismaClient,
  monitorId: string,
  period: Period,
) {
  const bucketMs =
    period === "24h" ? 300000 : period === "7d" ? 1800000 : 7200000;
  const now = new Date();
  const start = new Date(now.getTime() - PERIOD_MS[period]);
  const rows = await db.$queryRaw<
    { checkedAt: Date; responseTimeMs: number | null; samples: bigint }[]
  >(Prisma.sql`
    SELECT bucket AS "checkedAt", avg(c."responseTimeMs") FILTER (WHERE c."success") AS "responseTimeMs", count(c."id") AS "samples"
    FROM generate_series(${start}::timestamp, ${now}::timestamp, ${bucketMs} * interval '1 millisecond') AS bucket
    LEFT JOIN "Check" c ON c."monitorId" = ${monitorId} AND c."checkedAt" >= bucket AND c."checkedAt" < bucket + ${bucketMs} * interval '1 millisecond'
      AND (c."errorCategory" IS NULL OR c."errorCategory" <> 'INTERNAL')
    GROUP BY bucket ORDER BY bucket ASC`);
  return rows.map((row) => ({
    checkedAt: row.checkedAt,
    responseTimeMs:
      row.responseTimeMs === null
        ? null
        : Math.round(Number(row.responseTimeMs)),
    samples: Number(row.samples),
  }));
}
async function viewFor(db: PrismaClient, id: string, period: Period) {
  const monitor = await db.monitor.findUnique({
    where: { id },
    include: { incidents: { where: { recoveredAt: null }, take: 1 } },
  });
  if (!monitor) throw new HttpError(404, "Monitor not found.");
  const check = await db.check.findFirst({
    where: { monitorId: id, checkedAt: { gte: monitor.targetChangedAt } },
    orderBy: { checkedAt: "desc" },
  });
  return {
    ...monitorView(monitor, [], check, monitor.incidents[0] ?? null),
    metrics: await databaseMetrics(db, id, period),
  };
}

export async function createApp(options: {
  db: PrismaClient;
  config: Config;
  logger?: boolean;
  staticDir?: string;
}): Promise<FastifyInstance> {
  const { db, config } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.decorateRequest("authSession", null);
  app.addHook("onRequest", async (request, reply) => {
    const path =
      request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (path.startsWith("/api")) reply.header("Cache-Control", "no-store");
    if (!path.startsWith("/api")) return;
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (path.startsWith("/api/demo") && mutation)
      throw new HttpError(403, "The demo is read-only.");
    if (mutation && request.headers.origin !== config.origin)
      throw new HttpError(403, "Invalid request origin.");
    const token = request.cookies[COOKIE];
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      request.authSession = await db.session.findUnique({
        where: { tokenHash: sessionHash(token, config.sessionSecret) },
      });
      if (request.authSession && request.authSession.expiresAt <= new Date())
        request.authSession = null;
    }
    if (
      /^\/api\/(monitors|incidents|notifications)(\/|$)/.test(path) ||
      path === "/api/logout"
    ) {
      if (!request.authSession)
        throw new HttpError(401, "Sign in to manage monitors.");
      if (
        mutation &&
        (typeof request.headers["x-csrf-token"] !== "string" ||
          !constantEquals(
            request.headers["x-csrf-token"],
            request.authSession.csrfToken,
          ))
      )
        throw new HttpError(403, "Invalid CSRF token.");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      reply
        .status(400)
        .send({
          error: error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
      return;
    }
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      reply.status(404).send({ error: "Monitor not found." });
      return;
    }
    const code =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (code >= 500)
      request.log.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "API request failed.",
      );
    reply
      .status(code)
      .send({
        error:
          code >= 500
            ? "The server could not complete this request."
            : error instanceof Error
              ? error.message
              : "Request rejected.",
      });
  });
  app.get("/api/health", async () => {
    await db.$queryRaw`SELECT 1`;
    return { status: "ok" };
  });
  app.get("/api/session", async (request) =>
    request.authSession
      ? {
          authenticated: true,
          csrfToken: request.authSession.csrfToken,
          username: request.authSession.username,
        }
      : { authenticated: false },
  );
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({ username: z.string().max(80), password: z.string().max(256) })
        .strict()
        .parse(request.body);
      // Always derive the password, including for an unknown username.
      const validPassword = await verifyPassword(
        body.password,
        config.passwordHash,
      );
      if (!constantEquals(body.username, config.username) || !validPassword)
        throw new HttpError(401, "Invalid username or password.");
      if (request.authSession)
        await db.session.delete({ where: { id: request.authSession.id } });
      const token = newToken();
      const csrfToken = newToken();
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
      await db.session.create({
        data: {
          username: config.username,
          tokenHash: sessionHash(token, config.sessionSecret),
          csrfToken,
          expiresAt,
        },
      });
      reply.setCookie(COOKIE, token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: config.production,
        expires: expiresAt,
      });
      return { authenticated: true, username: config.username, csrfToken };
    },
  );
  app.post("/api/logout", async (request, reply) => {
    await db.session.delete({ where: { id: request.authSession!.id } });
    reply.clearCookie(COOKIE, { path: "/" });
    return { authenticated: false };
  });

  app.get("/api/demo/monitors", async (request) => {
    const { period } = queryInput.parse(request.query);
    const {
      checks: _checks,
      incidents: _incidents,
      checkView: _checkView,
      ...data
    } = demoData(period);
    return data;
  });
  app.get("/api/demo/monitors/:id", async (request) => {
    const { period } = queryInput.parse(request.query);
    const data = demoData(period);
    const monitor = data.items.find((item) => item.id === idOf(request));
    if (!monitor) throw new HttpError(404, "Demo monitor not found.");
    const checks = data.checks.filter(
      (check) => check.monitorId === monitor.id,
    );
    const stride = Math.max(1, Math.ceil(checks.length / 360));
    const chart = checks
      .filter((_check, index) => index % stride === 0)
      .map((check, index) => {
        const group = checks.slice(index * stride, (index + 1) * stride);
        const times = group
          .filter((sample) => sample.success && sample.responseTimeMs !== null)
          .map((sample) => sample.responseTimeMs!);
        return {
          checkedAt: check.checkedAt,
          responseTimeMs: times.length
            ? Math.round(
                times.reduce((sum, time) => sum + time, 0) / times.length,
              )
            : null,
          samples: group.length,
        };
      })
      .reverse();
    return {
      monitor,
      checks: checks.slice(0, 500).map(checkView),
      chart,
      incidents: data.incidents.filter(
        (incident) => incident.monitorId === monitor.id,
      ),
      gaps:
        monitor.state === "STALE"
          ? [{ startedAt: monitor.lastCheck!.checkedAt, endedAt: new Date() }]
          : [],
      retentionDays: 30,
    };
  });
  app.get("/api/demo/incidents", async (request) => {
    const { period } = queryInput.parse(request.query);
    return {
      items: demoData(period).incidents,
      total: 1,
      page: 1,
      pageSize: 100,
    };
  });
  app.all("/api/demo/*", async () => {
    throw new HttpError(403, "The demo is read-only.");
  });

  app.get("/api/monitors", async (request) => {
    const query = queryInput.parse(request.query);
    const monitors = await db.monitor.findMany({
      where: query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { url: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {},
      orderBy: { createdAt: "asc" },
    });
    let items = await Promise.all(
      monitors.map((monitor) => viewFor(db, monitor.id, query.period)),
    );
    if (query.state) items = items.filter((item) => item.state === query.state);
    const heartbeat = await db.workerHeartbeat.findUnique({
      where: { id: "singleton" },
    });
    return {
      items: items.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      ),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize,
      worker: {
        lastSeenAt: heartbeat?.lastSeenAt ?? null,
        stale:
          !heartbeat || Date.now() - heartbeat.lastSeenAt.getTime() > 45000,
      },
      notifications: { configured: Boolean(config.smtp) },
    };
  });
  app.get("/api/monitors/:id", async (request) => {
    const id = idOf(request);
    const { period } = queryInput.parse(request.query);
    const monitor = await viewFor(db, id, period);
    const [checks, incidents, gaps] = await Promise.all([
      db.check.findMany({
        where: { monitorId: id, checkedAt: { gte: cutoff(period) } },
        orderBy: { checkedAt: "desc" },
        take: 500,
      }),
      db.incident.findMany({
        where: {
          monitorId: id,
          OR: [{ recoveredAt: null }, { recoveredAt: { gte: cutoff(period) } }],
        },
        orderBy: { confirmedAt: "desc" },
        take: 100,
      }),
      db.observationGap.findMany({
        where: { monitorId: id, endedAt: { gte: cutoff(period) } },
        orderBy: { startedAt: "desc" },
      }),
    ]);
    return {
      monitor,
      checks: checks.map(checkView),
      chart: await databaseChart(db, id, period),
      incidents: incidents.map((incident) =>
        incidentView(incident, monitor.name),
      ),
      gaps: gaps.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
      retentionDays: 30,
    };
  });
  app.get("/api/monitors/:id/metrics", async (request) => {
    const id = idOf(request);
    const { period } = queryInput.parse(request.query);
    await viewFor(db, id, period);
    return {
      period,
      ...(await databaseMetrics(db, id, period)),
      retentionDays: 30,
    };
  });
  app.get("/api/monitors/:id/checks", async (request) => {
    const id = idOf(request);
    const query = queryInput.parse(request.query);
    await viewFor(db, id, query.period);
    const where = { monitorId: id, checkedAt: { gte: cutoff(query.period) } };
    const [items, total] = await Promise.all([
      db.check.findMany({
        where,
        orderBy: { checkedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      db.check.count({ where }),
    ]);
    return {
      items: items.map(checkView),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
  for (const path of ["/api/incidents", "/api/monitors/:id/incidents"])
    app.get(path, async (request) => {
      const query = queryInput.parse(request.query);
      const monitorId = path.includes(":id") ? idOf(request) : undefined;
      const where = {
        ...(monitorId ? { monitorId } : {}),
        OR: [
          { recoveredAt: null },
          { recoveredAt: { gte: cutoff(query.period) } },
        ],
      };
      const [items, total] = await Promise.all([
        db.incident.findMany({
          where,
          include: { monitor: { select: { name: true } } },
          orderBy: { confirmedAt: "desc" },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        db.incident.count({ where }),
      ]);
      return {
        items: items.map((incident) => incidentView(incident)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  app.get("/api/notifications", async () => ({
    configured: Boolean(config.smtp),
    failures: await db.notification.findMany({
      where: { lastError: { not: null }, sentAt: null },
      select: {
        id: true,
        incidentId: true,
        kind: true,
        attempts: true,
        abandonedAt: true,
        nextTryAt: true,
      },
      orderBy: { nextTryAt: "desc" },
      take: 50,
    }),
  }));

  app.post("/api/monitors", async (request, reply) => {
    const body = monitorInput.parse(request.body);
    try {
      body.url = validateUrl(body.url).toString();
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error ? error.message : "Invalid URL.",
      );
    }
    const monitor = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(718020)::text`;
      if ((await tx.monitor.count()) >= 20)
        throw new HttpError(409, "A maximum of 20 monitors is supported.");
      return tx.monitor.create({ data: body });
    });
    reply.status(201);
    return viewFor(db, monitor.id, "24h");
  });
  app.patch("/api/monitors/:id", async (request) => {
    const body = patchInput.parse(request.body);
    const id = idOf(request);
    if (body.url !== undefined) {
      try {
        body.url = validateUrl(body.url).toString();
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : "Invalid URL.",
        );
      }
    }
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Monitor" WHERE "id" = ${id} FOR UPDATE`,
      );
      const current = await tx.monitor.findUnique({ where: { id } });
      if (!current) throw new HttpError(404, "Monitor not found.");
      const targetChanged = Boolean(body.url && body.url !== current.url);
      if (
        targetChanged &&
        current.leaseUntil &&
        current.leaseUntil > new Date()
      )
        throw new HttpError(
          409,
          "A check is in progress. Retry the URL change shortly.",
        );
      if (
        targetChanged &&
        (await tx.incident.count({
          where: { monitorId: id, recoveredAt: null },
        }))
      )
        throw new HttpError(
          409,
          "Resolve the open incident before changing the monitored URL.",
        );
      await tx.monitor.update({
        where: { id },
        data: {
          ...body,
          nextCheckAt:
            body.paused === false || targetChanged
              ? new Date(Date.now() + 1000)
              : current.nextCheckAt,
          ...(targetChanged
            ? {
                targetChangedAt: new Date(),
                lastCheckAt: null,
                consecutiveFails: 0,
                firstFailureAt: null,
              }
            : {}),
        },
      });
      if (body.paused)
        await tx.checkRequest.updateMany({
          where: { monitorId: id, completedAt: null },
          data: { completedAt: new Date() },
        });
    });
    return viewFor(db, id, "24h");
  });
  app.delete("/api/monitors/:id", async (request, reply) => {
    await db.monitor.delete({ where: { id: idOf(request) } });
    reply.status(204).send();
  });
  app.post(
    "/api/monitors/:id/check",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const id = idOf(request);
      const queued = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(718021)::text`;
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Monitor" WHERE "id" = ${id} FOR UPDATE`,
        );
        const monitor = await tx.monitor.findUnique({ where: { id } });
        if (!monitor) throw new HttpError(404, "Monitor not found.");
        if (monitor.paused)
          throw new HttpError(
            409,
            "Resume this monitor before requesting a check.",
          );
        if (
          monitor.lastManualAt &&
          Date.now() - monitor.lastManualAt.getTime() < 60000
        )
          throw new HttpError(429, "Wait one minute between manual checks.");
        if (
          await tx.checkRequest.count({
            where: { completedAt: null, monitorId: id },
          })
        )
          throw new HttpError(
            409,
            "A check is already queued for this monitor.",
          );
        if (
          (await tx.checkRequest.count({ where: { completedAt: null } })) >= 3
        )
          throw new HttpError(
            429,
            "The manual check queue is full. Try again shortly.",
          );
        await tx.monitor.update({
          where: { id },
          data: { lastManualAt: new Date() },
        });
        return tx.checkRequest.create({ data: { monitorId: id } });
      });
      reply.status(202);
      return { queued: true, requestId: queued.id };
    },
  );

  const staticDir =
    options.staticDir ??
    process.env.STATIC_DIR ??
    resolve(process.cwd(), "../web/dist");
  if (existsSync(resolve(staticDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: resolve(staticDir),
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) =>
      request.url.startsWith("/api")
        ? reply.status(404).send({ error: "Endpoint not found." })
        : reply.type("text/html").sendFile("index.html"),
    );
  } else
    app.setNotFoundHandler(async (_request, reply) =>
      reply.status(404).send({ error: "Endpoint not found." }),
    );
  return app;
}
