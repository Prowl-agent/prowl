import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareProfile } from "./hardware-detect.js";
import type { ModelRecommendation } from "./model-recommend.js";

const {
  detectHardwareMock,
  formatProfileMock,
  recommendModelMock,
  execaMock,
  fsMkdirMock,
  fsWriteFileMock,
  fsReadFileMock,
  fsReadFileSyncMock,
} = vi.hoisted(() => ({
  detectHardwareMock: vi.fn(),
  formatProfileMock: vi.fn(),
  recommendModelMock: vi.fn(),
  execaMock: vi.fn(),
  fsMkdirMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  fsReadFileMock: vi.fn(),
  fsReadFileSyncMock: vi.fn(),
}));

vi.mock("./hardware-detect.js", () => ({
  detectHardware: detectHardwareMock,
  formatProfile: formatProfileMock,
}));

vi.mock("./model-recommend.js", () => ({
  recommendModel: recommendModelMock,
}));

vi.mock("execa", () => ({
  execa: execaMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: fsMkdirMock,
    writeFile: fsWriteFileMock,
    readFile: fsReadFileMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: fsReadFileSyncMock,
}));

import {
  isOllamaRunning,
  listInstalledModels,
  readProwlConfig,
  runInstaller,
  type InstallerProgress,
  type ProwlConfig,
} from "./installer.js";

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: "linux",
    arch: "x64",
    totalRAMGB: 32,
    unifiedMemoryGB: 0,
    gpuVRAMGB: 0,
    gpu: {
      vendor: "unknown",
      name: "Test GPU",
      vramGB: 0,
      isAppleSilicon: false,
    },
    cpuCores: 8,
    cpuModel: "Test CPU",
    isAppleSilicon: false,
    availableForModelGB: 12,
    ollamaInstalled: true,
    ollamaVersion: "0.9.1",
    prowlDataDir: "/tmp/.prowl/models",
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<ModelRecommendation> = {}): ModelRecommendation {
  return {
    model: "qwen3:8b",
    displayName: "Qwen3 8B",
    quality: "good",
    estimatedSpeed: "15-20 tok/s",
    sizeGB: 9,
    reason: "Best balance for most hardware",
    source: "ollama",
    ollamaTag: "qwen3:8b",
    ...overrides,
  };
}

