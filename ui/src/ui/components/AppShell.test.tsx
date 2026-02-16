/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppShell from "./AppShell.tsx";

const fetchMock = vi.fn<typeof fetch>();

function makeJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("renders header brand text", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: true });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "qwen3:8b" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("🐾 Prowl")).toBeTruthy();
  });

  it("shows healthy state when ollama running with model loaded", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: true });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "qwen3:8b" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("Ollama running, model loaded")).toBeTruthy();
    const statusEl = screen.getByTestId("app-shell-ollama-status");
    expect(statusEl.getAttribute("data-health")).toBe("healthy");
  });

  it("shows stopped state when ollama is not running", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: false });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("Ollama not running")).toBeTruthy();
    const statusEl = screen.getByTestId("app-shell-ollama-status");
    expect(statusEl.getAttribute("data-health")).toBe("stopped");
  });

  it("shows no-model state when ollama running but no model active", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: true });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("Ollama running, no model loaded")).toBeTruthy();
    const statusEl = screen.getByTestId("app-shell-ollama-status");
    expect(statusEl.getAttribute("data-health")).toBe("no-model");
  });

  it("shows tooltip with helpful message on click", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: false });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();

    const statusEl = screen.getByTestId("app-shell-ollama-status");
    fireEvent.click(statusEl);

    expect(screen.getByTestId("health-tooltip")).toBeTruthy();
    expect(screen.getByText("Ollama is not running")).toBeTruthy();
    expect(screen.getByText("ollama serve")).toBeTruthy();
  });

  it("shows active model name from /api/models/active", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        return makeJsonResponse({ status: "ok", ollamaRunning: true });
      }
      if (url.includes("/api/models/active")) {
        return makeJsonResponse({ model: "qwen2.5-coder:14b" });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("qwen2.5-coder:14b")).toBeTruthy();
  });

  it("refreshes header state after 30 seconds", async () => {
    let pollRound = 0;
    fetchMock.mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/health")) {
        const running = pollRound === 0;
        return makeJsonResponse({ status: "ok", ollamaRunning: running });
      }
      if (url.includes("/api/models/active")) {
        const model = pollRound === 0 ? "qwen3:8b" : "qwen3:4b";
        pollRound += 1;
        return makeJsonResponse({ model });
      }
      return makeJsonResponse({}, 404);
    });

    render(
      <AppShell>
        <div>dashboard</div>
      </AppShell>,
    );

    await flushEffects();
    expect(screen.getByText("Ollama running, model loaded")).toBeTruthy();
    expect(screen.getByText("qwen3:8b")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushEffects();

    expect(screen.getByText("Ollama not running")).toBeTruthy();
    expect(screen.getByText("qwen3:4b")).toBeTruthy();
  });
});
