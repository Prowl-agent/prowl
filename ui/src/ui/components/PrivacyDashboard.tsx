import React, { useCallback, useEffect, useMemo, useState } from "react";

type PrivacyStatusLevel = "full" | "hybrid" | "cloud-heavy";
type Destination = "local" | "cloud" | "hybrid";

type PrivacyStats = {
  totalRequests: number;
  localRequests: number;
  cloudRequests: number;
  localPercent: number;
  daysFullyLocal: number;
  currentStreak: number;
  tokensProcessedLocally: number;
  tokensProcessedCloud: number;
  lastCloudRequest: string | null;
};

type RequestAuditEntry = {
  id: string;
  timestamp: string;
  taskType: "chat" | "code" | "agent" | "tool" | "unknown";
  promptPreview: string;
  destination: Destination;
  localModel?: string;
  cloudProvider?: string;
  cloudModel?: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  routingReason: string;
};

type PrivacyLogResponse = {
  entries?: RequestAuditEntry[];
};

const REFRESH_INTERVAL_MS = 30_000;
const CLOCK_INTERVAL_MS = 1_000;

const ZERO_STATS: PrivacyStats = {
  totalRequests: 0,
  localRequests: 0,
  cloudRequests: 0,
  localPercent: 0,
  daysFullyLocal: 0,
  currentStreak: 0,
  tokensProcessedLocally: 0,
  tokensProcessedCloud: 0,
  lastCloudRequest: null,
};

const STATUS_COPY: Record<
  PrivacyStatusLevel,
  {
    label: string;
    background: string;
    border: string;
    color: string;
    flowNote: string;
  }
> = {
  full: {
    label: "🟢 All Local",
    background: "#052e16",
    border: "#166534",
    color: "#10B981",
    flowNote: "Zero data transmitted externally",
  },
  hybrid: {
    label: "🟡 Hybrid",
    background: "#422006",
    border: "#92400e",
    color: "#f59e0b",
    flowNote: "Some requests routed to cloud - see log below",
  },
  "cloud-heavy": {
    label: "🔴 Cloud Heavy",
    background: "#450a0a",
    border: "#991b1b",
    color: "#ef4444",
    flowNote: "Most requests using cloud - enable local model",
  },
};

const DESTINATION_COPY: Record<
  Destination,
  {
    label: string;
    dot: string;
    color: string;
  }
> = {
  local: {
    label: "Local",
    dot: "#10B981",
    color: "#34d399",
  },
  cloud: {
    label: "Cloud",
    dot: "#f59e0b",
    color: "#fbbf24",
  },
  hybrid: {
    label: "Hybrid",
    dot: "#60a5fa",
    color: "#60a5fa",
  },
};

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toSafeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function normalizeStats(value: unknown): PrivacyStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ZERO_STATS;
  }

  const raw = value as Partial<PrivacyStats>;
  return {
    totalRequests: toSafeNumber(raw.totalRequests),
    localRequests: toSafeNumber(raw.localRequests),
    cloudRequests: toSafeNumber(raw.cloudRequests),
    localPercent: toSafeNumber(raw.localPercent),
    daysFullyLocal: toSafeNumber(raw.daysFullyLocal),
    currentStreak: toSafeNumber(raw.currentStreak),
    tokensProcessedLocally: toSafeNumber(raw.tokensProcessedLocally),
    tokensProcessedCloud: toSafeNumber(raw.tokensProcessedCloud),
    lastCloudRequest: normalizeIsoTimestamp(raw.lastCloudRequest),
  };
}

function isDestination(value: unknown): value is Destination {
  return value === "local" || value === "cloud" || value === "hybrid";
}

function normalizeEntry(value: unknown): RequestAuditEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<RequestAuditEntry>;
  const timestamp = normalizeIsoTimestamp(raw.timestamp);
  if (!timestamp || typeof raw.id !== "string" || !isDestination(raw.destination)) {
    return null;
  }

  return {
    id: raw.id,
    timestamp,
    taskType:
      raw.taskType === "chat" ||
      raw.taskType === "code" ||
      raw.taskType === "agent" ||
      raw.taskType === "tool" ||
      raw.taskType === "unknown"
        ? raw.taskType
        : "unknown",
    promptPreview: typeof raw.promptPreview === "string" ? raw.promptPreview : "",
    destination: raw.destination,
    localModel: typeof raw.localModel === "string" ? raw.localModel : undefined,
    cloudProvider: typeof raw.cloudProvider === "string" ? raw.cloudProvider : undefined,
    cloudModel: typeof raw.cloudModel === "string" ? raw.cloudModel : undefined,
    promptTokens: toSafeNumber(raw.promptTokens),
    completionTokens: toSafeNumber(raw.completionTokens),
    durationMs: toSafeNumber(raw.durationMs),
    routingReason: typeof raw.routingReason === "string" ? raw.routingReason : "",
  };
}

