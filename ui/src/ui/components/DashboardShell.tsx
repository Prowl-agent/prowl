import React, { useEffect, useMemo, useState } from "react";
import AppShell from "./AppShell.tsx";
import CostSavings from "./CostSavings.tsx";
import ModelManager from "./ModelManager.tsx";
import PrivacyDashboard from "./PrivacyDashboard.tsx";
import SetupWizard, { type SetupRecommendation } from "./SetupWizard.tsx";

type SetupStatusResponse = {
  isFirstRun?: unknown;
  hardwareProfile?: unknown;
  recommendation?: {
    model?: unknown;
    displayName?: unknown;
    quality?: unknown;
    reason?: unknown;
    sizeGB?: unknown;
  };
};

export interface DashboardShellProps {
  apiBase?: string;
}

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toRecommendation(
  value: SetupStatusResponse["recommendation"],
): SetupRecommendation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const model = typeof value.model === "string" ? value.model.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const quality =
    value.quality === "basic" ||
    value.quality === "good" ||
    value.quality === "great" ||
    value.quality === "excellent"
      ? value.quality
      : null;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const sizeGB =
    typeof value.sizeGB === "number" && Number.isFinite(value.sizeGB) ? value.sizeGB : 0;

  if (!model || !displayName || !quality) {
    return null;
  }

  return {
    model,
    displayName,
    quality,
    reason,
    sizeGB,
  };
}

export default function DashboardShell({ apiBase = "" }: DashboardShellProps) {
  const base = useMemo(() => normalizeApiBase(apiBase), [apiBase]);
  const [setupStatus, setSetupStatus] = useState<{
    isFirstRun: boolean;
    hardwareProfile: string;
    recommendation: SetupRecommendation | null;
  }>({
    isFirstRun: false,
    hardwareProfile: "",
    recommendation: null,
  });
  const [wizardDismissed, setWizardDismissed] = useState(false);

  useEffect(() => {
    let disposed = false;

    const loadSetupStatus = async () => {
      try {
        const response = await fetch(`${base}/api/setup/status`, {
          method: "GET",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as SetupStatusResponse;
        if (disposed) {
          return;
        }

        setSetupStatus({
          isFirstRun: payload.isFirstRun === true,
          hardwareProfile:
            typeof payload.hardwareProfile === "string"
              ? payload.hardwareProfile
              : "Unknown hardware",
          recommendation: toRecommendation(payload.recommendation),
        });
      } catch {
        if (disposed) {
          return;
        }
        setSetupStatus({
          isFirstRun: false,
          hardwareProfile: "Unknown hardware",
          recommendation: null,
        });
      }
    };

    void loadSetupStatus();

    return () => {
      disposed = true;
    };
  }, [base]);

  const showWizard =
    setupStatus.isFirstRun && !wizardDismissed && setupStatus.recommendation !== null;

  return (
    <>
      <style>{`
        .dashboard-grid {
          width: 100%;
          display: grid;
          gap: 24px;
        }
        .dashboard-grid-middle {
          display: grid;
          grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 1024px) {
          .dashboard-grid-middle {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <AppShell apiBase={base}>
        <div className="dashboard-grid">
          <CostSavings apiBase={base} />
          <div className="dashboard-grid-middle">
            <ModelManager apiBase={base} />
            <PrivacyDashboard apiBase={base} />
          </div>
        </div>
      </AppShell>

      <SetupWizard
        isFirstRun={showWizard}
        hardwareProfile={setupStatus.hardwareProfile}
        recommendation={setupStatus.recommendation}
        apiBase={base}
        onComplete={() => {
          setWizardDismissed(true);
        }}
      />
    </>
  );
}
