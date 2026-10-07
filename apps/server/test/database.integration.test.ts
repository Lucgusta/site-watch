import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createDatabase } from "../src/db.js";
import {
  claimChecks,
  cleanupHistory,
  deliverNotifications,
  MonitorWorker,
  persistCheck,
} from "../src/worker.js";
import { computeMetrics } from "../src/domain.js";
import type { Config } from "../src/config.js";
import "../src/config.js";
import type { CheckResult } from "../src/transport.js";

// These tests use real PostgreSQL, real transactions and real Fastify injection.
// The transport and email sender are controlled dependencies; no auth bypass exists.
const enabled = process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled)("PostgreSQL API and worker integration", () => {
  const schema = `sitewatch_test_${randomUUID().replaceAll("-", "")}`;
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  const origin = "http://localhost:3000";
  let db: PrismaClient;
  let pool: Pool;
  let app: FastifyInstance;
  let config: Config;
  const good: CheckResult = {
    success: true,
    httpStatus: 200,
    responseTimeMs: 100,
    elapsedMs: 120,
    errorCategory: null,
    errorMessage: null,
  };
  const bad: CheckResult = {
    success: false,
    httpStatus: 503,
    responseTimeMs: 180,
    elapsedMs: 200,
    errorCategory: "HTTP_STATUS",
    errorMessage: "HTTP 503",
  };
  beforeAll(async () => {
    if (!url)
      throw new Error(
        "RUN_DB_TESTS requires TEST_DATABASE_URL or DATABASE_URL.",
      );
    pool = new Pool({ connectionString: url });
    const connection = await pool.connect();
    try {
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET search_path TO "${schema}"`);
      await connection.query(
        await readFile(
          new URL(
            "../prisma/migrations/20261006000000_initial/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    } finally {
      connection.release();
    }
    db = createDatabase(url, schema);
    config = {
      databaseUrl: url,
      origin,
      username: "owner",
      passwordHash: await hashPassword("correct-test-password"),
      sessionSecret: "s".repeat(48),
      production: false,
    };
    app = await createApp({ db, config });
    await app.ready();
  }, 30000);
  beforeEach(async () => {
    await app.close();
    await db.monitor.deleteMany();
    await db.session.deleteMany();
    await db.workerHeartbeat.deleteMany();
    app = await createApp({ db, config });
    await app.ready();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.$disconnect();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
  async function login() {
    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { origin },
      payload: { username: "owner", password: "correct-test-password" },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: response.cookies[0]!.name + "=" + response.cookies[0]!.value,
      origin,
      "x-csrf-token": response.json().csrfToken as string,
    };
  }
  async function createMonitor(
    name = "Example",
    extras: Record<string, unknown> = {},
  ) {
    return db.monitor.create({
      data: {
        name,
        url: "https://example.com/",
        intervalSeconds: 60,
        ...extras,
      },
    });
  }
  async function observe(id: string, result: CheckResult, at = new Date()) {
    await db.monitor.update({
      where: { id },
      data: { nextCheckAt: new Date(0), leaseToken: null, leaseUntil: null },
    });
    const claims = await claimChecks(db, at);
    const claimed = claims.find((claim) => claim.monitor.id === id)!;
    expect(claimed).toBeDefined();
    await persistCheck(db, claimed, result, at);
  }

  it("requires sign-in, same origin and CSRF before mutations, persists a hashed session and expires it", async () => {
    expect((await app.inject("/api/monitors")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          payload: { username: "owner", password: "correct-test-password" },
        })
      ).statusCode,
    ).toBe(403);
    const headers = await login();
    const session = await db.session.findFirstOrThrow();
    expect(session.tokenHash).not.toBe(headers.cookie.split("=")[1]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors",
          headers: { cookie: headers.cookie, origin },
          payload: { name: "No CSRF", url: "https://example.com" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/monitors",
          headers: { ...headers, origin: "https://evil.example" },
          payload: { name: "Bad origin", url: "https://example.com" },
        })
      ).statusCode,
    ).toBe(403);
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(0) },
    });
    expect((await app.inject({ url: "/api/session", headers })).json()).toEqual(
      { authenticated: false },
    );
  });
  it("keeps demo data read-only and never writes demo monitors", async () => {
    expect((await app.inject("/api/demo/monitors")).json().items.length).toBe(
      6,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/demo/monitors",
          headers: { origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(await db.monitor.count()).toBe(0);
  });
  it("guards logout even with query strings and revokes a signed-in session", async () => {
    const headers = await login();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/logout?x=1",
          headers: { cookie: headers.cookie, origin },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/logout?x=1", headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/monitors", headers })).statusCode,
    ).toBe(401);
    expect(await db.session.count()).toBe(0);
  });
  it("sets expiring HttpOnly, SameSite=Strict, Secure cookies in production", async () => {
    const production = await createApp({
      db,
      config: {
        ...config,
        production: true,
        origin: "https://monitor.example.com",
      },
    });
    try {
      const response = await production.inject({
        method: "POST",
        url: "/api/login",
        headers: { origin: "https://monitor.example.com" },
        payload: { username: "owner", password: "correct-test-password" },
      });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers["set-cookie"]);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Expires=");
      expect(
        (await db.session.findFirstOrThrow()).expiresAt.getTime() - Date.now(),
      ).toBeGreaterThan(11 * 3600000);
    } finally {
      await production.close();
    }
  });
  it("creates, edits, queues and pauses monitors through the real authenticated API", async () => {
    const headers = await login();
    const response = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers,
      payload: {
        name: "Customer site",
        url: "https://example.com",
        intervalSeconds: 900,
        timeoutMs: 17000,
        slowThresholdMs: 800,
        notificationEmail: "owner@example.com",
      },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    expect(response.json().state).toBe("NO_DATA");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/monitors/${id}`,
          headers,
          payload: { url: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/monitors/${id}/check`,
          headers,
        })
      ).statusCode,
    ).toBe(202);
    expect(await db.check.count()).toBe(0);
    expect(await db.checkRequest.count({ where: { completedAt: null } })).toBe(
      1,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/monitors/${id}/check`,
          headers,
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/monitors/${id}`,
          headers,
          payload: { paused: true },
        })
      ).json().state,
    ).toBe("PAUSED");
    expect(await db.monitor.findUniqueOrThrow({ where: { id } })).toMatchObject(
      {
        intervalSeconds: 900,
        timeoutMs: 17000,
        slowThresholdMs: 800,
        notificationEmail: "owner@example.com",
      },
    );
    expect(await db.checkRequest.count({ where: { completedAt: null } })).toBe(
      0,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/monitors/${id}/check`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/monitors/${id}`,
          headers,
        })
      ).statusCode,
    ).toBe(204);
  });
  it("enforces the 20-monitor cap under concurrent create requests", async () => {
    await db.monitor.createMany({
      data: Array.from({ length: 19 }, (_, index) => ({
        name: `Fleet ${index}`,
        url: "https://example.com",
      })),
    });
    const headers = await login();
    const responses = await Promise.all(
      [1, 2].map((number) =>
        app.inject({
          method: "POST",
          url: "/api/monitors",
          headers,
          payload: { name: `Last ${number}`, url: "https://example.com" },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(await db.monitor.count()).toBe(20);
  });
  it("claims at most 3 checks without claiming the same leased monitor twice", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createMonitor(`Concurrent ${index}`),
      ),
    );
    const [first, second] = await Promise.all([
      claimChecks(db),
      claimChecks(db),
    ]);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(second.length).toBeLessThanOrEqual(3);
    const ids = [...first, ...second].map((claim) => claim.monitor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("confirms one incident after two failures, excludes internal failures, and atomically records recovery and alerts", async () => {
    const monitor = await createMonitor("Email alerts", {
      notificationEmail: "owner@example.com",
    });
    await observe(monitor.id, bad);
    expect(await db.incident.count()).toBe(0);
    await observe(monitor.id, { ...bad, errorCategory: "INTERNAL" });
    expect(
      (await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } }))
        .consecutiveFails,
    ).toBe(1);
    await observe(monitor.id, bad);
    await observe(monitor.id, bad);
    expect(await db.incident.count()).toBe(1);
    expect(await db.notification.count({ where: { kind: "INCIDENT" } })).toBe(
      1,
    );
    await observe(monitor.id, good);
    expect(await db.incident.count({ where: { recoveredAt: null } })).toBe(0);
    expect(await db.notification.count({ where: { kind: "RECOVERY" } })).toBe(
      1,
    );
    expect(computeMetrics(await db.check.findMany())).toMatchObject({
      samples: 4,
      successfulSamples: 1,
      availability: 25,
    });
  });
  it("discards results that complete after a monitor was paused", async () => {
    const monitor = await createMonitor();
    const claimed = (await claimChecks(db))[0]!;
    await db.monitor.update({
      where: { id: monitor.id },
      data: { paused: true },
    });
    await persistCheck(db, claimed, bad);
    expect(await db.check.count()).toBe(0);
    expect(await db.incident.count()).toBe(0);
    expect(
      (await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } }))
        .leaseToken,
    ).toBeNull();
  });
  it("retries durable email failures with bounded backoff without changing site health", async () => {
    const monitor = await createMonitor("Notify", {
      notificationEmail: "owner@example.com",
    });
    await observe(monitor.id, bad);
    await observe(monitor.id, bad);
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new Error("SMTP unavailable"))
      .mockResolvedValue(undefined);
    const now = new Date(Date.now() + 1000);
    await deliverNotifications(db, sender, now);
    const failed = await db.notification.findFirstOrThrow();
    expect(failed.attempts).toBe(1);
    expect(failed.sentAt).toBeNull();
    expect(failed.nextTryAt.getTime()).toBe(now.getTime() + 60000);
    expect(
      (await db.monitor.findUniqueOrThrow({ where: { id: monitor.id } }))
        .consecutiveFails,
    ).toBe(2);
    await deliverNotifications(db, sender, new Date(now.getTime() + 60001));
    expect((await db.notification.findFirstOrThrow()).sentAt).not.toBeNull();
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it("preserves incidents when incremental cleanup removes raw checks older than 30 days", async () => {
    const monitor = await createMonitor();
    await observe(monitor.id, bad, new Date(Date.now() - 32 * 86400000));
    await observe(monitor.id, bad, new Date(Date.now() - 31 * 86400000));
    expect(await db.incident.count()).toBe(1);
    expect(await cleanupHistory(db)).toBe(2);
    expect(await db.check.count()).toBe(0);
    expect(await db.incident.count()).toBe(1);
  });
  it("aggregates the full selected period and preserves empty chart buckets as missing data", async () => {
    const monitor = await createMonitor();
    const now = new Date();
    await db.check.createMany({
      data: [
        {
          monitorId: monitor.id,
          checkedAt: new Date(now.getTime() - 6 * 86400000),
          source: "AUTOMATIC",
          ...good,
        },
        {
          monitorId: monitor.id,
          checkedAt: now,
          source: "MANUAL",
          ...good,
          responseTimeMs: 300,
        },
        {
          monitorId: monitor.id,
          checkedAt: now,
          source: "AUTOMATIC",
          ...bad,
          errorCategory: "INTERNAL",
        },
      ],
    });
    const headers = await login();
    const response = await app.inject({
      url: `/api/monitors/${monitor.id}?period=7d`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.monitor.metrics).toMatchObject({
      samples: 2,
      successfulSamples: 2,
      availability: 100,
      averageMs: 200,
      p95Ms: 300,
    });
    expect(detail.chart.length).toBeGreaterThanOrEqual(336);
    expect(
      detail.chart.reduce(
        (total: number, item: { samples: number }) => total + item.samples,
        0,
      ),
    ).toBe(2);
    expect(
      detail.chart.some(
        (item: { samples: number; responseTimeMs: number | null }) =>
          item.samples === 0 && item.responseTimeMs === null,
      ),
    ).toBe(true);
  });
  it("supports an optional notification email and permanently bounds delivery retries", async () => {
    const plain = await createMonitor("No email");
    await observe(plain.id, bad);
    await observe(plain.id, bad);
    expect(await db.notification.count()).toBe(0);
    await db.monitor.update({
      where: { id: plain.id },
      data: { paused: true },
    });
    const monitored = await createMonitor("Email", {
      notificationEmail: "owner@example.com",
    });
    await observe(monitored.id, bad);
    await observe(monitored.id, bad);
    await deliverNotifications(db);
    expect((await db.notification.findFirstOrThrow()).attempts).toBe(0);
    const sender = vi.fn().mockRejectedValue(new Error("Unavailable"));
    for (let attempt = 0; attempt < 6; attempt++)
      await deliverNotifications(
        db,
        sender,
        new Date(Date.now() + (attempt + 1) * 3600000),
      );
    const notification = await db.notification.findFirstOrThrow();
    expect(notification.attempts).toBe(5);
    expect(notification.abandonedAt).not.toBeNull();
    expect(sender).toHaveBeenCalledTimes(5);
    expect(notification.lastError).toBe("Email delivery failed");
  });
  it("runs a genuine worker tick with an injected transport and persists manual results", async () => {
    const monitor = await createMonitor();
    await db.checkRequest.create({ data: { monitorId: monitor.id } });
    const transport = vi.fn().mockResolvedValue(good);
    const worker = new MonitorWorker({ db, databaseUrl: url!, transport });
    await worker.start();
    await worker.tick();
    await worker.close();
    expect(transport).toHaveBeenCalledOnce();
    expect((await db.check.findFirstOrThrow()).source).toBe("MANUAL");
    expect(await db.checkRequest.count({ where: { completedAt: null } })).toBe(
      0,
    );
  });
  it("allows one worker at a time and releases the singleton lock on shutdown", async () => {
    const first = new MonitorWorker({ db, databaseUrl: url! });
    const second = new MonitorWorker({ db, databaseUrl: url! });
    await first.start();
    try {
      await expect(second.start()).rejects.toThrow(/Another monitoring worker/);
    } finally {
      await first.close();
      await second.close();
    }
    const third = new MonitorWorker({ db, databaseUrl: url! });
    await third.start();
    await third.close();
  });
});
