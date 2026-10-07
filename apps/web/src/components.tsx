import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Monitor as MonitorIcon,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Monitor, MonitorState } from "./types";
import { STATE_LABELS } from "./types";

const stateIcons = {
  UP: CheckCircle2,
  SLOW: Clock3,
  PENDING: CircleDashed,
  DOWN: TriangleAlert,
  STALE: Clock3,
  PAUSED: Pause,
  NO_DATA: Activity,
};
export function Status({ state }: { state: MonitorState }) {
  const Icon = stateIcons[state] ?? Activity;
  return (
    <span className={`status status-${state.toLowerCase()}`}>
      <Icon size={13} strokeWidth={2.2} />
      {STATE_LABELS[state] ?? state}
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Activity size={28} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const focusable = () => [
      ...(element?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
      ) ?? []),
    ];
    (
      element?.querySelector<HTMLElement>("input:not(:disabled)") ??
      focusable()[0]
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCloseRef.current();
      if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = originalOverflow;
      previous?.focus();
    };
  }, [busy]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function formatDate(
  value: string | null | undefined,
  timezone: string,
  withDate = false,
): string {
  if (!value) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      ...(withDate ? ({ month: "short", day: "numeric" } as const) : {}),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return "Unknown";
  }
}
export function relativeTime(value: string | null | undefined): string {
  if (!value) return "No checks yet";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function formatMs(value: number | null | undefined) {
  return value == null
    ? "—"
    : `${Math.round(value).toLocaleString("en-US")} ms`;
}
export function formatPercent(value: number | null | undefined) {
  return value == null ? "—" : `${value.toFixed(2)}%`;
}

export function RowActions({
  monitor,
  demo,
  busy,
  onDetails,
  onEdit,
  onPause,
  onCheck,
  onDelete,
}: {
  monitor: Monitor;
  demo: boolean;
  busy: boolean;
  onDetails: () => void;
  onEdit: () => void;
  onPause: () => void;
  onCheck: () => void;
  onDelete: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  useEffect(() => {
    if (!position) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = () => {
      setPosition(null);
      trigger.current?.focus();
    };
    const outside = (event: MouseEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab") setPosition(null);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [
          ...(menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        items[
          (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
        ]?.focus();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", close);
    };
  }, [position]);
  function open() {
    if (position) {
      setPosition(null);
      return;
    }
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(12, rect.right - 170),
      top:
        rect.bottom + 200 < window.innerHeight
          ? rect.bottom + 4
          : Math.max(12, rect.top - 195),
    });
  }
  function choose(action: () => void) {
    setPosition(null);
    trigger.current?.focus();
    action();
  }
  return (
    <>
      <button
        ref={trigger}
        className="icon-button row-actions-trigger"
        aria-label={`Actions for ${monitor.name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={open}
      >
        <MoreHorizontal size={18} />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            className="floating-row-menu"
            role="menu"
            aria-label={`${monitor.name} actions`}
            style={position}
          >
            <button role="menuitem" onClick={() => choose(onDetails)}>
              <MonitorIcon size={14} />
              View details
            </button>
            <button
              role="menuitem"
              disabled={demo || busy}
              onClick={() => choose(onEdit)}
            >
              <Pencil size={14} />
              Edit monitor
            </button>
            <button
              role="menuitem"
              data-testid={`monitor-pause-${monitor.id}`}
              disabled={demo || busy}
              onClick={() => choose(onPause)}
            >
              {monitor.paused ? <Play size={14} /> : <Pause size={14} />}
              {monitor.paused ? "Resume monitor" : "Pause monitor"}
            </button>
            <button
              role="menuitem"
              disabled={demo || busy}
              onClick={() => choose(onCheck)}
            >
              <RefreshCw size={14} />
              Check now
            </button>
            <button
              role="menuitem"
              className="danger-action"
              disabled={demo || busy}
              onClick={() => choose(onDelete)}
            >
              <Trash2 size={14} />
              Delete monitor
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
