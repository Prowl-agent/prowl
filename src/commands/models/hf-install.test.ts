import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  installFromHuggingFace: vi.fn(),
}));

vi.mock("../../../packages/core/src/models/hf-bridge.js", () => ({
  installFromHuggingFace: mocks.installFromHuggingFace,
}));

import { modelsHfInstallCommand } from "./hf-install.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

describe("modelsHfInstallCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes install flow and prints summary on success", async () => {
    mocks.installFromHuggingFace.mockImplementation(async (_repoId, _ram, onProgress) => {
      onProgress({
        phase: "downloading",
        bytesDownloaded: 50,
        totalBytes: 100,
        percentComplete: 50,
        speedMBps: 10,
        etaSeconds: 5,
        message: "Downloading model",
      });

      return {
        success: true,
        ollamaModelName: "hf-qwen3-8b-q4km",
        modelPath: "/tmp/model.gguf",
        benchmarkResult: {
          tokensPerSecond: 12.34,
          firstTokenMs: 345.67,
          passed: true,
        },
      };
    });

    const runtime = createRuntime();
    await modelsHfInstallCommand("bartowski/Qwen3-8B-GGUF", { ram: "16" }, runtime);

    expect(mocks.installFromHuggingFace).toHaveBeenCalledWith(
      "bartowski/Qwen3-8B-GGUF",
      16,
      expect.any(Function),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Installed as hf-qwen3-8b-q4km"),
    );
  });

  it("throws when install fails", async () => {
    mocks.installFromHuggingFace.mockResolvedValue({
      success: false,
      ollamaModelName: "",
      modelPath: "",
      error: "OLLAMA_NOT_RUNNING",
    });

    const runtime = createRuntime();
    await expect(
      modelsHfInstallCommand("bartowski/Qwen3-8B-GGUF", { ram: "16" }, runtime),
    ).rejects.toThrow("OLLAMA_NOT_RUNNING");
  });

  it("throws on invalid repo id", async () => {
    const runtime = createRuntime();
    await expect(modelsHfInstallCommand("qwen3-8b", { ram: "16" }, runtime)).rejects.toThrow(
      "Repository id must look like <owner>/<repo>.",
    );
  });

  it("throws on invalid ram value", async () => {
    const runtime = createRuntime();
    await expect(
      modelsHfInstallCommand("bartowski/Qwen3-8B-GGUF", { ram: "0" }, runtime),
    ).rejects.toThrow("--ram must be a positive number in GB.");
  });
});
