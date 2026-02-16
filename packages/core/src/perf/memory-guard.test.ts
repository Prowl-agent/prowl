import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HardwareProfile } from "../setup/hardware-detect.js";
import { estimateModelSize, checkModelFit, enforceMemoryGuard } from "./memory-guard.js";

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: "macos",
    arch: "arm64",
    totalRAMGB: 36,
    unifiedMemoryGB: 36,
    gpuVRAMGB: 0,
    gpu: { vendor: "apple", name: "Apple M3 Pro", vramGB: 0, isAppleSilicon: true },
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

describe("estimateModelSize", () => {
  it("returns known size for registered models", () => {
    expect(estimateModelSize("qwen3:8b")).toBe(4.8);
    expect(estimateModelSize("qwen3:32b")).toBe(19.8);
  });

  it("estimates from parameter count in tag name", () => {
    const size = estimateModelSize("llama3:70b");
    expect(size).toBeGreaterThan(30);
  });

  it("returns default for unknown model", () => {
    expect(estimateModelSize("mystery-model")).toBe(5);
  });
});

describe("checkModelFit", () => {
  it("returns fits=true when model fits", () => {
    const result = checkModelFit("qwen3:8b", makeProfile({ availableForModelGB: 30 }));
    expect(result.fits).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns fits=false and suggests smaller model", () => {
    const result = checkModelFit("qwen3:32b", makeProfile({ availableForModelGB: 10 }));
    expect(result.fits).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.suggestion).toBe("qwen2.5-coder:14b");
  });
});

describe("enforceMemoryGuard", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows model that fits", () => {
    const { allow } = enforceMemoryGuard("qwen3:8b", makeProfile(), {
      enabled: true,
      forceLoadLargeModel: false,
    });
    expect(allow).toBe(true);
  });

  it("blocks model that doesn't fit when guard is enabled", () => {
    const { allow } = enforceMemoryGuard("qwen3:32b", makeProfile({ availableForModelGB: 5 }), {
      enabled: true,
      forceLoadLargeModel: false,
    });
    expect(allow).toBe(false);
  });

  it("allows oversized model when force is true", () => {
    const { allow } = enforceMemoryGuard("qwen3:32b", makeProfile({ availableForModelGB: 5 }), {
      enabled: true,
      forceLoadLargeModel: true,
    });
    expect(allow).toBe(true);
  });
});