function normalizeEntries(payload: unknown): RequestAuditEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const response = payload as PrivacyLogResponse;
  if (!Array.isArray(response.entries)) {
    return [];
  }
  return response.entries.map((entry) => normalizeEntry(entry)).filter((entry) => entry !== null);
}

function getStatusLevel(stats: PrivacyStats): PrivacyStatusLevel {
  if (stats.totalRequests === 0 || stats.cloudRequests === 0 || stats.localPercent >= 100) {
    return "full";
  }
  if (stats.localPercent >= 70) {
    return "hybrid";
  }
  return "cloud-heavy";
}

function getPromptPreview(text: string): string {
  const compact = text.trim();
  if (compact.length === 0) {
    return "No prompt preview";
  }
  if (compact.length <= 45) {
    return compact;
  }
  return `${compact.slice(0, 45)}...`;
}

export function formatRelativeTime(isoTimestamp: string, nowMs?: number): string {
  const timestampMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestampMs)) {
    return "unknown";
  }
  const now = nowMs ?? Date.now();
  const diffMs = Math.max(0, now - timestampMs);
  const diffSeconds = Math.floor(diffMs / 1_000);
  if (diffSeconds < 60) {
    return "just now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return new Date(timestampMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatTokensK(tokens: number): string {
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}M`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(1)}K`;
  }
  return `${Math.round(safe)}`;
}

export interface PrivacyDashboardProps {
  className?: string;
  apiBase?: string;
}

