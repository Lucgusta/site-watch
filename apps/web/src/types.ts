export type MonitorState =
  | "UP"
  | "SLOW"
  | "PENDING"
  | "DOWN"
  | "STALE"
  | "PAUSED"
  | "NO_DATA";
export type Period = "24h" | "7d" | "30d";
export interface Session {
  authenticated: boolean;
  csrfToken?: string;
  username?: string;
}
export interface Check {
  id: string;
  checkedAt: string;
  source: "AUTOMATIC" | "MANUAL";
  success: boolean;
  httpStatus: number | null;
  responseTimeMs: number | null;
  elapsedMs: number;
  errorCategory: string | null;
  errorMessage: string | null;
}
export interface Incident {
  id: string;
  monitorId: string;
  monitorName: string;
  firstFailureAt: string;
  confirmedAt: string;
  recoveredAt: string | null;
  errorCategory: string;
}
export interface Monitor {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
  slowThresholdMs: number;
  notificationEmail: string | null;
  paused: boolean;
  state: MonitorState;
  lastCheck: Check | null;
  nextCheckAt: string | null;
  metrics: {
    availability: number | null;
    averageMs: number | null;
    p95Ms: number | null;
    samples: number;
    successfulSamples: number;
  };
  openIncident: Incident | null;
  createdAt: string;
}
export interface MonitorList {
  items: Monitor[];
  total: number;
  page: number;
  pageSize: number;
  worker: { lastSeenAt: string | null; stale: boolean };
  notifications: { configured: boolean };
}
export interface MonitorDetail {
  monitor: Monitor;
  checks: Check[];
  incidents: Incident[];
  chart?: {
    checkedAt: string;
    responseTimeMs: number | null;
    samples: number;
  }[];
  gaps: { startedAt: string; endedAt: string }[];
  retentionDays: number;
}
export interface IncidentList {
  items: Incident[];
  total: number;
  page: number;
  pageSize: number;
}
export const STATE_LABELS: Record<MonitorState, string> = {
  UP: "Operational",
  SLOW: "Slow",
  PENDING: "Confirming",
  DOWN: "Down",
  STALE: "Stale",
  PAUSED: "Paused",
  NO_DATA: "No data",
};
