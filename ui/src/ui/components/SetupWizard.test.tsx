/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupWizard, { type SetupRecommendation } from "./SetupWizard.tsx";

const fetchMock = vi.fn<typeof fetch>();

const recommendation: SetupRecommendation = {
  model: "qwen3:8b",
  displayName: "Qwen3 8B",
  quality: "good",
  reason: "Best balance for most hardware",
  sizeGB: 9,
};

function makeJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function createControlledPullResponse() {
  const encoder = new TextEncoder();
  const queue: Array<ReadableStreamReadResult<Uint8Array>> = [];
  const waiters: Array<(value: ReadableStreamReadResult<Uint8Array>) => void> = [];

  const deliver = (value: ReadableStreamReadResult<Uint8Array>) => {
    const next = waiters.shift();
    if (next) {
      next(value);
      return;
    }
    queue.push(value);
  };

  const reader = {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      const queued = queue.shift();
      if (queued) {
        return queued;
      }
      return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        waiters.push(resolve);
      });
    },
    cancel: async () => undefined,
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => reader,
    } as ReadableStream<Uint8Array>,
  } as Response;

  return {
    response,
    pushLine(line: Record<string, unknown>) {
      deliver({
        done: false,
        value: encoder.encode(`${JSON.stringify(line)}\n`),
      });
    },
    close() {
      deliver({
        done: true,
        value: undefined,
      });
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupWizard", () => {
  it("does not render when isFirstRun is false", () => {
    render(
      <SetupWizard
        isFirstRun={false}
        hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
        recommendation={recommendation}
        onComplete={() => undefined}
      />,
    );

    expect(screen.queryByTestId("setup-wizard")).toBeNull();
  });

  it("renders step 1 and shows hardware profile", () => {
    render(
      <SetupWizard
        isFirstRun={true}
        hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
        recommendation={recommendation}
        onComplete={() => undefined}
      />,
    );

    expect(screen.getByText("Your Hardware")).toBeTruthy();
    expect(
      screen.getByText("Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"),
    ).toBeTruthy();
  });

  it("Continue advances to step 2 and shows recommendation", () => {
    render(
      <SetupWizard
        isFirstRun={true}
        hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
        recommendation={recommendation}
        onComplete={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));

    expect(screen.getByText("Recommended Model")).toBeTruthy();
    expect(screen.getByText("Qwen3 8B")).toBeTruthy();
    expect(screen.getByText("9GB download")).toBeTruthy();
    expect(screen.getByText("Best balance for most hardware")).toBeTruthy();
  });

  it("Install & Continue triggers pull API, shows progress, and advances to step 3 on complete", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: [] }))
      .mockResolvedValueOnce(pull.response)
      .mockResolvedValueOnce(
        makeJsonResponse({ success: true, activeModel: recommendation.model }),
      );

    render(
      <SetupWizard
        isFirstRun={true}
        hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
        recommendation={recommendation}
        onComplete={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    fireEvent.click(screen.getByRole("button", { name: "Install & Continue →" }));
    await flushEffects();

    const pullCall = fetchMock.mock.calls[1];
    const pullUrl = pullCall?.[0] as string;
    const pullInit = pullCall?.[1] as RequestInit;
    expect(pullUrl).toContain("/api/models/pull");
    expect(pullInit?.method).toBe("POST");

    pull.pushLine({
      status: "pulling",
      model: recommendation.model,
      percentComplete: 52,
      message: "Pulling model...",
    });
    await flushEffects();

    expect(screen.getByTestId("setup-wizard-progress")).toBeTruthy();
    expect(screen.getByText("52%")).toBeTruthy();

    pull.pushLine({
      status: "complete",
      model: recommendation.model,
      percentComplete: 100,
      message: "Download complete",
    });
    pull.close();
    await flushEffects();
    await flushEffects();

    expect(screen.getByText("Connect a Messaging App")).toBeTruthy();
  });

  it("Skip for now advances to welcome panel 1 (local agent info)", async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: [{ name: recommendation.model }] }))
      .mockResolvedValueOnce(
        makeJsonResponse({ success: true, activeModel: recommendation.model }),
      );

    render(
      <SetupWizard
        isFirstRun={true}
        hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
        recommendation={recommendation}
        onComplete={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    fireEvent.click(screen.getByRole("button", { name: "Install & Continue →" }));
    await flushEffects();

    expect(screen.getByText("Connect a Messaging App")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now →" }));
    expect(screen.getByText("Your AI agent is running locally")).toBeTruthy();
    expect(screen.getByText("Apple M4 Pro")).toBeTruthy();
  });

  it("welcome panels advance: local → try it → savings → dismiss", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <SetupWizard
          isFirstRun={open}
          hardwareProfile="Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1"
          recommendation={recommendation}
          onComplete={() => setOpen(false)}
        />
      );
    }

    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: [{ name: recommendation.model }] }))
      .mockResolvedValueOnce(
        makeJsonResponse({ success: true, activeModel: recommendation.model }),
      );

    render(<Harness />);

    // Advance through setup steps
    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    fireEvent.click(screen.getByRole("button", { name: "Install & Continue →" }));
    await flushEffects();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now →" }));

    // Welcome panel 1: local agent
    expect(screen.getByText("Your AI agent is running locally")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));

    // Welcome panel 2: try it out
    expect(screen.getByText("Try it out")).toBeTruthy();
    expect(screen.getByTestId("welcome-prompts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip →" }));

    // Welcome panel 3: savings
    expect(screen.getByText("You're saving money")).toBeTruthy();
    expect(screen.getByTestId("welcome-savings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Dashboard →" }));

    // Wizard dismissed
    expect(screen.queryByTestId("setup-wizard")).toBeNull();
  });
});