export default function PrivacyDashboard({ className, apiBase = "" }: PrivacyDashboardProps) {
  const [stats, setStats] = useState<PrivacyStats>(ZERO_STATS);
  const [entries, setEntries] = useState<RequestAuditEntry[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number | null>(null);

  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const status = useMemo(() => getStatusLevel(stats), [stats]);

  const refreshData = useCallback(
    async (signal?: AbortSignal) => {
      const [statsResponse, privacyResponse, logResponse] = await Promise.all([
        fetch(`${base}/api/prowl/stats`, {
          method: "GET",
          signal,
        }),
        fetch(`${base}/api/prowl/privacy`, {
          method: "GET",
          signal,
        }),
        fetch(`${base}/api/privacy/log?limit=10`, {
          method: "GET",
          signal,
        }),
      ]);

      if (!statsResponse.ok || !privacyResponse.ok || !logResponse.ok) {
        throw new Error("Failed to fetch privacy data");
      }

      const [statsPayload, privacyPayload, logPayload] = await Promise.all([
        statsResponse.json(),
        privacyResponse.json(),
        logResponse.json(),
      ]);

      if (signal?.aborted) {
        return;
      }

      setStats({
        ...normalizeStats(statsPayload),
        daysFullyLocal: (privacyPayload as { privacyStreak?: number }).privacyStreak ?? 0,
        currentStreak: (privacyPayload as { privacyStreak?: number }).privacyStreak ?? 0,
      });
      setEntries(normalizeEntries(logPayload).slice(0, 10));
      setLastUpdatedAtMs(Date.now());
    },
    [base],
  );

  useEffect(() => {
    let disposed = false;
    let activeRequest: AbortController | null = null;

    const runRefresh = async () => {
      if (disposed) {
        return;
      }
      activeRequest?.abort();
      activeRequest = new AbortController();
      try {
        await refreshData(activeRequest.signal);
      } catch {
        if (!activeRequest.signal.aborted && !disposed) {
          setStats(ZERO_STATS);
          setEntries([]);
          setLastUpdatedAtMs(Date.now());
        }
      }
    };

    void runRefresh();
    const refreshTimer = window.setInterval(() => {
      void runRefresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      activeRequest?.abort();
      window.clearInterval(refreshTimer);
    };
  }, [refreshData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const onExportCsv = async () => {
    try {
      const response = await fetch(`${base}/api/privacy/export-csv`, {
        method: "GET",
      });
      if (!response.ok) {
        return;
      }
      const csvBlob = await response.blob();
      if (typeof URL.createObjectURL !== "function") {
        return;
      }
      const objectUrl = URL.createObjectURL(csvBlob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "prowl-privacy-audit.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Do nothing and keep UI responsive.
    }
  };

  const lastUpdatedLabel = (() => {
    if (lastUpdatedAtMs == null) {
      return "Last updated --";
    }
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - lastUpdatedAtMs) / 1_000));
    return `Last updated ${elapsedSeconds}s ago`;
  })();

  const rootClassName = className
    ? `privacy-dashboard-widget ${className}`
    : "privacy-dashboard-widget";
  const statusCopy = STATUS_COPY[status];
  const hasCloudUsage = stats.cloudRequests > 0;
  const lastCloudLabel = stats.lastCloudRequest
    ? `Last cloud: ${formatRelativeTime(stats.lastCloudRequest, nowMs)}`
    : "Never used cloud";
  const lastCloudColor = stats.lastCloudRequest ? "#f59e0b" : "#34d399";

  return (
    <section className={rootClassName} data-testid="privacy-dashboard-widget">
      <style>{`
        .privacy-dashboard-widget {
          width: 100%;
          background: #0f172a;
          border-radius: 1rem;
          padding: 32px;
          box-sizing: border-box;
          border: 1px solid rgba(148, 163, 184, 0.18);
        }
        .privacy-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .privacy-title {
          margin: 0;
          color: #ffffff;
          font-size: 20px;
          font-weight: 700;
          line-height: 1.2;
        }
        .privacy-status-pill {
          border-radius: 999px;
          padding: 8px 16px;
          font-size: 14px;
          font-weight: 700;
          border: 1px solid;
          white-space: nowrap;
        }
        .privacy-streak-banner {
          margin-top: 16px;
          border-radius: 0.75rem;
          padding: 20px;
          background: linear-gradient(120deg, #052e16 0%, #0f172a 80%);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }
        .privacy-streak-value {
          color: #ffffff;
          font-size: 48px;
          line-height: 1;
          font-weight: 700;
        }
        .privacy-streak-sub {
          color: #34d399;
          font-size: 14px;
          margin-top: 8px;
        }
        .privacy-streak-empty {
          color: #94a3b8;
          font-size: 20px;
          font-weight: 600;
        }
        .privacy-flow {
          margin-top: 18px;
        }
        .privacy-section-label {
          color: #94a3b8;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 700;
        }
        .privacy-flow-row {
          margin-top: 10px;
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .privacy-flow-box {
          border-radius: 0.5rem;
          width: 80px;
          height: 40px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
        }
        .privacy-flow-box-default {
          background: #334155;
          color: #ffffff;
        }
        .privacy-flow-box-local {
          background: #065f46;
          color: #a7f3d0;
          width: auto;
          min-width: 100px;
          padding: 0 12px;
        }
        .privacy-flow-box-cloud {
          background: #78350f;
          color: #fde68a;
          width: auto;
          min-width: 100px;
          padding: 0 12px;
        }
        .privacy-flow-arrow {
          color: #64748b;
          font-size: 15px;
          letter-spacing: 0.02em;
          font-weight: 600;
        }
        .privacy-flow-arrow-cloud {
          color: #f59e0b;
        }
        .privacy-flow-note {
          color: #64748b;
          font-size: 12px;
          margin-top: 8px;
        }
        .privacy-cloud-count {
          color: #fbbf24;
          font-size: 12px;
          margin-top: 8px;
        }
        .privacy-log {
          margin-top: 20px;
        }
        .privacy-log-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .privacy-export-btn {
          border: 0;
          border-radius: 0.25rem;
          background: #334155;
          color: #cbd5e1;
          font-size: 12px;
          padding: 4px 12px;
          cursor: pointer;
          transition: background 120ms ease-out;
        }
        .privacy-export-btn:hover {
          background: #475569;
        }
        .privacy-table {
          margin-top: 10px;
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        .privacy-table thead th {
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 11px;
          text-align: left;
          font-weight: 700;
          border-bottom: 1px solid #1e293b;
          padding: 8px 6px;
        }
        .privacy-table tbody td {
          padding: 10px 6px;
          vertical-align: middle;
        }
        .privacy-time {
          color: #94a3b8;
          font-size: 12px;
          white-space: nowrap;
        }
        .privacy-task {
          color: #ffffff;
          font-size: 13px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .privacy-destination {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
        }
        .privacy-destination-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
        }
        .privacy-tokens {
          color: #94a3b8;
          font-size: 12px;
          white-space: nowrap;
        }
        .privacy-empty {
          color: #64748b;
          font-size: 14px;
          text-align: center;
          padding: 16px 0 6px;
        }
        .privacy-stats-row {
          margin-top: 16px;
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
        }
        .privacy-stat-box {
          flex: 1;
          min-width: 180px;
          background: #1e293b;
          border-radius: 0.75rem;
          padding: 16px;
          box-sizing: border-box;
          text-align: center;
        }
        .privacy-stat-value {
          color: #ffffff;
          font-size: 22px;
          font-weight: 700;
        }
        .privacy-stat-label {
          color: #94a3b8;
          font-size: 12px;
          margin-top: 6px;
        }
        .privacy-updated {
          margin-top: 12px;
          color: #475569;
          font-size: 10px;
          text-align: right;
        }
        @media (max-width: 900px) {
          .privacy-header {
            flex-direction: column;
            align-items: flex-start;
          }
          .privacy-streak-banner {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>

      <div className="privacy-header">
        <h2 className="privacy-title">Privacy</h2>
        <div
          className="privacy-status-pill"
          data-testid="privacy-status-pill"
          style={{
            background: statusCopy.background,
            borderColor: statusCopy.border,
            color: statusCopy.color,
          }}
        >
          {statusCopy.label}
        </div>
      </div>

      <div className="privacy-streak-banner">
        <div>
          {stats.currentStreak === 0 ? (
            <div className="privacy-streak-empty">No active streak</div>
          ) : (
            <div className="privacy-streak-value" data-testid="privacy-streak-value">
              {stats.currentStreak >= 30 ? "🏆 " : ""}
              {stats.currentStreak}
            </div>
          )}
          <div className="privacy-streak-sub">days fully local</div>
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          width="40"
          height="40"
          style={{ color: "#10B981" }}
        >
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
        </svg>
      </div>

      <div className="privacy-flow">
        <div className="privacy-section-label">Data Flow</div>
        <div className="privacy-flow-row">
          <div className="privacy-flow-box privacy-flow-box-default">You</div>
          <span className="privacy-flow-arrow">──→</span>
          <div className="privacy-flow-box privacy-flow-box-default">Prowl</div>
          <span className="privacy-flow-arrow">──→</span>
          <div className="privacy-flow-box privacy-flow-box-local">Local Model</div>
        </div>
        <div className="privacy-flow-note">{statusCopy.flowNote}</div>
        {hasCloudUsage ? (
          <>
            <div className="privacy-flow-row">
              <div className="privacy-flow-box privacy-flow-box-default">You</div>
              <span className="privacy-flow-arrow">──→</span>
              <div className="privacy-flow-box privacy-flow-box-default">Prowl</div>
              <span className="privacy-flow-arrow privacy-flow-arrow-cloud">──→</span>
              <div className="privacy-flow-box privacy-flow-box-cloud">⚠️ Cloud API</div>
            </div>
            <div className="privacy-cloud-count">{stats.cloudRequests} requests</div>
          </>
        ) : null}
      </div>

      <div className="privacy-log">
        <div className="privacy-log-head">
          <div className="privacy-section-label">Recent Requests</div>
          <button type="button" className="privacy-export-btn" onClick={() => void onExportCsv()}>
            Export CSV
          </button>
        </div>
        <table className="privacy-table">
          <thead>
            <tr>
              <th style={{ width: "90px" }}>Time</th>
              <th>Task</th>
              <th style={{ width: "110px" }}>Destination</th>
              <th style={{ width: "90px" }}>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="privacy-empty">No requests recorded yet</div>
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const totalTokens = entry.promptTokens + entry.completionTokens;
                const destination = DESTINATION_COPY[entry.destination];
                return (
                  <tr key={entry.id} data-testid="privacy-request-row">
                    <td className="privacy-time">{formatRelativeTime(entry.timestamp, nowMs)}</td>
                    <td className="privacy-task" title={entry.promptPreview}>
                      {getPromptPreview(entry.promptPreview)}
                    </td>
                    <td>
                      <span
                        className="privacy-destination"
                        style={{ color: destination.color }}
                        data-testid={`destination-${entry.destination}`}
                      >
                        <span
                          className="privacy-destination-dot"
                          style={{ background: destination.dot }}
                        />
                        {destination.label}
                      </span>
                    </td>
                    <td className="privacy-tokens">{totalTokens}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="privacy-stats-row">
        <div className="privacy-stat-box">
          <div className="privacy-stat-value">{stats.localRequests}</div>
          <div className="privacy-stat-label">local requests</div>
        </div>
        <div className="privacy-stat-box">
          <div className="privacy-stat-value">
            {formatTokensK(stats.tokensProcessedLocally)} tokens
          </div>
          <div className="privacy-stat-label">processed locally</div>
        </div>
        <div className="privacy-stat-box">
          <div className="privacy-stat-value" style={{ color: lastCloudColor }}>
            {lastCloudLabel}
          </div>
          <div className="privacy-stat-label">cloud destination</div>
        </div>
      </div>

      <div className="privacy-updated">{lastUpdatedLabel}</div>
    </section>
  );
}
