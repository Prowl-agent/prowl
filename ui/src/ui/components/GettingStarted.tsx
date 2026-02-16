import React, { useEffect, useMemo, useState } from "react";

const INFERENCE_THRESHOLD = 5;
const POLL_INTERVAL_MS = 30_000;

type SavingsResponse = {
  totalInferences?: unknown;
};

export interface GettingStartedProps {
  apiBase?: string;
}

const EXAMPLES = [
  {
    icon: "📝",
    title: "Write code",
    description: "Generate a function, script, or CLI tool from a description",
    prompt: "Write a TypeScript function that debounces another function with a configurable delay",
  },
  {
    icon: "🔍",
    title: "Explain code",
    description: "Paste code and ask for a clear explanation",
    prompt: "Explain how this code works and suggest improvements",
  },
  {
    icon: "✉️",
    title: "Draft content",
    description: "Emails, docs, commit messages, and more",
    prompt: "Help me draft a professional email announcing a project milestone",
  },
  {
    icon: "🐛",
    title: "Debug an issue",
    description: "Paste an error message and get a fix",
    prompt: "I'm getting this error, help me understand why and fix it:",
  },
];

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export default function GettingStarted({ apiBase = "" }: GettingStartedProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const [inferenceCount, setInferenceCount] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const fetchCount = async () => {
      try {
        const response = await fetch(`${base}/api/savings?period=all-time`, {
          method: "GET",
        });
        if (!response.ok || disposed) {
          return;
        }
        const payload = (await response.json()) as SavingsResponse;
        if (disposed) {
          return;
        }
        const count = typeof payload.totalInferences === "number" ? payload.totalInferences : 0;
        setInferenceCount(count);
      } catch {
        if (!disposed) {
          setInferenceCount(0);
        }
      }
    };

    void fetchCount();
    const intervalId = window.setInterval(() => {
      void fetchCount();
    }, POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [base]);

  // Don't render until we know the count
  if (inferenceCount === null) {
    return null;
  }

  // Auto-hide once user has enough experience, or if manually dismissed
  if (inferenceCount >= INFERENCE_THRESHOLD || dismissed) {
    return null;
  }

  const handleTry = (prompt: string, index: number) => {
    void navigator.clipboard.writeText(prompt).catch(() => {});
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="getting-started-card" data-testid="getting-started">
      <style>{`
        .getting-started-card {
          background: linear-gradient(135deg, #0f172a 0%, #1a2332 100%);
          border: 1px solid #1e293b;
          border-radius: 16px;
          padding: 24px;
          position: relative;
        }
        .getting-started-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .getting-started-title {
          color: #ffffff;
          font-size: 18px;
          font-weight: 700;
          margin: 0;
        }
        .getting-started-dismiss {
          background: none;
          border: none;
          color: #64748b;
          font-size: 18px;
          cursor: pointer;
          padding: 4px;
          line-height: 1;
          border-radius: 6px;
        }
        .getting-started-dismiss:hover {
          color: #94a3b8;
          background: #1e293b;
        }
        .getting-started-subtitle {
          color: #94a3b8;
          font-size: 14px;
          margin: 0 0 16px;
        }
        .getting-started-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }
        .getting-started-example {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 14px;
          cursor: pointer;
          text-align: left;
          color: #f1f5f9;
          width: 100%;
        }
        .getting-started-example:hover {
          border-color: #10b981;
          background: #1a2e3d;
        }
        .getting-started-example-icon {
          font-size: 20px;
          line-height: 1;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .getting-started-example-body {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .getting-started-example-title {
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
        }
        .getting-started-example-desc {
          font-size: 12px;
          color: #94a3b8;
        }
        .getting-started-example-copied {
          font-size: 11px;
          color: #10b981;
          font-weight: 600;
          margin-top: 4px;
        }
        .getting-started-footer {
          margin-top: 12px;
          font-size: 12px;
          color: #475569;
          text-align: center;
        }
        @media (max-width: 700px) {
          .getting-started-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="getting-started-header">
        <h3 className="getting-started-title">Getting Started</h3>
        <button
          className="getting-started-dismiss"
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss getting started"
          data-testid="getting-started-dismiss"
        >
          ×
        </button>
      </div>
      <p className="getting-started-subtitle">
        Click an example to copy it, then paste into your chat
      </p>

      <div className="getting-started-grid">
        {EXAMPLES.map((example, index) => (
          <button
            key={example.title}
            className="getting-started-example"
            type="button"
            onClick={() => handleTry(example.prompt, index)}
            data-testid={`getting-started-example-${index}`}
          >
            <span className="getting-started-example-icon">{example.icon}</span>
            <span className="getting-started-example-body">
              <span className="getting-started-example-title">{example.title}</span>
              <span className="getting-started-example-desc">{example.description}</span>
              {copiedIndex === index ? (
                <span className="getting-started-example-copied">Copied to clipboard!</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <div className="getting-started-footer">
        This card hides automatically after {INFERENCE_THRESHOLD} messages
      </div>
    </div>
  );
}
