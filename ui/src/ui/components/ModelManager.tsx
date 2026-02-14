import React, { useEffect, useMemo, useRef, useState } from "react";

type ModelQuality = "excellent" | "great" | "good" | "basic";
type InstallPhase = "pulling" | "verifying" | "complete" | "error";

type InstalledModel = {
  name: string;
  displayName: string;
  sizeGB: number;
  modifiedAt: string;
  isActive: boolean;
  details: {
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
};

type InstalledModelsResponse = {
  models?: InstalledModel[];
  ollamaRunning?: boolean;
};

type PullProgress = {
  phase?: unknown;
  status?: unknown;
  model?: unknown;
  percentComplete?: unknown;
  message?: unknown;
  error?: unknown;
};

type RecommendationMeta = {
  quality: ModelQuality;
  estimatedSpeed: string;
};

const QUICK_PICKS = ["qwen3:8b", "qwen3:4b", "qwen2.5-coder:14b", "deepseek-r1:7b"] as const;
const DEFAULT_INSTALL_MESSAGE = "Install stream ended unexpectedly";
const RECOMMENDATION_BY_TAG: Record<string, RecommendationMeta> = {
  "qwen3:32b": { quality: "excellent", estimatedSpeed: "8-12 tok/s" },
  "qwen2.5-coder:14b": { quality: "great", estimatedSpeed: "10-15 tok/s" },
  "qwen3:8b": { quality: "good", estimatedSpeed: "15-20 tok/s" },
  "qwen3:4b": { quality: "basic", estimatedSpeed: "20-30 tok/s" },
};

export interface ModelManagerProps {
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function formatSizeGB(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (safe >= 10) {
    return safe.toFixed(0);
  }
  return safe.toFixed(1);
}

function toPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toDomId(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePullPhase(value: unknown): InstallPhase | null {
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

function toPhaseLabel(phase: InstallPhase): string {
  if (phase === "verifying") {
    return "Verifying...";
  }
  if (phase === "complete") {
    return "Complete";
  }
  if (phase === "error") {
    return "Error";
  }
  return "Pulling model...";
}

function toQualityLabel(quality: ModelQuality): string {
  return quality[0]?.toUpperCase() + quality.slice(1);
}

function resolveRecommendation(tag: string): RecommendationMeta {
  const normalized = tag.trim().toLowerCase();
  return RECOMMENDATION_BY_TAG[normalized] ?? { quality: "good", estimatedSpeed: "unknown speed" };
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error.trim();
    }
  } catch {
    // Ignore parse failures and use status fallback.
  }
  return `HTTP ${response.status}`;
}

export default function ModelManager({ className, apiBase = "" }: ModelManagerProps) {
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switchingTag, setSwitchingTag] = useState<string | null>(null);
  const [deleteConfirmTag, setDeleteConfirmTag] = useState<string | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    phase: InstallPhase;
    percent: number;
    model: string;
    message: string;
  } | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  const activeModel = useMemo(() => models.find((entry) => entry.isActive) ?? null, [models]);

  const activeRecommendation = useMemo(
    () => resolveRecommendation(activeModel?.name ?? ""),
    [activeModel],
  );

  const activeQuantization = useMemo(() => {
    const quantization = activeModel?.details.quantizationLevel ?? "";
    return quantization.trim().length > 0 ? quantization : "unknown quantization";
  }, [activeModel]);

  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);

  const clearResetTimer = () => {
    if (resetTimerRef.current != null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  const loadInstalledModels = async (opts?: { signal?: AbortSignal; silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
    }
    try {
      const response = await fetch(`${base}/api/models/installed`, {
        method: "GET",
        signal: opts?.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as InstalledModelsResponse;
      if (opts?.signal?.aborted) {
        return;
      }
      setModels(Array.isArray(payload.models) ? payload.models : []);
      setOllamaRunning(typeof payload.ollamaRunning === "boolean" ? payload.ollamaRunning : true);
      setError(null);
    } catch (cause) {
      if (opts?.signal?.aborted) {
        return;
      }
      setModels([]);
      setOllamaRunning(false);
      setError(getErrorMessage(cause));
    } finally {
      if (!opts?.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadInstalledModels({ signal: controller.signal });
    return () => {
      controller.abort();
      clearResetTimer();
    };
  }, [base]);

  const handleSwitch = async (tag: string) => {
    if (!tag || switchingTag || installing) {
      return;
    }
    setSwitchingTag(tag);
    setError(null);
    try {
      const response = await fetch(`${base}/api/models/switch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tag }),
      });
      if (!response.ok) {
        throw new Error(await parseErrorBody(response));
      }
      await loadInstalledModels({ silent: true });
      setDeleteConfirmTag(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setSwitchingTag(null);
    }
  };

  const handleDelete = async (tag: string) => {
    if (!tag || deletingTag || installing) {
      return;
    }
    setDeletingTag(tag);
    setError(null);
    try {
      const response = await fetch(`${base}/api/models/${encodeURIComponent(tag)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseErrorBody(response));
      }
      setDeleteConfirmTag(null);
      await loadInstalledModels({ silent: true });
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setDeletingTag(null);
    }
  };

  const resetInstallState = () => {
    setInstallProgress(null);
    setInstallSuccess(null);
    setInstallError(null);
    setSearchValue("");
  };

  const handleInstall = async () => {
    const tag = searchValue.trim();
    if (!tag || installing) {
      return;
    }

    clearResetTimer();
    setInstallError(null);
    setInstallSuccess(null);
    setInstallProgress({
      phase: "pulling",
      percent: 0,
      model: tag,
      message: "Pulling model...",
    });
    setInstalling(true);

    try {
      const response = await fetch(`${base}/api/models/pull`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tag }),
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
      let reachedTerminalState = false;

      const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
          return false;
        }

        let parsed: PullProgress;
        try {
          parsed = JSON.parse(line) as PullProgress;
        } catch {
          return false;
        }

        const phase = parsePullPhase(parsed.phase ?? parsed.status);
        if (!phase) {
          return false;
        }

        const model =
          typeof parsed.model === "string" && parsed.model.trim().length > 0
            ? parsed.model.trim()
            : tag;
        const percent = toPercent(parsed.percentComplete);
        const message =
          typeof parsed.message === "string" && parsed.message.trim().length > 0
            ? parsed.message.trim()
            : typeof parsed.error === "string" && parsed.error.trim().length > 0
              ? parsed.error.trim()
              : "";

        if (phase === "error") {
          const failureMessage = message || "Model install failed";
          setInstallProgress({
            phase: "error",
            percent: 0,
            model,
            message: failureMessage,
          });
          setInstallError(failureMessage);
          return true;
        }

        if (phase === "complete") {
          setInstallProgress({
            phase: "complete",
            percent: 100,
            model,
            message: "Complete",
          });
          setInstallSuccess(`✅ ${model} ready`);
          void loadInstalledModels({ silent: true });
          clearResetTimer();
          resetTimerRef.current = window.setTimeout(() => {
            resetInstallState();
            resetTimerRef.current = null;
          }, 3_000);
          return true;
        }

        setInstallProgress({
          phase,
          percent: phase === "verifying" ? Math.max(percent, 99) : percent,
          model,
          message: toPhaseLabel(phase),
        });
        return false;
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
          if (handleLine(line)) {
            reachedTerminalState = true;
            break;
          }
        }
        if (reachedTerminalState) {
          break;
        }
      }

      if (!reachedTerminalState) {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          reachedTerminalState = handleLine(buffer);
        }
      }

      if (!reachedTerminalState) {
        throw new Error(DEFAULT_INSTALL_MESSAGE);
      }
    } catch (cause) {
      setInstallProgress(null);
      setInstallSuccess(null);
      setInstallError(getErrorMessage(cause));
    } finally {
      setInstalling(false);
    }
  };

  const rootClassName = className ? `model-manager-widget ${className}` : "model-manager-widget";
  const qualityClassName = `model-manager-quality-badge quality-${activeRecommendation.quality}`;
  const progressVisible = installing || Boolean(installProgress) || Boolean(installSuccess);

  return (
    <section className={rootClassName} data-testid="model-manager-widget">
      <style>{`
        .model-manager-widget {
          width: 100%;
          background: #0f172a;
          border-radius: 1rem;
          padding: 32px;
          box-sizing: border-box;
          border: 1px solid rgba(148, 163, 184, 0.18);
        }
        .model-manager-title {
          margin: 0;
          color: #ffffff;
          font-size: 20px;
          font-weight: 700;
          line-height: 1.2;
        }
        .model-manager-subtitle {
          margin-top: 6px;
          color: #94a3b8;
          font-size: 14px;
        }
        .model-manager-card {
          margin-top: 18px;
          width: 100%;
          background: #1e293b;
          border-radius: 0.75rem;
          padding: 20px;
          box-sizing: border-box;
          border: 1px solid rgba(148, 163, 184, 0.2);
        }
        .model-manager-section-label {
          margin-top: 24px;
          color: #94a3b8;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .model-manager-active-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #10b981;
          animation: model-manager-pulse 1.4s ease-in-out infinite;
        }
        .model-manager-badge {
          font-size: 12px;
          border-radius: 999px;
          padding: 4px 10px;
          font-weight: 700;
        }
        .model-manager-size-badge {
          background: #475569;
          color: #e2e8f0;
        }
        .model-manager-quality-badge.quality-excellent {
          background: rgba(16, 185, 129, 0.2);
          color: #34d399;
        }
        .model-manager-quality-badge.quality-great {
          background: rgba(59, 130, 246, 0.2);
          color: #60a5fa;
        }
        .model-manager-quality-badge.quality-good {
          background: rgba(100, 116, 139, 0.3);
          color: #cbd5e1;
        }
        .model-manager-quality-badge.quality-basic {
          background: rgba(245, 158, 11, 0.2);
          color: #fbbf24;
        }
        .model-manager-status {
          margin-top: 10px;
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 12px;
          font-weight: 700;
        }
        .model-manager-status.running {
          color: #34d399;
          background: rgba(16, 185, 129, 0.14);
        }
        .model-manager-status.stopped {
          color: #f87171;
          background: rgba(239, 68, 68, 0.12);
        }
        .model-manager-list {
          margin-top: 8px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .model-manager-row {
          background: rgba(30, 41, 59, 0.55);
          border: 1px solid rgba(148, 163, 184, 0.16);
          border-radius: 0.75rem;
          padding: 14px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .model-manager-row-title {
          color: #ffffff;
          font-size: 15px;
          font-weight: 600;
        }
        .model-manager-row-sub {
          color: #94a3b8;
          font-size: 12px;
          margin-top: 4px;
        }
        .model-manager-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .model-manager-switch-button {
          border: 0;
          background: #334155;
          color: #ffffff;
          border-radius: 0.5rem;
          padding: 8px 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .model-manager-switch-button:disabled {
          cursor: not-allowed;
          background: #1f2937;
          color: #64748b;
        }
        .model-manager-delete-button {
          border: 0;
          background: transparent;
          color: #f87171;
          border-radius: 0.5rem;
          padding: 8px 10px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .model-manager-delete-button:hover:not(:disabled) {
          color: #fca5a5;
        }
        .model-manager-delete-button:disabled {
          cursor: not-allowed;
          color: #7f1d1d;
        }
        .model-manager-confirm {
          background: rgba(127, 29, 29, 0.2);
          border: 1px solid rgba(248, 113, 113, 0.35);
        }
        .model-manager-confirm-text {
          color: #fecaca;
          font-size: 14px;
          font-weight: 600;
        }
        .model-manager-confirm-button {
          border: 0;
          border-radius: 0.5rem;
          padding: 8px 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .model-manager-confirm-danger {
          background: #dc2626;
          color: #fff;
        }
        .model-manager-confirm-cancel {
          background: #334155;
          color: #e2e8f0;
        }
        .model-manager-input {
          margin-top: 10px;
          width: 100%;
          box-sizing: border-box;
          height: 44px;
          border-radius: 0.5rem;
          border: 1px solid #475569;
          background: #1e293b;
          color: #ffffff;
          font-size: 14px;
          padding: 0 12px;
        }
        .model-manager-input::placeholder {
          color: #64748b;
        }
        .model-manager-chips {
          margin-top: 10px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .model-manager-chip {
          border: 0;
          border-radius: 999px;
          background: #334155;
          color: #ffffff;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .model-manager-chip:hover {
          background: #475569;
        }
        .model-manager-install-button {
          margin-top: 12px;
          width: 100%;
          height: 44px;
          border: 0;
          border-radius: 0.5rem;
          background: #10b981;
          color: #ffffff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .model-manager-install-button:disabled {
          cursor: not-allowed;
          background: #065f46;
          color: #a7f3d0;
        }
        .model-manager-spinner {
          width: 14px;
          height: 14px;
          border-radius: 999px;
          border: 2px solid rgba(255, 255, 255, 0.35);
          border-top-color: #ffffff;
          animation: model-manager-spin 0.9s linear infinite;
        }
        .model-manager-progress-wrap {
          margin-top: 12px;
        }
        .model-manager-progress-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #e2e8f0;
          font-size: 14px;
          margin-bottom: 8px;
        }
        .model-manager-progress-label {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .model-manager-progress-track {
          width: 100%;
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: #334155;
        }
        .model-manager-progress-fill {
          height: 100%;
          border-radius: 999px;
          background: #10b981;
          transition: width 300ms ease;
        }
        .model-manager-progress-percent {
          color: #10b981;
          font-size: 14px;
          font-weight: 700;
          text-align: right;
          margin-top: 6px;
        }
        .model-manager-success {
          margin-top: 12px;
          color: #34d399;
          font-size: 14px;
          font-weight: 700;
        }
        .model-manager-error {
          margin-top: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: #f87171;
          font-size: 14px;
          font-weight: 600;
        }
        .model-manager-error-dismiss {
          border: 0;
          background: #334155;
          color: #e2e8f0;
          border-radius: 0.5rem;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .model-manager-muted {
          color: #64748b;
          font-size: 13px;
        }
        @keyframes model-manager-pulse {
          0%, 100% {
            opacity: 0.5;
          }
          50% {
            opacity: 1;
          }
        }
        @keyframes model-manager-spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }
      `}</style>

      <h2 className="model-manager-title">Model Manager</h2>
      <div className="model-manager-subtitle">Manage your local AI models</div>

      <div className="model-manager-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="model-manager-active-dot" />
              <span
                style={{ color: "#ffffff", fontSize: 18, fontWeight: 700 }}
                data-testid="active-model-name"
              >
                {activeModel?.displayName ?? "No active model"}
              </span>
            </div>
            <div className="model-manager-muted" style={{ marginTop: 10 }}>
              {activeRecommendation.estimatedSpeed} · {activeQuantization}
            </div>
            <span className={`model-manager-status ${ollamaRunning ? "running" : "stopped"}`}>
              {ollamaRunning ? "● Running" : "○ Stopped"}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="model-manager-badge model-manager-size-badge">
              {formatSizeGB(activeModel?.sizeGB ?? 0)}GB
            </span>
            <span className={`model-manager-badge ${qualityClassName}`}>
              {toQualityLabel(activeRecommendation.quality)}
            </span>
          </div>
        </div>
      </div>

      <div className="model-manager-section-label">Installed</div>
      <div className="model-manager-list">
        {loading ? (
          <div className="model-manager-muted">Loading models...</div>
        ) : models.length === 0 ? (
          <div className="model-manager-muted">No local models found.</div>
        ) : (
          models.map((model) => {
            const id = toDomId(model.name);
            if (deleteConfirmTag === model.name) {
              return (
                <div
                  className="model-manager-row model-manager-confirm"
                  key={`confirm-${model.name}`}
                >
                  <div className="model-manager-confirm-text">Delete {model.displayName}?</div>
                  <div className="model-manager-actions">
                    <button
                      type="button"
                      className="model-manager-confirm-button model-manager-confirm-danger"
                      onClick={() => {
                        void handleDelete(model.name);
                      }}
                      disabled={deletingTag === model.name}
                      data-testid={`confirm-delete-${id}`}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="model-manager-confirm-button model-manager-confirm-cancel"
                      onClick={() => setDeleteConfirmTag(null)}
                      disabled={deletingTag === model.name}
                      data-testid={`cancel-delete-${id}`}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className="model-manager-row" key={model.name} data-testid={`model-row-${id}`}>
                <div>
                  <div className="model-manager-row-title">{model.displayName}</div>
                  <div className="model-manager-row-sub">{formatSizeGB(model.sizeGB)}GB</div>
                </div>
                <div className="model-manager-actions">
                  <button
                    type="button"
                    className="model-manager-switch-button"
                    onClick={() => {
                      void handleSwitch(model.name);
                    }}
                    disabled={model.isActive || switchingTag === model.name || installing}
                    data-testid={`switch-${id}`}
                  >
                    Switch
                  </button>
                  <button
                    type="button"
                    className="model-manager-delete-button"
                    onClick={() => setDeleteConfirmTag(model.name)}
                    disabled={model.isActive || installing}
                    data-testid={`delete-${id}`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="model-manager-section-label">Install Model</div>
      <input
        className="model-manager-input"
        placeholder="Search HuggingFace or enter Ollama tag..."
        value={searchValue}
        onChange={(event) => setSearchValue(event.target.value)}
        data-testid="install-search-input"
      />
      <div className="model-manager-chips">
        {QUICK_PICKS.map((tag) => (
          <button
            key={tag}
            type="button"
            className="model-manager-chip"
            onClick={() => setSearchValue(tag)}
            data-testid={`chip-${toDomId(tag)}`}
          >
            {tag}
          </button>
        ))}
      </div>

      {progressVisible ? (
        <div className="model-manager-progress-wrap">
          {installSuccess ? (
            <div className="model-manager-success">{installSuccess}</div>
          ) : installError ? (
            <div className="model-manager-error">
              <span>❌ {installError}</span>
              <button
                type="button"
                className="model-manager-error-dismiss"
                onClick={() => {
                  clearResetTimer();
                  setInstallError(null);
                  setInstallProgress(null);
                }}
              >
                Dismiss
              </button>
            </div>
          ) : installProgress ? (
            <div>
              <div className="model-manager-progress-head">
                <div className="model-manager-progress-label">
                  {installing ? <span className="model-manager-spinner" /> : null}
                  <span>{toPhaseLabel(installProgress.phase)}</span>
                </div>
                <span style={{ color: "#10b981" }}>{installProgress.percent}%</span>
              </div>
              <div
                className="model-manager-progress-track"
                data-testid="model-manager-progress-bar"
              >
                <div
                  className="model-manager-progress-fill"
                  style={{ width: `${installProgress.percent}%` }}
                />
              </div>
              <div className="model-manager-progress-percent">{installProgress.percent}%</div>
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="model-manager-install-button"
          onClick={() => {
            void handleInstall();
          }}
          disabled={searchValue.trim().length === 0 || installing}
        >
          {installing ? (
            <>
              <span className="model-manager-spinner" />
              Installing...
            </>
          ) : (
            "Install"
          )}
        </button>
      )}

      {error ? (
        <div className="model-manager-error" style={{ marginTop: 12 }}>
          <span>❌ {error}</span>
        </div>
      ) : null}
    </section>
  );
}
