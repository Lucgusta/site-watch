import type { Check, Incident, Monitor } from "@prisma/client";
import {
  monitorView,
  checkView,
  incidentView,
  PERIOD_MS,
  type Period,
} from "./domain.js";

// Every value is synthetic. No DNS requests, checks, writes or emails occur here.
export function demoData(period: Period = "24h", now = new Date()) {
  const labels = [
    "Marketing website",
    "Customer portal",
    "Documentation",
    "Online store",
    "Status page",
    "Partner API",
  ];
  const hosts = [
    "www.example.com",
    "portal.example.com",
    "docs.example.com",
    "shop.example.com",
    "status.example.com",
    "api.example.com",
  ];
  const monitorRows: Monitor[] = [];
  const allChecks: Check[] = [];
  const allIncidents: Incident[] = [];
  for (let index = 0; index < labels.length; index++) {
    const id = `demo-${index + 1}`;
    const paused = index === 4;
    const age = index === 5 ? 960_000 : 45_000;
    const createdAt = new Date(now.getTime() - 60 * 86_400_000);
    const monitor: Monitor = {
      id,
      name: labels[index]!,
      url: `https://${hosts[index]}/`,
      intervalSeconds: 300,
      timeoutMs: 10000,
      slowThresholdMs: 2000,
      notificationEmail: index === 3 ? "alerts@example.com" : null,
      paused,
      createdAt,
      updatedAt: createdAt,
      targetChangedAt: createdAt,
      nextCheckAt: new Date(now.getTime() + 255_000),
      consecutiveFails: index === 3 ? 3 : 0,
      firstFailureAt: index === 3 ? new Date(now.getTime() - 645_000) : null,
      lastCheckAt: new Date(now.getTime() - age),
      lastManualAt: null,
      leaseToken: null,
      leaseUntil: null,
    };
    const count = Math.floor(PERIOD_MS[period] / 300000);
    const sampleSpacing = 300000;
    for (let sample = 0; sample < count; sample++) {
      const failure = index === 3 && sample < 3;
      const ms =
        index === 2
          ? 2420 + ((sample * 19) % 440)
          : 160 + (((index + 1) * sample * 31) % 290);
      allChecks.push({
        id: `${id}-check-${sample}`,
        monitorId: id,
        checkedAt: new Date(now.getTime() - age - sample * sampleSpacing),
        source: "AUTOMATIC",
        success: !failure,
        httpStatus: failure ? 503 : 200,
        responseTimeMs: ms,
        elapsedMs: ms,
        errorCategory: failure ? "HTTP_STATUS" : null,
        errorMessage: failure ? "HTTP 503 Service Unavailable" : null,
      });
    }
    if (index === 3)
      allIncidents.push({
        id: "demo-incident-1",
        monitorId: id,
        firstFailureAt: new Date(now.getTime() - 645000),
        confirmedAt: new Date(now.getTime() - 345000),
        recoveredAt: null,
        errorCategory: "HTTP_STATUS",
      });
    monitorRows.push(monitor);
  }
  const items = monitorRows.map((monitor) => {
    const checks = allChecks.filter((check) => check.monitorId === monitor.id);
    return monitorView(
      monitor,
      checks,
      checks[0] ?? null,
      allIncidents.find(
        (incident) =>
          incident.monitorId === monitor.id && !incident.recoveredAt,
      ) ?? null,
      now,
    );
  });
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
    worker: { lastSeenAt: now, stale: false },
    notifications: { configured: false },
    checks: allChecks,
    incidents: allIncidents.map((incident) =>
      incidentView(
        incident,
        monitorRows.find((monitor) => monitor.id === incident.monitorId)?.name,
      ),
    ),
    checkView,
  };
}
