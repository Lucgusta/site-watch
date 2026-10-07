import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Globe2,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  Mail,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Signal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "./api";
import {
  Empty,
  formatDate,
  formatMs,
  formatPercent,
  Modal,
  relativeTime,
  RowActions,
  Status,
} from "./components";
import { LoginDialog, MonitorForm } from "./forms";
import Detail from "./Detail";
import type {
  Incident,
  IncidentList,
  Monitor,
  MonitorList,
  Period,
  Session,
} from "./types";
import { STATE_LABELS } from "./types";

type View = "overview" | "monitors" | "incidents" | "guide";
const TIMEZONES = [
  "America/Sao_Paulo",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];
function readTimezone() {
  try {
    return localStorage.getItem("sitewatch.timezone") ?? "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}
function domain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
function duration(start: string, end: string | null) {
  const minutes = Math.max(
    0,
    Math.round(
      ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 60000,
    ),
  );
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default function App() {
  const [session, setSession] = useState<Session>({ authenticated: false });
  const [initializing, setInitializing] = useState(true);
  const [view, setView] = useState<View>("overview");
  const [period, setPeriod] = useState<Period>("24h");
  const [timezone, setTimezone] = useState(readTimezone);
  const [mobileNav, setMobileNav] = useState(false);
  const [data, setData] = useState<{
    key: string;
    list: MonitorList | null;
    incidents: Incident[];
    updatedAt: string | null;
  }>({ key: "", list: null, incidents: [], updatedAt: null });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [incidentError, setIncidentError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loginOpen, setLoginOpen] = useState(false);
  const [form, setForm] = useState<{ monitor?: Monitor } | null>(null);
  const [selected, setSelected] = useState<Monitor | null>(null);
  const [deleting, setDeleting] = useState<Monitor | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const generation = useRef(0);
  const demo = !session.authenticated;
  const prefix = demo ? "/demo" : "";
  const dataKey = `${prefix}:${period}`;
  const list = data.key === dataKey ? data.list : null;
  const incidents = data.key === dataKey ? data.incidents : [];
  const updatedAt = data.key === dataKey ? data.updatedAt : null;

  useEffect(() => {
    let active = true;
    api<Session>("/session")
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (initializing) return;
    const request = ++generation.current;
    setRefreshing(true);
    const results = await Promise.allSettled([
      api<MonitorList>(
        `${prefix}/monitors?period=${period}&page=1&pageSize=100`,
      ),
      api<IncidentList>(
        `${prefix}/incidents?period=${period}&page=1&pageSize=100`,
      ),
    ]);
    if (request !== generation.current) return;
    const key = `${prefix}:${period}`;
    const monitorResult = results[0];
    const incidentResult = results[1];
    setData((previous) => ({
      key,
      list:
        monitorResult.status === "fulfilled"
          ? monitorResult.value
          : previous.key === key
            ? previous.list
            : null,
      incidents:
        incidentResult.status === "fulfilled"
          ? incidentResult.value.items
          : previous.key === key
            ? previous.incidents
            : [],
      updatedAt:
        monitorResult.status === "fulfilled"
          ? new Date().toISOString()
          : previous.key === key
            ? previous.updatedAt
            : null,
    }));
    if (results[0].status === "fulfilled") {
      setError("");
    } else
      setError(
        results[0].reason.message ||
          "Unable to load monitors. Check the server connection.",
      );
    if (results[1].status === "fulfilled") {
      setIncidentError("");
    } else
      setIncidentError(
        results[1].reason.message || "Unable to load incidents.",
      );
    setRefreshing(false);
  }, [initializing, prefix, period]);
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    const first = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      invalidateRequests();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh, invalidateRequests]);
  useEffect(() => {
    try {
      localStorage.setItem("sitewatch.timezone", timezone);
    } catch {
      /* Timezone selection still works without local storage. */
    }
  }, [timezone]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function mutate(
    action: () => Promise<unknown>,
    success: string,
    onFailure?: (message: string) => void,
  ) {
    setBusy(true);
    try {
      await action();
      setToast(success);
      setError("");
      await refresh();
      return true;
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      onFailure?.(message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(monitor: Monitor) {
    const ok = await mutate(
      () =>
        api(`/monitors/${monitor.id}`, {
          method: "PATCH",
          csrf: session.csrfToken,
          body: { paused: !monitor.paused },
        }),
      monitor.paused ? `${monitor.name} resumed.` : `${monitor.name} paused.`,
    );
    if (ok) setSelected(null);
  }
  async function check(monitor: Monitor) {
    await mutate(
      () =>
        api(`/monitors/${monitor.id}/check`, {
          method: "POST",
          csrf: session.csrfToken,
        }),
      `A check for ${monitor.name} has been queued. Results appear after the worker runs.`,
    );
  }
  async function remove() {
    if (!deleting) return;
    setDeleteError("");
    const ok = await mutate(
      () =>
        api(`/monitors/${deleting.id}`, {
          method: "DELETE",
          csrf: session.csrfToken,
        }),
      `${deleting.name} deleted.`,
      setDeleteError,
    );
    if (ok) setDeleting(null);
  }
  async function logout() {
    const ok = await mutate(
      () => api("/logout", { method: "POST", csrf: session.csrfToken }),
      "You have signed out.",
    );
    if (ok) setSession({ authenticated: false });
  }
  function navigate(next: View) {
    setView(next);
    setMobileNav(false);
    setSearch("");
    setStatusFilter("ALL");
  }
  const monitors = useMemo(() => list?.items ?? [], [list]);
  const visible = useMemo(
    () =>
      monitors.filter(
        (monitor) =>
          (statusFilter === "ALL" || monitor.state === statusFilter) &&
          `${monitor.name} ${monitor.url}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [monitors, search, statusFilter],
  );
  const operational = monitors.filter(
    (monitor) => monitor.state === "UP" || monitor.state === "SLOW",
  ).length;
  const activeIncidents = monitors.filter(
    (monitor) => monitor.openIncident,
  ).length;
  const samples = monitors.reduce(
    (sum, monitor) => sum + monitor.metrics.samples,
    0,
  );
  const successful = monitors.reduce(
    (sum, monitor) => sum + monitor.metrics.successfulSamples,
    0,
  );
  const avgSamples = monitors
    .filter((monitor) => monitor.metrics.averageMs != null)
    .reduce((sum, monitor) => sum + monitor.metrics.successfulSamples, 0);
  const average = avgSamples
    ? monitors.reduce(
        (sum, monitor) =>
          sum +
          (monitor.metrics.averageMs ?? 0) * monitor.metrics.successfulSamples,
        0,
      ) / avgSamples
    : null;
  const availability = samples ? (successful / samples) * 100 : null;
  const chartData = monitors
    .filter((monitor) => monitor.metrics.averageMs != null)
    .slice(0, 8)
    .map((monitor) => ({
      name:
        monitor.name.length > 13
          ? monitor.name.slice(0, 12) + "…"
          : monitor.name,
      fullName: monitor.name,
      response: Math.round(monitor.metrics.averageMs!),
      slow: monitor.metrics.averageMs! > monitor.slowThresholdMs,
    }));
  const navItems: { key: View; label: string; icon: typeof Activity }[] = [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "monitors", label: "Monitors", icon: Globe2 },
    { key: "incidents", label: "Incidents", icon: Activity },
  ];
  const title =
    view === "overview"
      ? "Your sites, at a glance."
      : view === "monitors"
        ? "A home for every website."
        : view === "incidents"
          ? "Every incident, accounted for."
          : "Know what you’re measuring.";
  const subtitle =
    view === "overview"
      ? "Keep your websites in sight. Catch problems before they become surprises."
      : view === "monitors"
        ? "Manage your websites, check schedules, and optional email alerts."
        : view === "incidents"
          ? "Follow confirmed outages from the first failure to recovery."
          : "A little context makes your monitoring data much more useful.";

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="Site Watch overview"
        >
          <span className="brand-symbol">
            <Activity size={25} strokeWidth={2.2} />
          </span>
          <span>
            site<span className="brand-light">watch</span>
            <span className="brand-period">.</span>
          </span>
        </button>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            <Globe2 size={17} />
          </span>
          <div>
            <strong>{demo ? "Demo workspace" : "My workspace"}</strong>
            <span>
              {demo
                ? "Explore Site Watch"
                : (session.username ?? "Administrator")}
            </span>
          </div>
          <span className={`workspace-badge ${demo ? "" : "real"}`}>
            {demo ? "DEMO" : "LIVE"}
          </span>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navItems.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={`nav-item ${view === key ? "active" : ""}`}
              onClick={() => navigate(key)}
              aria-current={view === key ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              {key === "incidents" && activeIncidents > 0 && (
                <span className="nav-count">{activeIncidents}</span>
              )}
              {key === "monitors" && (
                <span className="nav-number">{list?.total ?? "—"}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === "guide" ? "active" : ""}`}
            onClick={() => navigate("guide")}
            aria-current={view === "guide" ? "page" : undefined}
          >
            <BookOpen size={18} />
            <span>Guide & settings</span>
          </button>
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <Signal size={18} />
            </span>
            <strong>Stay a step ahead.</strong>
            <p>One place to see how all your websites are doing.</p>
            <button onClick={() => navigate("guide")}>
              How monitoring works <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="sidebar-footer">
            <span>
              <span
                className={`connection-dot ${!demo && list?.worker.stale ? "warning" : ""}`}
              />
              {demo
                ? "Synthetic demo data"
                : list?.worker.stale
                  ? "Worker needs attention"
                  : list
                    ? "Worker connected"
                    : "Connecting…"}
            </span>
            <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-home">Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {view === "guide"
                ? "Guide & settings"
                : view[0].toUpperCase() + view.slice(1)}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="topbar-date">
              {new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                month: "short",
                day: "numeric",
                year: "numeric",
              }).format(new Date())}
            </span>
            {demo ? (
              <button
                data-testid="login-button"
                className="button topbar-login"
                onClick={() => setLoginOpen(true)}
              >
                <LogIn size={15} />
                Sign in
              </button>
            ) : (
              <button
                className="button topbar-login"
                onClick={logout}
                disabled={busy}
              >
                <LogOut size={15} />
                Sign out
              </button>
            )}
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {demo && (
            <div className="demo-banner">
              <span className="demo-banner-icon">
                <CircleHelp size={18} />
              </span>
              <p>
                <strong>You’re exploring the demo.</strong> All websites and
                observations here are synthetic. This workspace is read-only.
              </p>
              <button onClick={() => setLoginOpen(true)}>
                Sign in to manage sites <ArrowRight size={15} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {demo ? "THE BIG PICTURE" : "YOUR MONITORING WORKSPACE"}
              </p>
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
            {view !== "guide" && (
              <button
                data-testid="add-monitor-button"
                className="button primary add-button"
                disabled={demo || busy || (list?.total ?? 0) >= 20}
                title={
                  demo
                    ? "Sign in to add a monitor"
                    : (list?.total ?? 0) >= 20
                      ? "This installation supports up to 20 monitors"
                      : undefined
                }
                onClick={() => setForm({})}
              >
                <Plus size={17} />
                Add monitor
              </button>
            )}
          </div>
          {error && (
            <div className="alert error" role="alert">
              <TriangleAlert size={19} />
              <div>
                <strong>We couldn’t complete the request.</strong>
                <p>
                  {error}
                  {updatedAt ? " Previously loaded data is shown below." : ""}
                </p>
              </div>
              <button
                className="button small secondary"
                onClick={refresh}
                disabled={refreshing}
              >
                Try again
              </button>
            </div>
          )}
          {!demo && list?.worker.stale && (
            <div className="alert warning" role="status">
              <Clock3 size={19} />
              <div>
                <strong>The monitoring worker is stale.</strong>
                <p>
                  Last heartbeat:{" "}
                  {list.worker.lastSeenAt
                    ? formatDate(list.worker.lastSeenAt, timezone, true)
                    : "none recorded"}
                  . Scheduled checks may be missing; review the worker service.
                </p>
              </div>
            </div>
          )}
          {view !== "guide" && (
            <div className="toolbar">
              <div
                className="period-tabs"
                role="group"
                aria-label="Observation period"
              >
                {(["24h", "7d", "30d"] as Period[]).map((value) => (
                  <button
                    key={value}
                    className={period === value ? "selected" : ""}
                    onClick={() => setPeriod(value)}
                    aria-pressed={period === value}
                  >
                    {value === "24h"
                      ? "Last 24 hours"
                      : value === "7d"
                        ? "7 days"
                        : "30 days"}
                  </button>
                ))}
              </div>
              <div className="toolbar-right">
                <label className="timezone-select">
                  <Globe2 size={14} />
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    aria-label="Display timezone"
                  >
                    {TIMEZONES.map((zone) => (
                      <option key={zone}>{zone}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
                <button
                  className="icon-button reload-button"
                  aria-label="Refresh monitoring data"
                  onClick={refresh}
                  disabled={refreshing || initializing}
                >
                  <RefreshCw size={16} className={refreshing ? "spin" : ""} />
                </button>
                <span className="updated-label">
                  {refreshing
                    ? "Updating…"
                    : updatedAt
                      ? `Updated ${relativeTime(updatedAt)}`
                      : "Waiting for data"}
                </span>
              </div>
            </div>
          )}
          {initializing || (!list && refreshing) ? (
            <div className="dashboard-loading" role="status">
              <LoaderCircle className="spin" size={24} />
              <p>Loading your monitoring workspace…</p>
            </div>
          ) : view === "guide" ? (
            <Guide
              timezone={timezone}
              setTimezone={setTimezone}
              smtp={list?.notifications.configured ?? false}
              demo={demo}
            />
          ) : (
            <>
              {view === "overview" && (
                <>
                  <div className="stat-grid">
                    <Stat
                      label="Total monitors"
                      value={list ? String(list.total).padStart(2, "0") : "—"}
                      icon={<Globe2 size={18} />}
                      note="All your websites in one place"
                    />
                    <Stat
                      label="Sites online"
                      value={list ? String(operational).padStart(2, "0") : "—"}
                      icon={<CheckCircle2 size={18} />}
                      note={`${monitors.filter((item) => item.state === "SLOW").length} slow · ${monitors.filter((item) => item.paused).length} paused`}
                      green
                    />
                    <Stat
                      label="Active incidents"
                      value={
                        list ? String(activeIncidents).padStart(2, "0") : "—"
                      }
                      icon={<Activity size={18} />}
                      note={
                        activeIncidents
                          ? "Confirmed outages need attention"
                          : "No confirmed outages right now"
                      }
                      warning={activeIncidents > 0}
                    />
                    <Stat
                      label="Average response"
                      value={
                        average == null ? "—" : String(Math.round(average))
                      }
                      unit={average == null ? "" : "ms"}
                      icon={<Clock3 size={18} />}
                      note="Time to HTTP response headers"
                    />
                  </div>
                  <div className="chart-grid">
                    <section className="panel response-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Response time</h2>
                          <p>
                            Average response by website in the selected period
                          </p>
                        </div>
                        <span className="subtle-tag">
                          <span className="tiny-dot" />
                          HTTP headers
                        </span>
                      </div>
                      {chartData.length ? (
                        <div
                          className="overview-chart"
                          role="img"
                          aria-label="Average HTTP response time per website"
                        >
                          <ResponsiveContainer width="100%" height={218}>
                            <BarChart
                              data={chartData}
                              margin={{
                                top: 20,
                                right: 12,
                                bottom: 0,
                                left: -6,
                              }}
                              barSize={30}
                            >
                              <CartesianGrid
                                vertical={false}
                                strokeDasharray="3 4"
                                stroke="#e6ebe3"
                              />
                              <XAxis
                                dataKey="name"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 10, fill: "#738078" }}
                                interval="preserveStartEnd"
                                minTickGap={14}
                              />
                              <YAxis
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(value) => `${value}`}
                                width={45}
                                tick={{ fontSize: 10, fill: "#738078" }}
                              />
                              <Tooltip
                                cursor={{ fill: "#f3f5ef" }}
                                labelFormatter={(_, payload) =>
                                  payload?.[0]?.payload?.fullName ?? ""
                                }
                                formatter={(value) => [
                                  formatMs(Number(value)),
                                  "Average response",
                                ]}
                                contentStyle={{
                                  borderRadius: 10,
                                  border: "1px solid #dde5db",
                                  fontSize: 12,
                                }}
                              />
                              <Bar
                                dataKey="response"
                                radius={[5, 5, 0, 0]}
                                isAnimationActive={false}
                              >
                                {chartData.map((item, index) => (
                                  <Cell
                                    key={index}
                                    fill={item.slow ? "#c4a366" : "#6c9b7e"}
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <Empty title="Waiting for the first check">
                          Recorded response times will appear here.
                        </Empty>
                      )}
                      <div className="chart-caption">
                        <span>Milliseconds (ms)</span>
                        <span>
                          {monitors.filter(
                            (item) => item.metrics.averageMs != null,
                          ).length > 8
                            ? "First 8 monitors · open a site for its history"
                            : "Open a monitor to explore its history"}
                          <ArrowUpRight size={12} />
                        </span>
                      </div>
                    </section>
                    <section className="panel health-panel">
                      <div className="section-heading">
                        <div>
                          <h2>Fleet health</h2>
                          <p>Based on recorded checks</p>
                        </div>
                        <span className="health-icon">
                          <ShieldCheck size={18} />
                        </span>
                      </div>
                      <div
                        className="health-ring"
                        style={
                          {
                            "--progress": `${availability == null ? 0 : availability * 3.6}deg`,
                          } as React.CSSProperties
                        }
                      >
                        <div>
                          <span>Observed availability</span>
                          <strong>
                            {availability == null
                              ? "—"
                              : availability.toFixed(2)}
                            <small>{availability == null ? "" : "%"}</small>
                          </strong>
                          <span>
                            {samples.toLocaleString("en-US")} observations
                          </span>
                        </div>
                      </div>
                      <div className="health-legend">
                        <span>
                          <i className="green-dot" />
                          Operational
                          <strong>
                            {
                              monitors.filter((item) => item.state === "UP")
                                .length
                            }
                          </strong>
                        </span>
                        <span>
                          <i className="amber-dot" />
                          Slow / confirming
                          <strong>
                            {
                              monitors.filter(
                                (item) =>
                                  item.state === "SLOW" ||
                                  item.state === "PENDING",
                              ).length
                            }
                          </strong>
                        </span>
                        <span>
                          <i className="red-dot" />
                          Down
                          <strong>
                            {
                              monitors.filter((item) => item.state === "DOWN")
                                .length
                            }
                          </strong>
                        </span>
                        <span>
                          <i className="gray-dot" />
                          Paused / no data / stale
                          <strong>
                            {
                              monitors.filter((item) =>
                                ["PAUSED", "NO_DATA", "STALE"].includes(
                                  item.state,
                                ),
                              ).length
                            }
                          </strong>
                        </span>
                      </div>
                    </section>
                  </div>
                </>
              )}
              {(view === "overview" || view === "monitors") && (
                <section className="panel monitor-panel">
                  <div className="monitor-heading">
                    <div>
                      <h2>
                        Your monitors{" "}
                        <span className="count">{list?.total ?? 0}</span>
                      </h2>
                      <p>
                        {view === "overview"
                          ? "A pulse check on the websites that matter to you."
                          : "Select a website to see observations, response history, and incidents."}
                      </p>
                    </div>
                    <div className="monitor-filters">
                      <label className="search-field">
                        <Search size={16} />
                        <input
                          aria-label="Search monitors"
                          placeholder="Search websites…"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </label>
                      <label className="status-filter">
                        <select
                          aria-label="Filter monitors by status"
                          value={statusFilter}
                          onChange={(e) => setStatusFilter(e.target.value)}
                        >
                          <option value="ALL">All statuses</option>
                          {Object.entries(STATE_LABELS).map(
                            ([state, label]) => (
                              <option key={state} value={state}>
                                {label}
                              </option>
                            ),
                          )}
                        </select>
                        <ChevronDown size={13} />
                      </label>
                    </div>
                  </div>
                  {visible.length ? (
                    <div className="table-scroll">
                      <table className="monitor-table">
                        <thead>
                          <tr>
                            <th scope="col">Website</th>
                            <th scope="col">Status</th>
                            <th scope="col">Availability</th>
                            <th scope="col">Avg. response</th>
                            <th scope="col">Last checked</th>
                            <th scope="col">Next check</th>
                            <th scope="col">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map((monitor, index) => (
                            <tr
                              key={monitor.id}
                              data-testid={`monitor-row-${monitor.id}`}
                            >
                              <td>
                                <button
                                  data-testid={`monitor-details-${monitor.id}`}
                                  className="website-cell"
                                  onClick={() => setSelected(monitor)}
                                >
                                  <span
                                    className={`website-avatar avatar-${index % 5}`}
                                  >
                                    {initials(monitor.name)}
                                  </span>
                                  <span>
                                    <strong>{monitor.name}</strong>
                                    <small>{domain(monitor.url)}</small>
                                  </span>
                                  <ArrowUpRight
                                    className="website-open-icon"
                                    size={13}
                                  />
                                </button>
                              </td>
                              <td>
                                <Status state={monitor.state} />
                              </td>
                              <td>
                                <div className="availability-cell">
                                  <strong>
                                    {formatPercent(
                                      monitor.metrics.availability,
                                    )}
                                  </strong>
                                  <span
                                    className="availability-track"
                                    aria-hidden="true"
                                  >
                                    <span
                                      style={{
                                        width: `${monitor.metrics.availability ?? 0}%`,
                                      }}
                                      className={
                                        monitor.metrics.availability != null &&
                                        monitor.metrics.availability < 98
                                          ? "impaired"
                                          : ""
                                      }
                                    />
                                  </span>
                                </div>
                              </td>
                              <td>
                                <span
                                  className={`response-value ${monitor.metrics.averageMs != null && monitor.metrics.averageMs > monitor.slowThresholdMs ? "slow" : ""}`}
                                >
                                  {formatMs(monitor.metrics.averageMs)}
                                </span>
                              </td>
                              <td>
                                <span
                                  className="check-time"
                                  title={
                                    monitor.lastCheck
                                      ? formatDate(
                                          monitor.lastCheck.checkedAt,
                                          timezone,
                                          true,
                                        )
                                      : undefined
                                  }
                                >
                                  {relativeTime(monitor.lastCheck?.checkedAt)}
                                </span>
                                <small className="table-subtext">
                                  {monitor.lastCheck
                                    ? `HTTP ${monitor.lastCheck.httpStatus ?? "—"}`
                                    : "Awaiting observation"}
                                </small>
                              </td>
                              <td>
                                <span className="check-time">
                                  {monitor.paused
                                    ? "Paused"
                                    : formatDate(
                                        monitor.nextCheckAt,
                                        timezone,
                                        true,
                                      )}
                                </span>
                                <small className="table-subtext">
                                  {monitor.paused
                                    ? "Resume to schedule"
                                    : `Every ${monitor.intervalSeconds / 60} min`}
                                </small>
                              </td>
                              <td>
                                <RowActions
                                  monitor={monitor}
                                  demo={demo}
                                  busy={busy}
                                  onDetails={() => setSelected(monitor)}
                                  onEdit={() => setForm({ monitor })}
                                  onPause={() => toggle(monitor)}
                                  onCheck={() => check(monitor)}
                                  onDelete={() => setDeleting(monitor)}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      title={
                        search || statusFilter !== "ALL"
                          ? "No matching websites"
                          : "Your first website starts here"
                      }
                      action={
                        !demo && !search && statusFilter === "ALL" ? (
                          <button
                            className="button primary"
                            onClick={() => setForm({})}
                          >
                            <Plus size={16} />
                            Add a monitor
                          </button>
                        ) : search || statusFilter !== "ALL" ? (
                          <button
                            className="button secondary"
                            onClick={() => {
                              setSearch("");
                              setStatusFilter("ALL");
                            }}
                          >
                            Clear filters
                          </button>
                        ) : undefined
                      }
                    >
                      {search || statusFilter !== "ALL"
                        ? "Try another name, domain, or status filter."
                        : "Add a public URL and Site Watch will start checking it for you."}
                    </Empty>
                  )}
                  <div className="table-footer">
                    <span>
                      Showing {visible.length} of {list?.total ?? 0} monitors
                    </span>
                    <span>
                      <RefreshCw size={12} />
                      Refreshes every 30 seconds
                    </span>
                  </div>
                </section>
              )}
              {view === "incidents" && (
                <section className="panel incidents-panel">
                  <div className="section-heading">
                    <div>
                      <h2>
                        Incident history{" "}
                        <span className="count">{incidents.length}</span>
                      </h2>
                      <p>
                        Two consecutive failures confirm an outage. A successful
                        check resolves it. Observation windows may include
                        collection gaps; they are not measured downtime.
                      </p>
                    </div>
                    <span className="subtle-tag">Selected period</span>
                  </div>
                  {incidentError && (
                    <div className="alert error" role="alert">
                      <TriangleAlert size={16} />
                      <span>{incidentError}</span>
                      <button className="text-button" onClick={refresh}>
                        Retry
                      </button>
                    </div>
                  )}
                  {incidents.length ? (
                    <div className="table-scroll">
                      <table className="compact-table incidents-table">
                        <thead>
                          <tr>
                            <th scope="col">Website</th>
                            <th scope="col">Incident</th>
                            <th scope="col">Confirmed</th>
                            <th scope="col">Recovered</th>
                            <th scope="col">Observation window</th>
                            <th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {incidents.map((incident) => (
                            <tr key={incident.id}>
                              <td>
                                <button
                                  className="incident-site"
                                  onClick={() => {
                                    const monitor = monitors.find(
                                      (item) => item.id === incident.monitorId,
                                    );
                                    if (monitor) setSelected(monitor);
                                  }}
                                  disabled={
                                    !monitors.some(
                                      (item) => item.id === incident.monitorId,
                                    )
                                  }
                                >
                                  {incident.monitorName}
                                  <ArrowUpRight size={12} />
                                </button>
                              </td>
                              <td>
                                {incident.errorCategory
                                  ?.replaceAll("_", " ")
                                  .toLowerCase() ?? "HTTP failure"}
                              </td>
                              <td>
                                {formatDate(
                                  incident.confirmedAt,
                                  timezone,
                                  true,
                                )}
                              </td>
                              <td>
                                {incident.recoveredAt
                                  ? formatDate(
                                      incident.recoveredAt,
                                      timezone,
                                      true,
                                    )
                                  : "Awaiting recovery"}
                              </td>
                              <td>
                                {duration(
                                  incident.firstFailureAt,
                                  incident.recoveredAt,
                                )}
                              </td>
                              <td>
                                <span
                                  className={`status ${incident.recoveredAt ? "status-up" : "status-down"}`}
                                >
                                  {incident.recoveredAt ? (
                                    <CheckCircle2 size={13} />
                                  ) : (
                                    <Activity size={13} />
                                  )}
                                  {incident.recoveredAt ? "Resolved" : "Active"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    !incidentError && (
                      <Empty title="A quiet incident log">
                        No confirmed incidents were recorded in the selected
                        period.
                      </Empty>
                    )
                  )}
                  <div className="table-footer">
                    <span>Times shown in {timezone}</span>
                    <span>
                      Checks retained 30 days · incident history preserved
                    </span>
                  </div>
                </section>
              )}
              {view === "overview" && (
                <div className="observation-note">
                  <ShieldCheck size={16} />
                  <span>
                    Availability is based on recorded observations, not an SLA.
                    Missing checks are shown as gaps.
                  </span>
                  <button onClick={() => navigate("guide")}>
                    Learn more <ArrowUpRight size={12} />
                  </button>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              Made for people with more than one website to look after.
            </span>
            <span>
              <Activity size={13} />
              Site Watch · Open source
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {loginOpen && (
        <LoginDialog
          onClose={() => setLoginOpen(false)}
          onLogin={(value) => {
            setSession(value);
            setLoginOpen(false);
            setToast("Welcome back. Your workspace is ready.");
          }}
        />
      )}
      {form && (
        <MonitorForm
          monitor={form.monitor}
          csrf={session.csrfToken}
          smtp={list?.notifications.configured ?? false}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setToast(
              form.monitor
                ? "Monitor updated."
                : "Monitor added. The first check will appear after the worker runs.",
            );
            refresh();
          }}
        />
      )}
      {selected && (
        <Detail
          monitor={monitors.find((item) => item.id === selected.id) ?? selected}
          demo={demo}
          period={period}
          timezone={timezone}
          onClose={() => setSelected(null)}
          onEdit={(monitor) => {
            setSelected(null);
            setForm({ monitor });
          }}
          onToggle={toggle}
          onCheck={check}
          busy={busy}
        />
      )}
      {deleting && (
        <Modal
          title="Delete this monitor?"
          onClose={() => {
            setDeleting(null);
            setDeleteError("");
          }}
          busy={busy}
        >
          <p className="modal-description">
            Delete <strong>{deleting.name}</strong> and its recorded checks and
            incidents. This cannot be undone.
          </p>
          <div className="delete-target">
            <Globe2 size={18} />
            <span>{deleting.url}</span>
          </div>
          {deleteError && (
            <div className="form-error" role="alert">
              {deleteError}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => {
                setDeleting(null);
                setDeleteError("");
              }}
              disabled={busy}
            >
              Keep monitor
            </button>
            <button className="button danger" onClick={remove} disabled={busy}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Trash2 size={16} />
              )}
              Delete monitor
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  icon,
  note,
  green,
  warning,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  note: string;
  green?: boolean;
  warning?: boolean;
}) {
  return (
    <section className="stat-card">
      <div className="stat-label">
        <span>{label}</span>
        <span
          className={`stat-icon ${green ? "green" : warning ? "amber" : ""}`}
        >
          {icon}
        </span>
      </div>
      <div
        className={`stat-value ${green ? "text-success" : warning ? "text-amber" : ""}`}
      >
        {value}
        <span>{unit}</span>
      </div>
      <p>
        {green ? (
          <ArrowUpRight size={13} />
        ) : warning ? (
          <ArrowDownRight size={13} />
        ) : (
          <span className="stat-note-dot" />
        )}
        {note}
      </p>
    </section>
  );
}

function Guide({
  timezone,
  setTimezone,
  smtp,
  demo,
}: {
  timezone: string;
  setTimezone: (value: string) => void;
  smtp: boolean;
  demo: boolean;
}) {
  return (
    <div className="guide-grid">
      <section className="panel guide-card">
        <span className="guide-icon">
          <Activity size={22} />
        </span>
        <h2>Checks that mean something</h2>
        <p>
          Site Watch sends a lightweight request to each public website. Final
          responses from HTTP 200 through 299 count as successful. A successful
          response above your configured threshold is marked slow.
        </p>
        <p>
          Response time measures how long the site takes to return HTTP headers.
          It does not measure page rendering, browser performance, or the time
          to download a complete page.
        </p>
        <div className="guide-callout">
          <strong>One failure starts a confirmation.</strong>
          <p>
            Two consecutive website failures create an incident. A successful
            check closes the incident. Worker or scheduler errors are shown
            separately.
          </p>
        </div>
      </section>
      <section className="panel guide-card">
        <span className="guide-icon">
          <ShieldCheck size={22} />
        </span>
        <h2>Observations, with context</h2>
        <p>
          Availability is the share of recorded checks that succeeded within the
          selected period. It is an observation of your website from this
          installation, rather than an SLA or an independent global measurement.
        </p>
        <p>
          Missing scheduled checks stay visible as gaps. A stale worker, a
          paused monitor, or an internal error should never be mistaken for a
          healthy website.
        </p>
        <div className="guide-callout">
          <strong>A useful history, kept lean.</strong>
          <p>
            Checks are retained for 30 days; incident history is preserved. The
            24-hour, 7-day, and 30-day selectors use recorded observations.
          </p>
        </div>
      </section>
      <section className="panel guide-card">
        <span className="guide-icon">
          <Bell size={22} />
        </span>
        <h2>Email, when you want it</h2>
        <p>
          Every monitor has an optional notification email. Set an address to
          receive a message when an outage is confirmed and another when the
          website recovers. Leave it blank to monitor without email.
        </p>
        <div className={`smtp-state ${smtp ? "configured" : ""}`}>
          <Mail size={18} />
          <div>
            <strong>
              {smtp ? "SMTP is configured" : "SMTP is not configured"}
            </strong>
            <p>
              {demo
                ? "This preview never sends emails. Sign in to view your installation’s configuration."
                : smtp
                  ? "Monitors with an email address can send incident notifications."
                  : "An administrator must set SMTP environment variables before email delivery is available. Addresses can still be saved."}
            </p>
          </div>
        </div>
        <p className="quiet">
          Notifications are sent by this self-hosted installation. Email
          delivery depends on your SMTP provider.
        </p>
      </section>
      <section className="panel guide-card">
        <span className="guide-icon">
          <Globe2 size={22} />
        </span>
        <h2>Your display preferences</h2>
        <label className="field">
          Display timezone
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone}>{zone}</option>
            ))}
          </select>
          <small>
            Dates use this timezone. Your choice is saved in this browser.
            Checks run independently of display timezone.
          </small>
        </label>
        <div className="guide-callout">
          <strong>Public code. Private monitoring.</strong>
          <p>
            The read-only demo is available without an account. Your actual
            monitors and management actions require the administrator session.
          </p>
        </div>
        <div className="guide-links">
          <span>
            <ExternalLink size={14} />
            Setup and configuration are documented in the repository README.
          </span>
        </div>
      </section>
    </div>
  );
}
