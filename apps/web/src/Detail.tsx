import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Bell,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { api } from "./api";
import {
  Empty,
  formatDate,
  formatMs,
  formatPercent,
  Modal,
  Status,
} from "./components";
import type { Monitor, MonitorDetail, Period } from "./types";

export default function Detail({
  monitor,
  demo,
  period,
  timezone,
  onClose,
  onEdit,
  onToggle,
  onCheck,
  busy,
}: {
  monitor: Monitor;
  demo: boolean;
  period: Period;
  timezone: string;
  onClose: () => void;
  onEdit: (monitor: Monitor) => void;
  onToggle: (monitor: Monitor) => void;
  onCheck: (monitor: Monitor) => void;
  busy: boolean;
}) {
  const [detail, setDetail] = useState<MonitorDetail | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<MonitorDetail>(
        `${demo ? "/demo" : ""}/monitors/${monitor.id}?period=${period}`,
      )
        .then((value) => {
          if (active) {
            setDetail(value);
            setError("");
          }
        })
        .catch((err) => {
          if (active) setError((err as Error).message);
        });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [demo, monitor.id, period, version, monitor.lastCheck?.id]);
  const points = useMemo(() => {
    if (!detail) return [];
    return [
      ...(detail.chart
        ? detail.chart.map((bucket) => ({
            time: new Date(bucket.checkedAt).getTime(),
            response: bucket.responseTimeMs,
          }))
        : detail.checks.map((check) => ({
            time: new Date(check.checkedAt).getTime(),
            response: check.success ? check.responseTimeMs : null,
          }))),
      ...detail.gaps.flatMap((gap) => [
        { time: new Date(gap.startedAt).getTime(), response: null },
        { time: new Date(gap.endedAt).getTime(), response: null },
      ]),
    ].sort((a, b) => a.time - b.time);
  }, [detail]);
  const current = detail?.monitor ?? monitor;
  return (
    <Modal wide title={monitor.name} onClose={onClose}>
      <div className="detail-intro">
        <a href={monitor.url} target="_blank" rel="noreferrer">
          {monitor.url}
          <ExternalLink size={13} />
        </a>
        <Status state={current.state} />
      </div>
      <div className="detail-toolbar">
        <span>
          <Clock3 size={15} />
          Every{" "}
          {monitor.intervalSeconds < 60
            ? `${monitor.intervalSeconds}s`
            : `${monitor.intervalSeconds / 60} min`}{" "}
          · {monitor.timeoutMs / 1000}s timeout
        </span>
        <div>
          <button
            className="button small secondary"
            disabled={demo || busy}
            onClick={() => onCheck(monitor)}
          >
            <RefreshCw size={14} />
            Check now
          </button>
          <button
            className="button small secondary"
            disabled={demo || busy}
            onClick={() => onToggle(monitor)}
          >
            {monitor.paused ? <Play size={14} /> : <Pause size={14} />}
            {monitor.paused ? "Resume" : "Pause"}
          </button>
          <button
            className="button small secondary"
            disabled={demo || busy}
            onClick={() => onEdit(monitor)}
          >
            <Pencil size={14} />
            Edit
          </button>
        </div>
      </div>
      {demo && (
        <p className="notice-inline">
          These are synthetic observations. Demo monitors are read-only.
        </p>
      )}
      {error && (
        <div className="alert error" role="alert">
          <TriangleAlert size={18} />
          <span>{error}</span>
          <button
            className="text-button"
            onClick={() => setVersion((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!detail && !error ? (
        <div className="loading-panel">
          <LoaderCircle className="spin" size={24} />
          Loading observations…
        </div>
      ) : (
        detail && (
          <>
            <div className="detail-stats">
              <div>
                <span>Observed availability</span>
                <strong>
                  {formatPercent(detail.monitor.metrics.availability)}
                </strong>
              </div>
              <div>
                <span>Average response</span>
                <strong>{formatMs(detail.monitor.metrics.averageMs)}</strong>
              </div>
              <div>
                <span>95th percentile</span>
                <strong>{formatMs(detail.monitor.metrics.p95Ms)}</strong>
              </div>
              <div>
                <span>Recorded checks</span>
                <strong>
                  {detail.monitor.metrics.samples.toLocaleString("en-US")}
                </strong>
              </div>
            </div>
            <section className="detail-chart">
              <div className="section-heading">
                <div>
                  <h3>Response history</h3>
                  <p>
                    {detail.chart
                      ? "Average time to HTTP response headers"
                      : "Individual HTTP header response times"}{" "}
                    ·{" "}
                    {detail.chart && (
                      <>
                        {period === "24h"
                          ? "5-minute"
                          : period === "7d"
                            ? "30-minute"
                            : "2-hour"}{" "}
                        buckets ·{" "}
                      </>
                    )}
                    last{" "}
                    {period === "24h"
                      ? "24 hours"
                      : period === "7d"
                        ? "7 days"
                        : "30 days"}
                  </p>
                </div>
                <span className="legend-dot">Successful checks</span>
              </div>
              {points.some((point) => point.response != null) ? (
                <div
                  className="chart-wrap"
                  role="img"
                  aria-label="Response time history. Blank segments indicate failed checks or missing observations."
                >
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart
                      data={points}
                      margin={{ top: 16, right: 16, left: -5, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="detailResponse"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#34805d"
                            stopOpacity={0.22}
                          />
                          <stop
                            offset="100%"
                            stopColor="#34805d"
                            stopOpacity={0.01}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="3 4"
                        vertical={false}
                        stroke="#e7ebe7"
                      />
                      <XAxis
                        dataKey="time"
                        type="number"
                        scale="time"
                        domain={["dataMin", "dataMax"]}
                        tickFormatter={(value) =>
                          formatDate(
                            new Date(Number(value)).toISOString(),
                            timezone,
                            period !== "24h",
                          )
                        }
                        axisLine={false}
                        tickLine={false}
                        minTickGap={45}
                        tick={{ fontSize: 10, fill: "#718077" }}
                      />
                      <YAxis
                        tickFormatter={(value) => `${value} ms`}
                        axisLine={false}
                        tickLine={false}
                        width={65}
                        tick={{ fontSize: 10, fill: "#718077" }}
                      />
                      <Tooltip
                        labelFormatter={(value) =>
                          formatDate(
                            new Date(Number(value)).toISOString(),
                            timezone,
                            true,
                          )
                        }
                        formatter={(value) => [
                          formatMs(Number(value)),
                          "Response",
                        ]}
                        contentStyle={{
                          borderRadius: 10,
                          border: "1px solid #dfe5dc",
                          fontSize: 12,
                        }}
                      />
                      <ReferenceLine
                        ifOverflow="extendDomain"
                        y={monitor.slowThresholdMs}
                        stroke="#c0a663"
                        strokeDasharray="4 4"
                      />
                      {detail.gaps.map((gap, index) => (
                        <ReferenceArea
                          key={index}
                          x1={new Date(gap.startedAt).getTime()}
                          x2={new Date(gap.endedAt).getTime()}
                          fill="#c4cccf"
                          fillOpacity={0.2}
                        />
                      ))}
                      <Area
                        type="linear"
                        dataKey="response"
                        stroke="#34805d"
                        strokeWidth={2}
                        fill="url(#detailResponse)"
                        dot={{
                          r: 2.5,
                          fill: "#34805d",
                          stroke: "#fffefa",
                          strokeWidth: 1,
                        }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Empty
                  title={
                    detail.monitor.metrics.samples
                      ? "No successful responses yet"
                      : "No observations yet"
                  }
                >
                  Successful response measurements will appear here. Any
                  recorded checks are listed below.
                </Empty>
              )}
              <p className="chart-note">
                {detail.chart
                  ? "Each point averages successful checks in one bucket. Empty buckets remain blank."
                  : "Each point represents a recorded check. Failed checks remain blank."}{" "}
                Shaded regions show observation gaps. The dashed line marks the{" "}
                {formatMs(monitor.slowThresholdMs)} slow threshold.
              </p>
            </section>
            <div className="detail-section">
              <h3>
                Recent checks{" "}
                <span className="count">
                  {Math.min(detail.checks.length, 30)}
                </span>
              </h3>
              <div className="table-scroll">
                <table className="compact-table">
                  <thead>
                    <tr>
                      <th scope="col">Time ({timezone})</th>
                      <th scope="col">Result</th>
                      <th scope="col">HTTP</th>
                      <th scope="col">Response</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.checks]
                      .sort(
                        (a, b) =>
                          Date.parse(b.checkedAt) - Date.parse(a.checkedAt),
                      )
                      .slice(0, 30)
                      .map((check) => (
                        <tr key={check.id}>
                          <td>{formatDate(check.checkedAt, timezone, true)}</td>
                          <td>
                            <span
                              className={
                                check.success ? "text-success" : "text-danger"
                              }
                            >
                              {check.success
                                ? "Success"
                                : (check.errorCategory?.replaceAll("_", " ") ??
                                  "Failed")}
                            </span>
                            {check.errorMessage && (
                              <small className="check-error">
                                {check.errorMessage}
                              </small>
                            )}
                          </td>
                          <td>{check.httpStatus ?? "—"}</td>
                          <td>{formatMs(check.responseTimeMs)}</td>
                          <td>
                            {check.source === "MANUAL" ? "Manual" : "Scheduled"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!detail.checks.length && (
                <p className="quiet">No recorded checks in this period.</p>
              )}
            </div>
            <div className="detail-section">
              <h3>Incidents</h3>
              {detail.incidents.length ? (
                <div className="incident-timeline">
                  {detail.incidents.map((incident) => (
                    <div key={incident.id}>
                      <span
                        className={`incident-dot ${incident.recoveredAt ? "resolved" : ""}`}
                      />
                      <div>
                        <strong>
                          {incident.recoveredAt ? "Recovered" : "Active outage"}{" "}
                          ·{" "}
                          {incident.errorCategory
                            .replaceAll("_", " ")
                            .toLowerCase()}
                        </strong>
                        <p>
                          First failure{" "}
                          {formatDate(incident.firstFailureAt, timezone, true)}{" "}
                          · Confirmed{" "}
                          {formatDate(incident.confirmedAt, timezone, true)}
                          {incident.recoveredAt &&
                            ` · Recovered ${formatDate(incident.recoveredAt, timezone, true)}`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="quiet">No confirmed incidents in this period.</p>
              )}
            </div>
            <div className="detail-footer">
              <Bell size={16} />
              <span>
                {monitor.notificationEmail
                  ? `Alerts to ${monitor.notificationEmail}`
                  : "Email alerts are off for this monitor."}
              </span>
            </div>
            <p className="measurement-note">
              Availability reflects recorded observations, not an SLA. A missing
              check is not a successful check or a confirmed outage. Internal
              worker errors do not count as website failures. Checks are
              retained for {detail.retentionDays} days; incident history is
              preserved. This table shows up to 30 of the most recent 500
              checks.
            </p>
          </>
        )
      )}
    </Modal>
  );
}