function makeTextResponse(status: number, body = "ok"): Response {
  return new Response(body, { status });
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runInstaller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    detectHardwareMock.mockReset();
    formatProfileMock.mockReset();
    recommendModelMock.mockReset();
    execaMock.mockReset();
    fsMkdirMock.mockReset();
    fsWriteFileMock.mockReset();
    fsReadFileMock.mockReset();
    fsReadFileSyncMock.mockReset();

    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Test GPU · 32GB RAM · x64 · Linux · Ollama 0.9.1");
    recommendModelMock.mockReturnValue(makeRecommendation());
    fsMkdirMock.mockResolvedValue(undefined);
    fsWriteFileMock.mockResolvedValue(undefined);
    fsReadFileMock.mockResolvedValue(JSON.stringify({ version: "2026.2.13" }));
  });

  it("completes happy path when Ollama is running and model is already present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeJsonResponse(200, { models: [{ name: "qwen3:8b" }] }))
      .mockResolvedValueOnce(makeJsonResponse(200, { response: "PROWL_READY" }));

    const progressEvents: InstallerProgress[] = [];
    const result = await runInstaller({
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result.success).toBe(true);
    expect(result.modelWasAlreadyPresent).toBe(true);
    expect(result.ollamaWasInstalled).toBe(false);
    expect(result.totalTimeMs).toBeLessThan(1_000);
    expect(progressEvents.at(-1)?.phase).toBe("complete");
    expect(fsWriteFileMock).toHaveBeenCalledOnce();
  });

  it("starts Ollama service when installed but not running", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(503))
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeJsonResponse(200, { models: [{ name: "qwen3:8b" }] }))
      .mockResolvedValueOnce(makeJsonResponse(200, { response: "PROWL_READY" }));

    execaMock.mockImplementation((command: string, args: string[]) => {
      if (command === "ollama" && args[0] === "serve") {
        return { unref: vi.fn() };
      }
      return { stdout: "" };
    });

    const result = await runInstaller();

    expect(result.success).toBe(true);
    expect(execaMock).toHaveBeenCalledWith("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
    });
  });

  it("pulls missing model and emits pull progress", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockResolvedValueOnce(makeJsonResponse(200, { models: [] }))
      .mockResolvedValueOnce(makeJsonResponse(200, { response: "PROWL_READY" }));

    execaMock.mockImplementation((command: string, args: string[]) => {
      if (command === "ollama" && args[0] === "pull") {
        const stdout = ["pulling manifest 10%", "pulling layer 70%", "pulling layer 100%"].join(
          "\n",
        );
        return { stdout, all: stdout };
      }
      return { stdout: "" };
    });

    const progressEvents: InstallerProgress[] = [];
    const result = await runInstaller({
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result.success).toBe(true);
    expect(execaMock).toHaveBeenCalledWith("ollama", ["pull", "qwen3:8b"], { all: true });
    expect(
      progressEvents.some(
        (progress) => progress.phase === "pulling-model" && progress.percentComplete > 50,
      ),
    ).toBe(true);
  });

  it("fails immediately when available model memory is below 4GB", async () => {
    detectHardwareMock.mockResolvedValue(
      makeProfile({
        availableForModelGB: 3.5,
      }),
    );

    const result = await runInstaller();

    expect(result.success).toBe(false);
    expect(result.error).toContain("At least 4GB is required");
  });

  it("skips pull and verify phases when skipModelPull is true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(makeTextResponse(200));

    const progressEvents: InstallerProgress[] = [];
    const result = await runInstaller({
      skipModelPull: true,
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(result.success).toBe(true);
    expect(progressEvents.some((progress) => progress.phase === "pulling-model")).toBe(false);
    expect(progressEvents.some((progress) => progress.phase === "verifying")).toBe(false);
  });

  it("uses forceModel override without calling recommendModel", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(makeTextResponse(200));

    recommendModelMock.mockImplementation(() => {
      throw new Error("recommendModel should not be called");
    });

    const result = await runInstaller({
      forceModel: "qwen3:4b",
      skipModelPull: true,
    });

    expect(result.success).toBe(true);
    expect(result.recommendation.model).toBe("qwen3:4b");
    expect(result.recommendation.ollamaTag).toBe("qwen3:4b");
  });
});

describe("isOllamaRunning", () => {
  it("returns true on HTTP 200 and false on request failure", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(200))
      .mockRejectedValueOnce(new Error("offline"));

    await expect(isOllamaRunning()).resolves.toBe(true);
    await expect(isOllamaRunning()).resolves.toBe(false);
  });
});

describe("listInstalledModels", () => {
  it("parses model names from Ollama tags response", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(makeTextResponse(200)).mockResolvedValueOnce(
      makeJsonResponse(200, {
        models: [{ name: "qwen3:8b" }, { name: "qwen3:4b" }, { name: 5 }],
      }),
    );

    await expect(listInstalledModels()).resolves.toEqual(["qwen3:8b", "qwen3:4b"]);
  });
});

describe("readProwlConfig", () => {
  it("returns null for missing config and parses a valid config", () => {
    fsReadFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    expect(readProwlConfig()).toBeNull();

    const expected: ProwlConfig = {
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
      installedAt: "2026-02-14T12:00:00.000Z",
      hardwareProfile: "Test GPU · 32GB RAM · x64 · Linux · Ollama 0.9.1",
      prowlVersion: "2026.2.13",
    };
    fsReadFileSyncMock.mockReturnValueOnce(JSON.stringify(expected));

    expect(readProwlConfig()).toEqual(expected);
  });
});
