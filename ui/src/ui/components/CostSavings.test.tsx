/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CostSavings, { formatTokens } from "./CostSavings.tsx";

type SavingsReport = {
  period: string;
  totalInferences: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  localCostUSD: number;
  cloudEquivalents: Array<{
    provider: string;
    model: string;
    estimatedCostUSD: number;
    savingsUSD: number;
  }>;
  bestSavingsUSD: number;
  bestSavingsProvider: string;
  avgTokensPerSecond: number;
  totalDurationMs: number;
};

const baseReport: SavingsReport = {
  period: "day",
  totalInferences: 42,
  totalPromptTokens: 15_000,
  totalCompletionTokens: 8_000,
  totalTokens: 23_000,
  localCostUSD: 0,
  cloudEquivalents: [
    {
      provider: "openai",
      model: "gpt-4o",
      estimatedCostUSD: 47.23,
      savingsUSD: 47.23,
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      estimatedCostUSD: 39.19,
      savingsUSD: 39.19,
    },
  ],
  bestSavingsUSD: 47.23,
  bestSavingsProvider: "openai gpt-4o",
  avgTokensPerSecond: 83.1,
  totalDurationMs: 16_320,
};

const fetchMock = vi.fn<typeof fetch>();

function fetchCallUrl(index: number): string {
  const input = fetchMock.mock.calls[index]?.[0];
  if (!input) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return "";
}

function makeResponse(payload: SavingsReport, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

async function runAnimation(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1_300);
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);

  let rafId = 0;
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
  vi.stubGlobal("requestAnimationFrame", ((callback: FrameRequestCallback): number => {
    const id = ++rafId;
    const timer = setTimeout(() => callback(performance.now()), 16);
    rafTimers.set(id, timer);
    return id;
  }) as typeof requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", ((id: number) => {
    const timer = rafTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      rafTimers.delete(id);
    }
  }) as typeof cancelAnimationFrame);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CostSavings", () => {
  it("renders loading skeleton on mount before fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<CostSavings />);

    expect(screen.getByTestId("cost-savings-loading")).toBeTruthy();
    expect(screen.getByTestId("cost-savings-skeleton-value")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders dollar amount after successful fetch", async () => {
    fetchMock.mockResolvedValue(makeResponse(baseReport));

    render(<CostSavings />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushEffects();
    await runAnimation();

    expect(screen.getByTestId("cost-savings-value").textContent).toBe("$47.23");
  });

  it("renders $-.-- on fetch error", async () => {
    fetchMock.mockRejectedValue(new Error("network failed"));

    render(<CostSavings />);

    await flushEffects();
    expect(screen.getByText("Unable to load savings data")).toBeTruthy();
    expect(screen.getByText("$-.--")).toBeTruthy();
  });

  it("renders $0.00 with Start chatting text when bestSavingsUSD is 0", async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        ...baseReport,
        totalInferences: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        bestSavingsUSD: 0,
      }),
    );

    render(<CostSavings />);
    await flushEffects();
    await runAnimation();

    expect(screen.getByTestId("cost-savings-value").textContent).toBe("$0.00");
    expect(screen.getByText("Start chatting to track savings")).toBeTruthy();
  });

  it("tab switch triggers new fetch with correct period param", async () => {
    fetchMock.mockResolvedValue(makeResponse(baseReport));

    render(<CostSavings />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushEffects();
    expect(fetchCallUrl(0)).toContain("period=day");

    fireEvent.click(screen.getByRole("button", { name: "This Month" }));
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCallUrl(1)).toContain("period=month");
  });

  it("tab switch re-triggers count-up animation", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({
          ...baseReport,
          period: "day",
          bestSavingsUSD: 10,
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          ...baseReport,
          period: "month",
          bestSavingsUSD: 20,
        }),
      );

    render(<CostSavings />);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flushEffects();
    await runAnimation();

    const value = screen.getByTestId("cost-savings-value");
    expect(value.textContent).toBe("$10.00");

    fireEvent.click(screen.getByRole("button", { name: "This Month" }));
    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(value.textContent).toBe("$10.00");

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(value.textContent).not.toBe("$10.00");
    expect(value.textContent).not.toBe("$20.00");

    await runAnimation();
    expect(value.textContent).toBe("$20.00");
  });

  it("formatTokens compacts values", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});
