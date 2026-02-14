/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivacyDashboard, { formatRelativeTime, formatTokensK } from "./PrivacyDashboard.tsx";

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
  destination: "local" | "cloud" | "hybrid";
  localModel?: string;
  cloudProvider?: string;
  cloudModel?: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  routingReason: string;
};

const defaultStats: PrivacyStats = {
  totalRequests: 3,
  localRequests: 3,
  cloudRequests: 0,
  localPercent: 100,
  daysFullyLocal: 47,
  currentStreak: 47,
  tokensProcessedLocally: 12_450,
  tokensProcessedCloud: 0,
  lastCloudRequest: null,
};

const defaultEntries: RequestAuditEntry[] = [
  {
    id: "1",
    timestamp: "2026-01-14T12:58:00.000Z",
    taskType: "chat",
    promptPreview: "Summarize my notes from this morning standup",
    destination: "local",
    promptTokens: 320,
    completionTokens: 180,
    durationMs: 940,
    routingReason: "local model available",
  },
  {
    id: "2",
    timestamp: "2026-01-14T12:30:00.000Z",
    taskType: "agent",
    promptPreview: "Draft release notes",
    destination: "cloud",
    promptTokens: 500,
    completionTokens: 210,
    durationMs: 1_600,
    routingReason: "vision routing",
  },
  {
    id: "3",
    timestamp: "2026-01-14T11:30:00.000Z",
    taskType: "tool",
    promptPreview: "Run static analysis",
    destination: "hybrid",
    promptTokens: 150,
    completionTokens: 40,
    durationMs: 700,
    routingReason: "fallback",
  },
];

const fetchMock = vi.fn<typeof fetch>();

function makeJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    blob: async () => new Blob([JSON.stringify(payload)], { type: "application/json" }),
  } as Response;
}

function makeCsvResponse(contents: string): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([contents], { type: "text/csv" }),
  } as Response;
}

function installFetchHandler(stats: PrivacyStats, entries: RequestAuditEntry[]) {
  fetchMock.mockImplementation(async (input: URL | RequestInfo) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/privacy/stats")) {
      return makeJsonResponse(stats);
    }
    if (url.includes("/api/privacy/log")) {
      return makeJsonResponse({ entries });
    }
    if (url.includes("/api/privacy/export-csv")) {
      return makeCsvResponse("timestamp,taskType\n");
    }
    return makeJsonResponse({}, 404);
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-14T13:00:00.000Z"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:privacy"),
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PrivacyDashboard", () => {
  it("renders Privacy heading", async () => {
    installFetchHandler(defaultStats, defaultEntries);

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("Privacy")).toBeTruthy();
  });

  it("shows full status pill", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        cloudRequests: 0,
        localPercent: 100,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("privacy-status-pill").textContent).toContain("🟢 All Local");
  });

  it("shows hybrid status pill", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        localRequests: 7,
        cloudRequests: 3,
        totalRequests: 10,
        localPercent: 70,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("privacy-status-pill").textContent).toContain("🟡 Hybrid");
  });

  it("shows cloud-heavy status pill", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        localRequests: 2,
        cloudRequests: 8,
        totalRequests: 10,
        localPercent: 20,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("privacy-status-pill").textContent).toContain("🔴 Cloud Heavy");
  });

  it("shows streak number from API response", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        currentStreak: 12,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("privacy-streak-value").textContent).toBe("12");
  });

  it("shows No active streak when streak is zero", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        currentStreak: 0,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("No active streak")).toBeTruthy();
  });

  it("shows trophy emoji when streak >= 30", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        currentStreak: 30,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("privacy-streak-value").textContent).toContain("🏆 30");
  });

  it("renders data flow diagram with Local Model box", async () => {
    installFetchHandler(defaultStats, defaultEntries);

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("Local Model")).toBeTruthy();
  });

  it("shows cloud row in data flow when cloudRequests > 0", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        cloudRequests: 2,
        totalRequests: 5,
        localRequests: 3,
        localPercent: 60,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("⚠️ Cloud API")).toBeTruthy();
    expect(screen.getByText("2 requests")).toBeTruthy();
  });

  it("renders request log rows with destination labels", async () => {
    installFetchHandler(defaultStats, defaultEntries);

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByTestId("destination-local").textContent).toContain("Local");
    expect(screen.getByTestId("destination-cloud").textContent).toContain("Cloud");
    expect(screen.getByTestId("destination-hybrid").textContent).toContain("Hybrid");
  });

  it("shows empty state when there are no request entries", async () => {
    installFetchHandler(defaultStats, []);

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("No requests recorded yet")).toBeTruthy();
  });

  it("Export CSV triggers fetch to /api/privacy/export-csv", async () => {
    installFetchHandler(defaultStats, defaultEntries);

    render(<PrivacyDashboard />);
    await flushEffects();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await flushEffects();

    const exportCalls = fetchMock.mock.calls.filter((call) => {
      const input = call[0];
      if (typeof input === "string") {
        return input.includes("/api/privacy/export-csv");
      }
      if (input instanceof URL) {
        return input.toString().includes("/api/privacy/export-csv");
      }
      return input.url.includes("/api/privacy/export-csv");
    });
    expect(exportCalls.length).toBe(1);
  });

  it("formatRelativeTime supports expected ranges", () => {
    const nowMs = Date.parse("2026-01-21T12:00:00.000Z");
    expect(formatRelativeTime("2026-01-21T11:59:45.000Z", nowMs)).toBe("just now");
    expect(formatRelativeTime("2026-01-21T11:55:00.000Z", nowMs)).toBe("5m ago");
    expect(formatRelativeTime("2026-01-21T10:00:00.000Z", nowMs)).toBe("2h ago");
    expect(formatRelativeTime("2026-01-18T12:00:00.000Z", nowMs)).toBe("3d ago");
    expect(formatRelativeTime("2026-01-14T08:00:00.000Z", nowMs)).toBe("Jan 14");
  });

  it("formatTokensK formats values", () => {
    expect(formatTokensK(999)).toBe("999");
    expect(formatTokensK(1_000)).toBe("1.0K");
    expect(formatTokensK(1_500)).toBe("1.5K");
    expect(formatTokensK(1_234_567)).toBe("1.2M");
  });

  it("stats row shows Never used cloud when lastCloudRequest is null", async () => {
    installFetchHandler(
      {
        ...defaultStats,
        lastCloudRequest: null,
      },
      defaultEntries,
    );

    render(<PrivacyDashboard />);
    await flushEffects();

    expect(screen.getByText("Never used cloud")).toBeTruthy();
  });

  it("re-fetch fires after 30 seconds", async () => {
    installFetchHandler(defaultStats, defaultEntries);

    render(<PrivacyDashboard />);
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
