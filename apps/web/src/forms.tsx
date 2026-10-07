import { useState, type FormEvent } from "react";
import {
  Bell,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { Modal } from "./components";
import type { Monitor, Session } from "./types";
import { api, login } from "./api";

export function LoginDialog({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (session: Session) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Sign in to your workspace" onClose={onClose} busy={busy}>
      <p className="modal-description">
        Use the administrator account configured for this installation to manage
        your monitors.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          Username
          <input
            data-testid="login-username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            maxLength={100}
          />
        </label>
        <label className="field">
          Password
          <input
            data-testid="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="login-note">
          <ShieldCheck size={17} />
          <span>Your monitoring data stays on this installation.</span>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            data-testid="login-submit"
            className="button primary"
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <LockKeyhole size={16} />
            )}
            Sign in
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MonitorForm({
  monitor,
  csrf,
  smtp,
  onClose,
  onSaved,
}: {
  monitor?: Monitor;
  csrf?: string;
  smtp: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(monitor?.name ?? "");
  const [url, setUrl] = useState(monitor?.url ?? "");
  const [interval, setInterval] = useState(monitor?.intervalSeconds ?? 300);
  const [timeout, setTimeoutValue] = useState(
    (monitor?.timeoutMs ?? 10000) / 1000,
  );
  const [slow, setSlow] = useState(monitor?.slowThresholdMs ?? 1500);
  const [email, setEmail] = useState(monitor?.notificationEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(monitor ? `/monitors/${monitor.id}` : "/monitors", {
        method: monitor ? "PATCH" : "POST",
        csrf,
        body: {
          name: name.trim(),
          url: url.trim(),
          intervalSeconds: interval,
          timeoutMs: Math.round(timeout * 1000),
          slowThresholdMs: slow,
          notificationEmail: email.trim() || null,
        },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={monitor ? "Edit monitor" : "Add a website"}
      onClose={onClose}
      busy={busy}
    >
      <p className="modal-description">
        Keep an eye on a public website. Site Watch checks HTTP response headers
        at your chosen interval.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          Website name
          <input
            data-testid="monitor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My main website"
            required
            maxLength={100}
          />
        </label>
        <label className="field">
          Website URL
          <input
            data-testid="monitor-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            required
            maxLength={2048}
          />
          <small>Use a publicly reachable HTTP or HTTPS address.</small>
        </label>
        <div className="form-grid">
          <label className="field">
            Check interval
            <select
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            >
              <option value={60}>Every minute</option>
              <option value={300}>Every 5 minutes</option>
              <option value={900}>Every 15 minutes</option>
            </select>
          </label>
          <label className="field">
            Timeout (seconds)
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeoutValue(Number(e.target.value))}
              min={1}
              max={30}
              step={1}
              required
            />
          </label>
        </div>
        <label className="field">
          Slow response threshold (ms)
          <input
            type="number"
            value={slow}
            onChange={(e) => setSlow(Number(e.target.value))}
            min={100}
            max={30000}
            step={100}
            required
          />
          <small>
            A successful response above this threshold is marked slow.
          </small>
        </label>
        <div className="notification-form">
          <div className="notification-heading">
            <Bell size={17} />
            <strong>Email notifications</strong>
            <span className="optional">Optional</span>
          </div>
          <label className="field">
            Notification email
            <div className="input-icon">
              <Mail size={17} />
              <input
                data-testid="monitor-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                maxLength={254}
              />
            </div>
            <small>
              Receive an alert when an outage is confirmed and when the site
              recovers. Leave blank to monitor without email.
            </small>
          </label>
          {!smtp && (
            <p className="notice-inline">
              Email delivery is not configured. You can save an address now; an
              administrator must configure SMTP before alerts can be sent.
            </p>
          )}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            data-testid="monitor-save"
            className="button primary"
            disabled={busy}
          >
            {busy && <LoaderCircle className="spin" size={16} />}
            {monitor ? "Save changes" : "Add monitor"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
