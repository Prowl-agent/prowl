import React, { useEffect, useMemo, useRef, useState } from "react";

type SavingsPeriod = "day" | "month" | "all-time";
type SavingsTab = "Today" | "This Month" | "All Time";

const ANIMATION_DURATION_MS = 1_200;

const PERIOD_BY_TAB: Record<SavingsTab, SavingsPeriod> = {
  Today: "day",
  "This Month": "month",
  "All Time": "all-time",
};

const TABS: SavingsTab[] = ["Today", "This Month", "All Time"];

type CloudEquivalent = {
  provider: string;
  model: string;
  estimatedCostUSD: number;
  savingsUSD: number;
};

type SavingsReport = {
  period: string;
  totalInferences: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  localCostUSD: number;
  cloudEquivalents: CloudEquivalent[];
  bestSavingsUSD: number;
  bestSavingsProvider: string;
  avgTokensPerSecond: number;
  totalDurationMs: number;
};

export interface CostSavingsProps {
  className?: string;
  apiBase?: string;
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function formatMoney(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(2)}`;
}

function compact(value: number): string {
  const roundedToTenth = Math.round(value * 10) / 10;
  return Number.isInteger(roundedToTenth) ? roundedToTenth.toFixed(0) : roundedToTenth.toFixed(1);
}

export function formatTokens(tokens: number): string {
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (safe >= 1_000_000) {
    return `${compact(safe / 1_000_000)}M`;
  }
  if (safe >= 1_000) {
    return `${compact(safe / 1_000)}K`;
  }
  return `${Math.round(safe)}`;
}

function toCloudLabel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt-4o")) {
    return "GPT-4o";
  }
  if (normalized.includes("claude") && normalized.includes("sonnet")) {
    return "Claude Sonnet";
  }
  if (normalized.includes("gemini")) {
    return "Gemini";
  }
  return model
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export default function CostSavings({ className, apiBase = "" }: CostSavingsProps) {
  const [activeTab, setActiveTab] = useState<SavingsTab>("Today");
  const [report, setReport] = useState<SavingsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayedSavings, setDisplayedSavings] = useState(0);
  const previousTargetRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);

  const clearAnimation = () => {
    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const animateTo = (nextValue: number) => {
    clearAnimation();
    const from = previousTargetRef.current;
    const to = Number.isFinite(nextValue) ? nextValue : 0;
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = Math.min(1, (now - start) / ANIMATION_DURATION_MS);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const value = from + (to - from) * eased;
      setDisplayedSavings(value);

      if (elapsed < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
        return;
      }

      previousTargetRef.current = to;
      setDisplayedSavings(to);
      animationFrameRef.current = null;
    };

    animationFrameRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const period = PERIOD_BY_TAB[activeTab];
    const base = normalizeApiBase(apiBase);
    const url = `${base}/api/prowl/savings?period=${period}`;
    let activeController: AbortController | null = null;

    const fetchData = async (isInitial = false) => {
      if (activeController) {
        activeController.abort();
      }
      activeController = new AbortController();

      if (isInitial) {
        setLoading(true);
      }
      setError(null);

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: activeController.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as { report: SavingsReport };
        if (activeController.signal.aborted) {
          return;
        }

        setReport(payload.report);
        setLoading(false);
        animateTo(payload.report.bestSavingsUSD);
      } catch {
        if (activeController.signal.aborted) {
          return;
        }
        setLoading(false);
        if (isInitial) {
          setReport(null);
          setError("Unable to load savings data");
        }
      }
    };

    void fetchData(true);
    const interval = setInterval(() => void fetchData(), 10000);

    return () => {
      if (activeController) {
        activeController.abort();
      }
      clearInterval(interval);
      clearAnimation();
    };
  }, [activeTab, apiBase]);

  useEffect(() => {
    return () => {
      clearAnimation();
    };
  }, []);

  const comparisons = useMemo(() => {
    if (!report?.cloudEquivalents?.length) {
      return ["vs GPT-4o", "vs Claude Sonnet"];
    }
    return report.cloudEquivalents.slice(0, 2).map((entry) => `vs ${toCloudLabel(entry.model)}`);
  }, [report]);

  const isEmpty = Boolean(report) && !loading && !error && report.totalInferences === 0;
  const requestsText = report
    ? `${report.totalInferences.toLocaleString()} requests processed locally`
    : "0 requests processed locally";
  const tokensText = report
    ? `${formatTokens(report.totalTokens)} tokens — zero sent to cloud`
    : "0 tokens — zero sent to cloud";

  const rootClassName = className ? `cost-savings-widget ${className}` : "cost-savings-widget";

  return (
    <section className={rootClassName} data-testid="cost-savings-widget">
      <style>{`
        .cost-savings-widget {
          width: 100%;
          background: #0f172a;
          border-radius: 1rem;
          padding: 32px;
          box-sizing: border-box;
          border: 1px solid rgba(148, 163, 184, 0.18);
        }
        .cost-savings-live-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #10b981;
          animation: cost-savings-pulse 1.5s ease-in-out infinite;
        }
        .cost-savings-live-badge {
          color: #10b981;
          background: rgba(16, 185, 129, 0.14);
          border: 1px solid rgba(16, 185, 129, 0.45);
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
        }
        .cost-savings-tabs {
          display: flex;
          gap: 22px;
          margin-top: 14px;
          margin-bottom: 14px;
        }
        .cost-savings-tab {
          appearance: none;
          border: 0;
          background: transparent;
          color: #94a3b8;
          font-size: 14px;
          line-height: 1;
          padding: 0 0 6px;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          transition: color 120ms ease-out;
        }
        .cost-savings-tab:hover {
          color: #cbd5e1;
        }
        .cost-savings-tab.active {
          color: #ffffff;
          border-bottom-color: #10b981;
        }
        .cost-savings-skeleton {
          background: #1e293b;
          border-radius: 8px;
          animation: cost-savings-pulse 1.3s ease-in-out infinite;
        }
        .cost-savings-value {
          margin-top: 12px;
          font-size: 72px;
          line-height: 1;
          font-weight: 700;
          color: #10b981;
          font-variant-numeric: tabular-nums;
        }
        .cost-savings-muted {
          color: #94a3b8;
          font-size: 14px;
          margin-top: 8px;
        }
        .cost-savings-subtle {
          color: #cbd5e1;
          font-size: 14px;
          margin-top: 6px;
        }
        .cost-savings-bottom {
          margin-top: 16px;
          display: flex;
          gap: 16px;
          color: #64748b;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        @keyframes cost-savings-pulse {
          0%, 100% {
            opacity: 0.65;
          }
          50% {
            opacity: 1;
          }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="cost-savings-live-dot" />
        <span className="cost-savings-live-badge">LIVE</span>
      </div>

      {loading ? (
        <div data-testid="cost-savings-loading" style={{ marginTop: 12 }}>
          <div
            className="cost-savings-skeleton"
            data-testid="cost-savings-skeleton-value"
            style={{ width: 250, height: 74 }}
          />
          <div
            className="cost-savings-skeleton"
            data-testid="cost-savings-skeleton-requests"
            style={{ width: 260, height: 16, marginTop: 16 }}
          />
          <div
            className="cost-savings-skeleton"
            data-testid="cost-savings-skeleton-tokens"
            style={{ width: 240, height: 16, marginTop: 8 }}
          />
        </div>
      ) : error ? (
        <div style={{ marginTop: 12 }}>
          <div
            className="cost-savings-value"
            data-testid="cost-savings-value"
            style={{ color: "#64748b" }}
          >
            $-.--
          </div>
          <div className="cost-savings-muted">{error}</div>
        </div>
      ) : (
        <div>
          <div className="cost-savings-value" data-testid="cost-savings-value">
            {formatMoney(displayedSavings)}
          </div>
          <div className="cost-savings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`cost-savings-tab ${activeTab === tab ? "active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="cost-savings-muted">
            {isEmpty ? "Start chatting to track savings" : requestsText}
          </div>
          <div className="cost-savings-subtle">{tokensText}</div>
        </div>
      )}

      <div className="cost-savings-bottom">
        <span>{comparisons[0] ?? "vs GPT-4o"}</span>
        <span>{comparisons[1] ?? "vs Claude Sonnet"}</span>
      </div>
    </section>
  );
}
