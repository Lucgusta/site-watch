import { describe, expect, it } from "vitest";
import { computeMetrics, monitorState } from "./domain.js";
import { hashPassword, verifyPassword, sessionHash } from "./auth.js";
import { demoData } from "./demo.js";
const now = new Date("2026-10-06T12:00:00Z");
const monitor = {
  paused: false,
  lastCheckAt: new Date(now.getTime() - 1000),
  createdAt: new Date(now.getTime() - 3600000),
  intervalSeconds: 60,
  timeoutMs: 10000,
  consecutiveFails: 0,
  slowThresholdMs: 1000,
};
const success = { success: true, responseTimeMs: 120, errorCategory: null };
describe("monitor health and metric semantics", () => {
  it("never turns missing samples into perfect availability", () => {
    expect(computeMetrics([])).toEqual({
      availability: null,
      averageMs: null,
      p95Ms: null,
      samples: 0,
      successfulSamples: 0,
    });
  });
  it("excludes internal failures and failed request latency, and uses nearest-rank p95", () => {
    const metrics = computeMetrics([
      { ...success, responseTimeMs: 100 },
      { ...success, responseTimeMs: 500 },
      {
        ...success,
        success: false,
        responseTimeMs: 900,
        errorCategory: "HTTP_STATUS",
      },
      { ...success, success: false, errorCategory: "INTERNAL" },
    ]);
    expect(metrics).toMatchObject({
      averageMs: 300,
      p95Ms: 500,
      samples: 3,
      successfulSamples: 2,
    });
    expect(metrics.availability).toBeCloseTo(200 / 3);
  });
  it("prioritizes pause and stale data over earlier online status", () => {
    expect(monitorState(monitor, success, now)).toBe("UP");
    expect(monitorState({ ...monitor, paused: true }, success, now)).toBe(
      "PAUSED",
    );
    expect(
      monitorState(
        { ...monitor, lastCheckAt: new Date(now.getTime() - 130001) },
        success,
        now,
      ),
    ).toBe("STALE");
    expect(
      monitorState(
        monitor,
        { ...success, errorCategory: "INTERNAL", success: false },
        now,
      ),
    ).toBe("STALE");
  });
  it("reports newly created monitors without data, then stale when collection never runs", () => {
    expect(
      monitorState(
        { ...monitor, lastCheckAt: null, createdAt: now },
        null,
        now,
      ),
    ).toBe("NO_DATA");
    expect(monitorState({ ...monitor, lastCheckAt: null }, null, now)).toBe(
      "STALE",
    );
  });
  it("requires two failures and distinguishes slow success", () => {
    expect(
      monitorState(
        { ...monitor, consecutiveFails: 1 },
        { ...success, success: false },
        now,
      ),
    ).toBe("PENDING");
    expect(
      monitorState(
        { ...monitor, consecutiveFails: 2 },
        { ...success, success: false },
        now,
      ),
    ).toBe("DOWN");
    expect(
      monitorState(monitor, { ...success, responseTimeMs: 1001 }, now),
    ).toBe("SLOW");
  });
  it("keeps demo fixtures synthetic and exposes representative states", () => {
    const data = demoData("24h", now);
    expect(data.items.map((item) => item.state)).toEqual([
      "UP",
      "UP",
      "SLOW",
      "DOWN",
      "PAUSED",
      "STALE",
    ]);
    expect(
      data.items.every((item) =>
        new URL(item.url).hostname.endsWith("example.com"),
      ),
    ).toBe(true);
  });
});
describe("authentication primitives", () => {
  it("uses random salts and verifies correct passwords without retaining plaintext", async () => {
    const password = "a-long-enough-test-password";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword("wrong", first)).toBe(false);
    expect(await verifyPassword(password, "malformed")).toBe(false);
  });
  it("stores only a secret-bound session digest", () => {
    expect(sessionHash("token", "secret")).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionHash("token", "secret")).not.toBe(
      sessionHash("token", "different"),
    );
  });
});
