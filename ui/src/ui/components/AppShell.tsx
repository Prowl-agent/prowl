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

export default function AppShell({ children, apiBase = "" }: AppShellProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [activeModel, setActiveModel] = useState("No active model");

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
    }, 10_000);

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
        }
        .prowl-status.stopped {
          color: #f87171;
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
          className={`prowl-status ${ollamaRunning ? "running" : "stopped"}`}
          data-testid="app-shell-ollama-status"
        >
          <span className="prowl-status-dot" />
          <span>{ollamaRunning ? "Ollama Running" : "Ollama Stopped"}</span>
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
