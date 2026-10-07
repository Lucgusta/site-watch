import type { Check, Incident, Monitor } from "@prisma/client";

export type Period = "24h" | "7d" | "30d";
export const PERIOD_MS: Record<Period, number> = {
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};
export type State =
  | "UP"
  | "SLOW"
  | "PENDING"
  | "DOWN"
  | "STALE"
  | "PAUSED"
  | "NO_DATA";
export interface Metrics {
  availability: number | null;
  averageMs: number | null;
  p95Ms: number | null;
  samples: number;
  successfulSamples: number;
}
export function computeMetrics(
  checks: Pick<Check, "success" | "responseTimeMs" | "errorCategory">[],
): Metrics {
  // Internal monitoring failures are observation gaps, not website downtime.
  const observed = checks.filter((check) => check.errorCategory !== "INTERNAL");
  const successful = observed.filter((check) => check.success);
  const times = successful
    .map((check) => check.responseTimeMs)
    .filter((time): time is number => time !== null)
    .sort((a, b) => a - b);
  return {
    availability: observed.length
      ? (successful.length / observed.length) * 100
      : null,
    averageMs: times.length
      ? Math.round(
          times.reduce((total, time) => total + time, 0) / times.length,
        )
      : null,
    p95Ms: times.length
      ? times[Math.max(0, Math.ceil(times.length * 0.95) - 1)]!
      : null,
    samples: observed.length,
    successfulSamples: successful.length,
  };
}
export function monitorState(
  monitor: Pick<
    Monitor,
    | "paused"
    | "lastCheckAt"
    | "createdAt"
    | "intervalSeconds"
    | "timeoutMs"
    | "consecutiveFails"
    | "slowThresholdMs"
  >,
  check: Pick<Check, "success" | "responseTimeMs" | "errorCategory"> | null,
  now = new Date(),
): State {
  if (monitor.paused) return "PAUSED";
  if (
    now.getTime() - (monitor.lastCheckAt ?? monitor.createdAt).getTime() >
      monitor.intervalSeconds * 2000 + monitor.timeoutMs ||
    check?.errorCategory === "INTERNAL"
  )
    return "STALE";
  if (!monitor.lastCheckAt || !check) return "NO_DATA";
  if (monitor.consecutiveFails >= 2) return "DOWN";
  if (monitor.consecutiveFails === 1) return "PENDING";
  return check.success && (check.responseTimeMs ?? 0) > monitor.slowThresholdMs
    ? "SLOW"
    : "UP";
}
export function checkView(check: Check) {
  const {
    id,
    checkedAt,
    source,
    success,
    httpStatus,
    responseTimeMs,
    elapsedMs,
    errorCategory,
    errorMessage,
  } = check;
  return {
    id,
    checkedAt,
    source,
    success,
    httpStatus,
    responseTimeMs,
    elapsedMs,
    errorCategory,
    errorMessage,
  };
}
export function incidentView(
  incident: Incident & { monitor?: { name: string } },
  monitorName?: string,
) {
  const {
    id,
    monitorId,
    firstFailureAt,
    confirmedAt,
    recoveredAt,
    errorCategory,
  } = incident;
  return {
    id,
    monitorId,
    monitorName: monitorName ?? incident.monitor?.name ?? "",
    firstFailureAt,
    confirmedAt,
    recoveredAt,
    errorCategory,
  };
}
export function monitorView(
  monitor: Monitor,
  recentChecks: Check[],
  lastCheck: Check | null,
  openIncident: Incident | null,
  now = new Date(),
) {
  const {
    id,
    name,
    url,
    intervalSeconds,
    timeoutMs,
    slowThresholdMs,
    notificationEmail,
    paused,
    nextCheckAt,
    createdAt,
  } = monitor;
  return {
    id,
    name,
    url,
    intervalSeconds,
    timeoutMs,
    slowThresholdMs,
    notificationEmail,
    paused,
    nextCheckAt,
    createdAt,
    state: monitorState(
      { ...monitor, createdAt: monitor.targetChangedAt },
      lastCheck,
      now,
    ),
    lastCheck: lastCheck ? checkView(lastCheck) : null,
    metrics: computeMetrics(recentChecks),
    openIncident: openIncident ? incidentView(openIncident, name) : null,
  };
}
