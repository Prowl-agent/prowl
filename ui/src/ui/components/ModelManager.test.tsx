/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelManager from "./ModelManager.tsx";

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

type PullLine = Record<string, unknown>;

const baseModels: InstalledModel[] = [
  {
    name: "qwen3:8b",
    displayName: "Qwen3 8B",
    sizeGB: 8.9,
    modifiedAt: "",
    isActive: true,
    details: {
      family: "qwen3",
      parameterSize: "8B",
      quantizationLevel: "Q4_K_M",
    },
  },
  {
    name: "qwen3:4b",
    displayName: "Qwen3 4B",
    sizeGB: 4.8,
    modifiedAt: "",
    isActive: false,
    details: {
      family: "qwen3",
      parameterSize: "4B",
      quantizationLevel: "Q4_K_M",
    },
  },
];

const switchedModels: InstalledModel[] = [
  {
    ...baseModels[0],
    isActive: false,
  },
  {
    ...baseModels[1],
    isActive: true,
  },
];

const fetchMock = vi.fn<typeof fetch>();

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
    pushLine(line: PullLine) {
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

describe("ModelManager", () => {
  it("renders Model Manager heading", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    expect(screen.getByText("Model Manager")).toBeTruthy();
  });

  it("shows active model name from API response", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    expect(screen.getByTestId("active-model-name").textContent).toBe("Qwen3 8B");
  });

  it("shows installed models list", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("Qwen3 4B")).toBeTruthy();
  });

  it("disables switch button for active model", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    const activeSwitch = screen.getByTestId("switch-qwen3-8b");
    expect(activeSwitch.disabled).toBe(true);
  });

  it("calls POST /api/models/switch when switch is clicked", async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, activeModel: "qwen3:4b" }))
      .mockResolvedValueOnce(makeJsonResponse({ models: switchedModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("switch-qwen3-4b"));
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const switchCall = fetchMock.mock.calls[1];
    const url = switchCall?.[0] as string;
    const init = switchCall?.[1] as RequestInit;
    expect(url).toContain("/api/models/switch");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ tag: "qwen3:4b" }));
  });

  it("shows confirmation row when delete is clicked", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("delete-qwen3-4b"));
    expect(screen.getByText("Delete Qwen3 4B?")).toBeTruthy();
  });

  it("calls DELETE /api/models/:tag on confirm delete", async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }))
      .mockResolvedValueOnce(makeJsonResponse({ models: [baseModels[0]], ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("delete-qwen3-4b"));
    fireEvent.click(screen.getByTestId("confirm-delete-qwen3-4b"));
    await flushEffects();

    const deleteCall = fetchMock.mock.calls[1];
    const url = deleteCall?.[0] as string;
    const init = deleteCall?.[1] as RequestInit;
    expect(url).toContain("/api/models/qwen3%3A4b");
    expect(init?.method).toBe("DELETE");
  });

  it("hides confirmation row on cancel delete", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("delete-qwen3-4b"));
    expect(screen.getByText("Delete Qwen3 4B?")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cancel-delete-qwen3-4b"));
    expect(screen.queryByText("Delete Qwen3 4B?")).toBeNull();
  });

  it("triggers POST /api/models/pull when install is clicked", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(pull.response);

    render(<ModelManager />);
    await flushEffects();

    const input = screen.getByPlaceholderText("Search HuggingFace or enter Ollama tag...");
    fireEvent.change(input, { target: { value: "qwen3:8b" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await flushEffects();

    const pullCall = fetchMock.mock.calls[1];
    const url = pullCall?.[0] as string;
    const init = pullCall?.[1] as RequestInit;
    expect(url).toContain("/api/models/pull");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ tag: "qwen3:8b" }));

    pull.pushLine({ status: "error", model: "qwen3:8b", message: "stop" });
    pull.close();
    await flushEffects();
  });

  it("shows progress bar during install", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(pull.response);

    render(<ModelManager />);
    await flushEffects();

    fireEvent.change(screen.getByTestId("install-search-input"), {
      target: { value: "qwen3:8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await flushEffects();

    expect(screen.getByTestId("model-manager-progress-bar")).toBeTruthy();

    pull.pushLine({ status: "error", model: "qwen3:8b", message: "stop" });
    pull.close();
    await flushEffects();
  });

  it("updates progress values from streamed lines", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(pull.response);

    render(<ModelManager />);
    await flushEffects();

    fireEvent.change(screen.getByTestId("install-search-input"), {
      target: { value: "qwen3:8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await flushEffects();

    pull.pushLine({
      status: "pulling",
      model: "qwen3:8b",
      percentComplete: 47,
      message: "Pulling model...",
    });
    await flushEffects();

    expect(screen.getAllByText("47%").length).toBeGreaterThan(0);

    pull.pushLine({ status: "error", model: "qwen3:8b", message: "stop" });
    pull.close();
    await flushEffects();
  });

  it("shows complete state success message", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(pull.response)
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.change(screen.getByTestId("install-search-input"), {
      target: { value: "qwen3:8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await flushEffects();

    pull.pushLine({
      status: "pulling",
      model: "qwen3:8b",
      percentComplete: 64,
      message: "Pulling model...",
    });
    pull.pushLine({
      status: "complete",
      model: "qwen3:8b",
      percentComplete: 100,
      message: "Download complete",
    });
    pull.close();
    await flushEffects();
    await flushEffects();

    expect(screen.getByText("✅ qwen3:8b ready")).toBeTruthy();
  });

  it("shows error state message", async () => {
    const pull = createControlledPullResponse();
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ models: baseModels, ollamaRunning: true }))
      .mockResolvedValueOnce(pull.response);

    render(<ModelManager />);
    await flushEffects();

    fireEvent.change(screen.getByTestId("install-search-input"), {
      target: { value: "qwen3:8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await flushEffects();

    pull.pushLine({
      status: "error",
      model: "qwen3:8b",
      message: "disk full",
    });
    pull.close();
    await flushEffects();

    expect(screen.getByText(/❌ disk full/)).toBeTruthy();
  });

  it("fills search input from quick-pick chip click", async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ models: baseModels, ollamaRunning: true }));

    render(<ModelManager />);
    await flushEffects();

    fireEvent.click(screen.getByTestId("chip-qwen3-4b"));

    const input = screen.getByTestId("install-search-input");
    expect(input.value).toBe("qwen3:4b");
  });
});
