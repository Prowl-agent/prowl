import React, { useEffect, useMemo, useState } from "react";

type HealthResponse = {
  status?: unknown;
  ollamaRunning?: unknown;
};

type ActiveModelResponse = {
  model?: unknown;
};

export interface AppShellProps {
  children: React.ReactNode;
  apiBase?: string;
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

type HealthState = "healthy" | "no-model" | "stopped";

function deriveHealthState(ollamaRunning: boolean, activeModel: string): HealthState {
  if (!ollamaRunning) {
    return "stopped";
  }
  if (activeModel === "No active model") {
    return "no-model";
  }
  return "healthy";
}

const HEALTH_LABELS: Record<HealthState, string> = {
  healthy: "Ollama running, model loaded",
  "no-model": "Ollama running, no model loaded",
  stopped: "Ollama not running",
};

const HEALTH_POLL_MS = 30_000;

export default function AppShell({ children, apiBase = "" }: AppShellProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [activeModel, setActiveModel] = useState("No active model");
  const [showTooltip, setShowTooltip] = useState(false);

  const healthState = deriveHealthState(ollamaRunning, activeModel);

  useEffect(() => {
    let disposed = false;

    const refreshHeader = async () => {
      try {
        const [healthResponse, modelResponse] = await Promise.all([
          fetch(`${base}/api/health`, { method: "GET" }),
          fetch(`${base}/api/models/active`, { method: "GET" }),
        ]);

        if (!healthResponse.ok || !modelResponse.ok) {
          throw new Error("Failed to load header state");
        }

        const [healthPayload, modelPayload] = (await Promise.all([
          healthResponse.json(),
          modelResponse.json(),
        ])) as [HealthResponse, ActiveModelResponse];

        if (disposed) {
          return;
        }

        setOllamaRunning(healthPayload.ollamaRunning === true);

        const model =
          typeof modelPayload.model === "string" && modelPayload.model.trim().length > 0
            ? modelPayload.model.trim()
            : "No active model";
        setActiveModel(model);
      } catch {
        if (disposed) {
          return;
        }
        setOllamaRunning(false);
        setActiveModel("No active model");
      }
    };

    void refreshHeader();
    const intervalId = window.setInterval(() => {
      void refreshHeader();
    }, HEALTH_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [base]);

  return (
    <div className="prowl-app-shell" data-testid="app-shell">
      <style>{`
        .prowl-app-shell {
          min-height: 100%;
          background: var(--prowl-bg);
          color: var(--prowl-text);
        }
        .prowl-app-shell-header {
          height: 56px;
          position: sticky;
          top: 0;
          z-index: 10;
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 12px;
          padding: 0 24px;
          background: #0a0f1a;
          border-bottom: 1px solid #1e293b;
        }
        .prowl-brand {
          color: #f8fafc;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: 0.01em;
          justify-self: start;
        }
        .prowl-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          justify-self: center;
          color: #34d399;
          font-size: 12px;
          font-weight: 600;
          position: relative;
          cursor: pointer;
        }
        .prowl-status.stopped {
          color: #f87171;
        }
        .prowl-status.no-model {
          color: #fbbf24;
        }
        .prowl-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #10b981;
          box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55);
          animation: prowl-pulse 1.6s ease-out infinite;
        }
        .prowl-status.stopped .prowl-status-dot {
          background: #ef4444;
          box-shadow: none;
          animation: none;
        }
        .prowl-status.no-model .prowl-status-dot {
          background: #f59e0b;
          box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55);
          animation: prowl-pulse-yellow 1.6s ease-out infinite;
        }
        .prowl-health-tooltip {
          position: absolute;
          top: calc(100% + 10px);
          left: 50%;
          transform: translateX(-50%);
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 10px;
          padding: 12px 16px;
          min-width: 260px;
          z-index: 20;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          pointer-events: auto;
        }
        .prowl-health-tooltip-title {
          font-size: 13px;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .prowl-health-tooltip-body {
          font-size: 12px;
          color: #94a3b8;
          line-height: 1.5;
        }
        .prowl-health-tooltip-code {
          display: inline-block;
          margin-top: 6px;
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 4px 8px;
          font-family: monospace;
          font-size: 12px;
          color: #e2e8f0;
        }
        .prowl-model {
          color: #94a3b8;
          font-size: 12px;
          font-weight: 500;
          justify-self: end;
          text-align: right;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 360px;
        }
        .prowl-app-shell-main {
          padding: 24px;
          padding-bottom: 72px;
        }
        .prowl-app-shell-content {
          width: 100%;
          max-width: 1200px;
          margin: 0 auto;
          display: grid;
          gap: 24px;
        }
        .prowl-app-shell-footer {
          height: 32px;
          position: sticky;
          bottom: 0;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          color: #475569;
          background: #0a0f1a;
          border-top: 1px solid #1e293b;
          text-align: center;
          padding: 0 12px;
        }
        @keyframes prowl-pulse {
          0% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55);
          }
          70% {
            box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
          }
        }
        @keyframes prowl-pulse-yellow {
          0% {
            box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55);
          }
          70% {
            box-shadow: 0 0 0 8px rgba(245, 158, 11, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(245, 158, 11, 0);
          }
        }
        @media (max-width: 880px) {
          .prowl-app-shell-header {
            grid-template-columns: 1fr;
            height: auto;
            min-height: 56px;
            padding: 10px 16px;
          }
          .prowl-status,
          .prowl-model,
          .prowl-brand {
            justify-self: start;
            text-align: left;
          }
          .prowl-model {
            max-width: none;
          }
          .prowl-app-shell-main {
            padding: 16px;
            padding-bottom: 64px;
          }
        }
      `}</style>

      <header className="prowl-app-shell-header">
        <div className="prowl-brand">🐾 Prowl</div>
        <div
          className={`prowl-status ${healthState}`}
          data-testid="app-shell-ollama-status"
          data-health={healthState}
          onClick={() => setShowTooltip((prev) => !prev)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <span className="prowl-status-dot" />
          <span>{HEALTH_LABELS[healthState]}</span>

          {showTooltip ? (
            <div className="prowl-health-tooltip" data-testid="health-tooltip">
              {healthState === "stopped" ? (
                <>
                  <div className="prowl-health-tooltip-title" style={{ color: "#f87171" }}>
                    Ollama is not running
                  </div>
                  <div className="prowl-health-tooltip-body">
                    Prowl needs Ollama to run AI models locally. Start it with:
                    <code className="prowl-health-tooltip-code">ollama serve</code>
                  </div>
                </>
              ) : healthState === "no-model" ? (
                <>
                  <div className="prowl-health-tooltip-title" style={{ color: "#fbbf24" }}>
                    No model loaded
                  </div>
                  <div className="prowl-health-tooltip-body">
                    Ollama is running but no model is active. Pull a model:
                    <code className="prowl-health-tooltip-code">ollama pull qwen3:8b</code>
                  </div>
                </>
              ) : (
                <>
                  <div className="prowl-health-tooltip-title" style={{ color: "#34d399" }}>
                    Everything is running
                  </div>
                  <div className="prowl-health-tooltip-body">
                    Ollama is running and {activeModel} is loaded. You're ready to go.
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
        <div className="prowl-model" data-testid="app-shell-active-model">
          {activeModel}
        </div>
      </header>

      <main className="prowl-app-shell-main">
        <div className="prowl-app-shell-content">{children}</div>
      </main>

      <footer className="prowl-app-shell-footer">
        Prowl — Your AI agent. Your hardware. Zero cost.
      </footer>
    </div>
  );
}
