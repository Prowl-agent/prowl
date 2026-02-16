import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareProfile } from "./hardware-detect.js";

const {
  detectHardwareMock,
  formatProfileMock,
  recommendModelMock,
  readProwlConfigMock,
  isOllamaRunningMock,
  listInstalledModelsMock,
  startOllamaServiceMock,
  fsMkdirMock,
  fsWriteFileMock,
  fsReadFileMock,
  execFileMock,
} = vi.hoisted(() => ({
  detectHardwareMock: vi.fn(),
  formatProfileMock: vi.fn(),
  recommendModelMock: vi.fn(),
  readProwlConfigMock: vi.fn(),
  isOllamaRunningMock: vi.fn(),
  listInstalledModelsMock: vi.fn(),
  startOllamaServiceMock: vi.fn(),
  fsMkdirMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  fsReadFileMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("./hardware-detect.js", () => ({
  detectHardware: detectHardwareMock,
  formatProfile: formatProfileMock,
}));

vi.mock("./model-recommend.js", () => ({
  recommendModel: recommendModelMock,
}));

vi.mock("./installer.js", () => ({
  readProwlConfig: readProwlConfigMock,
  isOllamaRunning: isOllamaRunningMock,
  listInstalledModels: listInstalledModelsMock,
  startOllamaService: startOllamaServiceMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: fsMkdirMock,
    writeFile: fsWriteFileMock,
    readFile: fsReadFileMock,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import type { ModelRecommendation } from "./model-recommend.js";
import { resolveAutoModel, resolveAutoModelSync } from "./auto-model.js";

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: "macos",
    arch: "arm64",
    totalRAMGB: 36,
    unifiedMemoryGB: 36,
    gpuVRAMGB: 0,
    gpu: {
      vendor: "apple",
      name: "Apple M3 Pro",
      vramGB: 0,
      isAppleSilicon: true,
    },
    cpuCores: 12,
    cpuModel: "Apple M3 Pro",
    isAppleSilicon: true,
    availableForModelGB: 30,
    ollamaInstalled: true,
    ollamaVersion: "0.9.1",
    prowlDataDir: "/tmp/.prowl/models",
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<ModelRecommendation> = {}): ModelRecommendation {
  return {
    model: "qwen3:32b",
    displayName: "Qwen3 32B",
    quality: "excellent",
    estimatedSpeed: "8-12 tok/s",
    sizeGB: 36,
    reason: "Full power for complex autonomous tasks",
    source: "ollama",
    ollamaTag: "qwen3:32b",
    ...overrides,
  };
}

describe("resolveAutoModelSync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    readProwlConfigMock.mockReset();
  });

  it("returns saved model from config", () => {
    readProwlConfigMock.mockReturnValue({
      model: "qwen3:32b",
      ollamaUrl: "http://localhost:11434",
      installedAt: "2026-02-16T00:00:00.000Z",
      hardwareProfile: "Apple M3 Pro · 36GB unified",
      prowlVersion: "2026.2.16",
    });

    const result = resolveAutoModelSync();

    expect(result.model).toBe("qwen3:32b");
    expect(result.provider).toBe("ollama");
  });

  it("falls back to qwen3:8b when no config exists", () => {
    readProwlConfigMock.mockReturnValue(null);

    const result = resolveAutoModelSync();

    expect(result.model).toBe("qwen3:8b");
    expect(result.provider).toBe("ollama");
  });
});

describe("resolveAutoModel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    readProwlConfigMock.mockReset();
    detectHardwareMock.mockReset();
    formatProfileMock.mockReset();
    recommendModelMock.mockReset();
    isOllamaRunningMock.mockReset();
    listInstalledModelsMock.mockReset();
    startOllamaServiceMock.mockReset();
    fsMkdirMock.mockReset();
    fsWriteFileMock.mockReset();
    fsReadFileMock.mockReset();
    execFileMock.mockReset();

    fsMkdirMock.mockResolvedValue(undefined);
    fsWriteFileMock.mockResolvedValue(undefined);
    fsReadFileMock.mockResolvedValue(JSON.stringify({ version: "2026.2.16" }));
  });

  it("returns saved config without hardware detection when config exists", async () => {
    readProwlConfigMock.mockReturnValue({
      model: "qwen3:32b",
      ollamaUrl: "http://localhost:11434",
      installedAt: "2026-02-16T00:00:00.000Z",
      hardwareProfile: "Apple M3 Pro · 36GB unified",
      prowlVersion: "2026.2.16",
    });

    const result = await resolveAutoModel();

    expect(result.source).toBe("config");
    expect(result.model).toBe("qwen3:32b");
    expect(result.provider).toBe("ollama");
    expect(detectHardwareMock).not.toHaveBeenCalled();
  });

  it("detects hardware and recommends model on first run", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Apple M3 Pro · 36GB unified · arm64 · macOS · Ollama 0.9.1");
    recommendModelMock.mockReturnValue(makeRecommendation());
    isOllamaRunningMock.mockResolvedValue(true);
    listInstalledModelsMock.mockResolvedValue(["qwen3:32b"]);

    const result = await resolveAutoModel();

    expect(result.source).toBe("auto-detected");
    expect(result.model).toBe("qwen3:32b");
    expect(result.recommendation?.quality).toBe("excellent");
    expect(result.profile?.isAppleSilicon).toBe(true);
    expect(detectHardwareMock).toHaveBeenCalledOnce();
    expect(recommendModelMock).toHaveBeenCalledOnce();
  });

  it("saves config after auto-detection", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Apple M3 Pro · 36GB unified");
    recommendModelMock.mockReturnValue(makeRecommendation());
    isOllamaRunningMock.mockResolvedValue(true);
    listInstalledModelsMock.mockResolvedValue(["qwen3:32b"]);

    await resolveAutoModel();

    expect(fsMkdirMock).toHaveBeenCalled();
    expect(fsWriteFileMock).toHaveBeenCalled();
    const writeCall = fsWriteFileMock.mock.calls[0];
    const written = JSON.parse(writeCall[1] as string);
    expect(written.model).toBe("qwen3:32b");
  });

  it("falls back gracefully when memory is insufficient", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile({ availableForModelGB: 3 }));
    formatProfileMock.mockReturnValue("Test · 3GB available");

    const result = await resolveAutoModel();

    expect(result.model).toBe("qwen3:8b");
    expect(recommendModelMock).not.toHaveBeenCalled();
  });

  it("skips pull when skipPull option is true", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Apple M3 Pro · 36GB unified");
    recommendModelMock.mockReturnValue(makeRecommendation());

    const result = await resolveAutoModel({ skipPull: true });

    expect(result.model).toBe("qwen3:32b");
    expect(isOllamaRunningMock).not.toHaveBeenCalled();
    expect(listInstalledModelsMock).not.toHaveBeenCalled();
  });

  it("starts Ollama if installed but not running", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Apple M3 Pro · 36GB unified");
    recommendModelMock.mockReturnValue(makeRecommendation());
    isOllamaRunningMock.mockResolvedValue(false);
    startOllamaServiceMock.mockResolvedValue(undefined);
    listInstalledModelsMock.mockResolvedValue(["qwen3:32b"]);

    await resolveAutoModel();

    expect(startOllamaServiceMock).toHaveBeenCalledOnce();
  });

  it("calls onProgress callback with status messages", async () => {
    readProwlConfigMock.mockReturnValue(null);
    detectHardwareMock.mockResolvedValue(makeProfile());
    formatProfileMock.mockReturnValue("Apple M3 Pro · 36GB unified");
    recommendModelMock.mockReturnValue(makeRecommendation());
    isOllamaRunningMock.mockResolvedValue(true);
    listInstalledModelsMock.mockResolvedValue(["qwen3:32b"]);

    const messages: string[] = [];
    await resolveAutoModel({
      onProgress: (msg) => messages.push(msg),
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("Detecting hardware"))).toBe(true);
    expect(messages.some((m) => m.includes("Recommended"))).toBe(true);
  });
});
