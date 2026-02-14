import React, { useMemo, useState } from "react";

type PullPhase = "pulling" | "verifying" | "complete" | "error";

type PullProgressEvent = {
  phase?: unknown;
  status?: unknown;
  percentComplete?: unknown;
  model?: unknown;
  message?: unknown;
  error?: unknown;
};

export type SetupRecommendation = {
  model: string;
  displayName: string;
  quality: "basic" | "good" | "great" | "excellent";
  reason: string;
  sizeGB: number;
};

export interface SetupWizardProps {
  isFirstRun: boolean;
  hardwareProfile: string;
  recommendation: SetupRecommendation | null;
  apiBase?: string;
  onComplete: () => void;
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toPhase(value: unknown): PullPhase | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "pulling" || normalized === "verifying" || normalized === "complete") {
    return normalized;
  }
  if (normalized === "error") {
    return "error";
  }
  return null;
}

function toPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function qualityLabel(quality: SetupRecommendation["quality"]): string {
  return `${quality[0]?.toUpperCase() ?? ""}${quality.slice(1)}`;
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error.trim();
    }
  } catch {
    // Ignore parse errors and use status fallback.
  }
  return `HTTP ${response.status}`;
}

export default function SetupWizard({
  isFirstRun,
  hardwareProfile,
  recommendation,
  apiBase = "",
  onComplete,
}: SetupWizardProps) {
  const [step, setStep] = useState(1);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    phase: PullPhase;
    percent: number;
    message: string;
  } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNotice, setInstallNotice] = useState<string | null>(null);

  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);

  if (!isFirstRun || !recommendation) {
    return null;
  }

  const ensureActiveModel = async () => {
    const response = await fetch(`${base}/api/models/switch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tag: recommendation.model }),
    });
    if (!response.ok) {
      throw new Error(await parseErrorBody(response));
    }
  };

  const isModelAlreadyInstalled = async (): Promise<boolean> => {
    const response = await fetch(`${base}/api/models/installed`, {
      method: "GET",
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: unknown }>;
    };
    const models = Array.isArray(payload.models) ? payload.models : [];
    return models.some((entry) => entry?.name === recommendation.model);
  };

  const handleInstall = async () => {
    if (installing) {
      return;
    }

    setInstallError(null);
    setInstallNotice(null);
    setInstallProgress({
      phase: "pulling",
      percent: 0,
      message: "Pulling model...",
    });
    setInstalling(true);

    try {
      if (await isModelAlreadyInstalled()) {
        setInstallProgress({
          phase: "complete",
          percent: 100,
          message: "✓ Already installed",
        });
        setInstallNotice("✓ Already installed");
        await ensureActiveModel();
        setStep(3);
        return;
      }

      const response = await fetch(`${base}/api/models/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tag: recommendation.model }),
      });

      if (!response.ok) {
        throw new Error(await parseErrorBody(response));
      }
      if (!response.body) {
        throw new Error("Pull stream unavailable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

      const handleLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (!line) {
          return;
        }

        let parsed: PullProgressEvent;
        try {
          parsed = JSON.parse(line) as PullProgressEvent;
        } catch {
          return;
        }

        const phase = toPhase(parsed.phase ?? parsed.status);
        if (!phase) {
          return;
        }

        const percent =
          phase === "verifying"
            ? Math.max(toPercent(parsed.percentComplete), 99)
            : toPercent(parsed.percentComplete);
        const message =
          typeof parsed.message === "string" && parsed.message.trim().length > 0
            ? parsed.message.trim()
            : phase === "verifying"
              ? "Verifying..."
              : phase === "complete"
                ? "Complete"
                : "Pulling model...";

        if (phase === "error") {
          const failure =
            typeof parsed.error === "string" && parsed.error.trim().length > 0
              ? parsed.error.trim()
              : message || "Model install failed";
          setInstallError(failure);
          setInstallProgress({
            phase: "error",
            percent: 0,
            message: failure,
          });
          return;
        }

        if (phase === "complete") {
          completed = true;
          setInstallProgress({
            phase: "complete",
            percent: 100,
            message: "Complete",
          });
          return;
        }

        setInstallProgress({
          phase,
          percent,
          message,
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        handleLine(buffer);
      }

      if (!completed || installError) {
        if (!installError) {
          throw new Error("Install stream ended unexpectedly");
        }
        return;
      }

      await ensureActiveModel();
      setStep(3);
    } catch (error) {
      setInstallError(getErrorMessage(error));
      setInstallProgress(null);
    } finally {
      setInstalling(false);
    }
  };

  const renderStep = () => {
    if (step === 1) {
      return (
        <div>
          <h2 className="setup-wizard-title">Your Hardware</h2>
          <div className="setup-wizard-card-block">{hardwareProfile}</div>
          <div className="setup-wizard-check">✓ Hardware detected</div>
          <button className="setup-wizard-button" type="button" onClick={() => setStep(2)}>
            Continue →
          </button>
        </div>
      );
    }

    if (step === 2) {
      return (
        <div>
          <h2 className="setup-wizard-title">Recommended Model</h2>
          <div className="setup-wizard-card-block">
            <div className="setup-model-row">
              <div className="setup-model-name">{recommendation.displayName}</div>
              <span className={`setup-quality-badge quality-${recommendation.quality}`}>
                {qualityLabel(recommendation.quality)}
              </span>
            </div>
            <div className="setup-model-size">{recommendation.sizeGB}GB download</div>
            <div className="setup-model-reason">{recommendation.reason}</div>
          </div>

          <button
            className="setup-wizard-button"
            type="button"
            onClick={() => {
              void handleInstall();
            }}
            disabled={installing}
          >
            {installing ? "Installing..." : "Install & Continue →"}
          </button>

          {installProgress ? (
            <div className="setup-progress-wrap" data-testid="setup-wizard-progress">
              <div className="setup-progress-head">
                <span>{installProgress.message}</span>
                <span>{installProgress.percent}%</span>
              </div>
              <div className="setup-progress-track">
                <div
                  className="setup-progress-fill"
                  style={{ width: `${installProgress.percent}%` }}
                />
              </div>
            </div>
          ) : null}

          {installNotice ? <div className="setup-wizard-check">{installNotice}</div> : null}
          {installError ? <div className="setup-wizard-error">{installError}</div> : null}
        </div>
      );
    }

    if (step === 3) {
      return (
        <div>
          <h2 className="setup-wizard-title">Connect a Messaging App</h2>
          <div className="setup-step-subtitle">
            Optional — skip if you want to use the API directly
          </div>

          <div className="setup-connect-grid">
            <div className="setup-connect-card">
              <div className="setup-connect-icon">📱</div>
              <div className="setup-connect-name">Telegram</div>
              <a
                className="setup-connect-button"
                href="https://docs.prowl.ai/channels/telegram"
                target="_blank"
                rel="noreferrer"
              >
                Connect
              </a>
            </div>
            <div className="setup-connect-card">
              <div className="setup-connect-icon">🎮</div>
              <div className="setup-connect-name">Discord</div>
              <a
                className="setup-connect-button"
                href="https://docs.prowl.ai/channels/discord"
                target="_blank"
                rel="noreferrer"
              >
                Connect
              </a>
            </div>
            <div className="setup-connect-card">
              <div className="setup-connect-icon">💬</div>
              <div className="setup-connect-name">WhatsApp</div>
              <a
                className="setup-connect-button"
                href="https://docs.prowl.ai/channels/whatsapp"
                target="_blank"
                rel="noreferrer"
              >
                Connect
              </a>
            </div>
          </div>

          <button className="setup-skip-link" type="button" onClick={() => setStep(4)}>
            Skip for now →
          </button>
        </div>
      );
    }

    return (
      <div>
        <div className="setup-ready-emoji">🐾</div>
        <h2 className="setup-ready-title">You're ready!</h2>
        <div className="setup-ready-subtitle">Prowl is running on your hardware</div>

        <div className="setup-ready-stats">
          <div className="setup-ready-stat">
            <div className="setup-ready-label">Local</div>
            <div className="setup-ready-value">100%</div>
          </div>
          <div className="setup-ready-stat">
            <div className="setup-ready-label">Cloud Cost</div>
            <div className="setup-ready-value">$0.00</div>
          </div>
          <div className="setup-ready-stat">
            <div className="setup-ready-label">Privacy</div>
            <div className="setup-ready-value">Full</div>
          </div>
        </div>

        <button
          className="setup-wizard-button setup-wizard-button-wide"
          type="button"
          onClick={onComplete}
        >
          Open Dashboard →
        </button>
      </div>
    );
  };

  return (
    <div className="setup-wizard-overlay" data-testid="setup-wizard">
      <style>{`
        .setup-wizard-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(4px);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .setup-wizard-card {
          width: min(560px, 100%);
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 24px;
          padding: 40px;
          color: #f1f5f9;
          box-shadow: 0 28px 56px rgba(0, 0, 0, 0.45);
        }
        .setup-progress-indicator {
          position: relative;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
          margin-bottom: 28px;
        }
        .setup-progress-indicator::before {
          content: "";
          position: absolute;
          left: 10%;
          right: 10%;
          top: 8px;
          height: 2px;
          background: #334155;
          z-index: 0;
        }
        .setup-progress-dot {
          width: 16px;
          height: 16px;
          border-radius: 999px;
          background: #334155;
          border: 2px solid #334155;
          position: relative;
          z-index: 1;
          justify-self: center;
        }
        .setup-progress-dot.active {
          background: #10b981;
          border-color: #10b981;
        }
        .setup-wizard-title {
          margin: 0;
          color: #ffffff;
          font-size: 24px;
          line-height: 1.2;
          font-weight: 700;
        }
        .setup-step-subtitle {
          margin-top: 8px;
          color: #94a3b8;
          font-size: 14px;
        }
        .setup-wizard-card-block {
          margin-top: 20px;
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 20px;
          color: #cbd5e1;
          line-height: 1.5;
        }
        .setup-wizard-check {
          margin-top: 12px;
          color: #34d399;
          font-size: 14px;
          font-weight: 600;
        }
        .setup-wizard-button {
          margin-top: 20px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 10px;
          background: #10b981;
          color: #ffffff;
          font-size: 15px;
          font-weight: 700;
          min-height: 44px;
          padding: 10px 16px;
          width: auto;
          cursor: pointer;
        }
        .setup-wizard-button:hover:not(:disabled) {
          background: #059669;
        }
        .setup-wizard-button:disabled {
          cursor: not-allowed;
          background: #065f46;
          color: #a7f3d0;
        }
        .setup-model-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .setup-model-name {
          color: #ffffff;
          font-size: 20px;
          font-weight: 700;
        }
        .setup-model-size {
          margin-top: 10px;
          color: #94a3b8;
          font-size: 14px;
        }
        .setup-model-reason {
          margin-top: 8px;
          color: #cbd5e1;
          font-size: 14px;
        }
        .setup-quality-badge {
          font-size: 12px;
          border-radius: 999px;
          padding: 4px 10px;
          font-weight: 700;
        }
        .setup-quality-badge.quality-excellent {
          background: rgba(16, 185, 129, 0.2);
          color: #34d399;
        }
        .setup-quality-badge.quality-great {
          background: rgba(59, 130, 246, 0.2);
          color: #60a5fa;
        }
        .setup-quality-badge.quality-good {
          background: rgba(100, 116, 139, 0.3);
          color: #cbd5e1;
        }
        .setup-quality-badge.quality-basic {
          background: rgba(245, 158, 11, 0.2);
          color: #fbbf24;
        }
        .setup-progress-wrap {
          margin-top: 12px;
        }
        .setup-progress-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #e2e8f0;
          font-size: 13px;
          margin-bottom: 8px;
        }
        .setup-progress-track {
          width: 100%;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: #334155;
        }
        .setup-progress-fill {
          height: 100%;
          border-radius: 999px;
          background: #10b981;
          transition: width 240ms ease;
        }
        .setup-wizard-error {
          margin-top: 12px;
          color: #f87171;
          font-size: 13px;
        }
        .setup-connect-grid {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .setup-connect-card {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 14px;
          text-align: center;
        }
        .setup-connect-icon {
          font-size: 22px;
          line-height: 1;
        }
        .setup-connect-name {
          margin-top: 8px;
          font-size: 14px;
          color: #f1f5f9;
          font-weight: 600;
        }
        .setup-connect-button {
          margin-top: 10px;
          border: 0;
          border-radius: 8px;
          background: #334155;
          color: #e2e8f0;
          font-size: 12px;
          font-weight: 700;
          min-height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          text-decoration: none;
        }
        .setup-connect-button:hover {
          background: #475569;
          text-decoration: none;
        }
        .setup-skip-link {
          margin-top: 14px;
          border: 0;
          background: transparent;
          color: #94a3b8;
          font-size: 14px;
          cursor: pointer;
          padding: 0;
        }
        .setup-skip-link:hover {
          text-decoration: underline;
        }
        .setup-ready-emoji {
          font-size: 64px;
          line-height: 1;
        }
        .setup-ready-title {
          margin: 12px 0 0;
          color: #ffffff;
          font-size: 28px;
          font-weight: 700;
          line-height: 1.2;
        }
        .setup-ready-subtitle {
          margin-top: 8px;
          color: #cbd5e1;
          font-size: 16px;
        }
        .setup-ready-stats {
          margin-top: 18px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .setup-ready-stat {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 14px;
          text-align: center;
        }
        .setup-ready-label {
          color: #94a3b8;
          font-size: 12px;
        }
        .setup-ready-value {
          margin-top: 6px;
          color: #10b981;
          font-size: 18px;
          font-weight: 700;
        }
        .setup-wizard-button-wide {
          width: 100%;
        }
        @media (max-width: 760px) {
          .setup-wizard-card {
            padding: 24px;
          }
          .setup-connect-grid,
          .setup-ready-stats {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="setup-wizard-card">
        <div className="setup-progress-indicator" aria-hidden="true">
          {[1, 2, 3, 4].map((index) => (
            <span
              key={index}
              className={`setup-progress-dot ${step >= index ? "active" : ""}`}
              data-testid={`setup-step-dot-${index}`}
            />
          ))}
        </div>

        {renderStep()}
      </div>
    </div>
  );
}
