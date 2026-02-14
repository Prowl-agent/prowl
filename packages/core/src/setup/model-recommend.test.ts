import { describe, expect, it } from "vitest";
import type { HardwareProfile } from "./hardware-detect.js";
import { listCompatibleModels, recommendModel } from "./model-recommend.js";

function makeProfile(overrides: Partial<HardwareProfile>): HardwareProfile {
  const totalRAMGB = overrides.totalRAMGB ?? 32;
  const unifiedMemoryGB = overrides.unifiedMemoryGB ?? 0;
  const gpuVRAMGB = overrides.gpuVRAMGB ?? 0;
  const isAppleSilicon = overrides.isAppleSilicon ?? false;
  const availableForModelGB =
    overrides.availableForModelGB ??
    (isAppleSilicon ? unifiedMemoryGB - 6 : gpuVRAMGB > 0 ? gpuVRAMGB : totalRAMGB - 8);

  return {
    os: "linux",
    arch: "x64",
    totalRAMGB,
    unifiedMemoryGB,
    gpuVRAMGB,
    gpu: {
      vendor: gpuVRAMGB > 0 ? "nvidia" : "unknown",
      name: gpuVRAMGB > 0 ? "NVIDIA RTX Test" : "Unknown GPU",
      vramGB: gpuVRAMGB,
      isAppleSilicon,
    },
    cpuCores: 8,
    cpuModel: "Test CPU",
    isAppleSilicon,
    availableForModelGB,
    ollamaInstalled: false,
    ollamaVersion: null,
    prowlDataDir: "/tmp/.prowl/models",
    ...overrides,
  };
}

describe("recommendModel", () => {
  it("selects qwen3:32b when available memory is >= 40GB", () => {
    const profile = makeProfile({
      os: "macos",
      unifiedMemoryGB: 46,
      totalRAMGB: 46,
      isAppleSilicon: true,
      gpu: { vendor: "apple", name: "Apple M4", vramGB: 0, isAppleSilicon: true },
      availableForModelGB: 40,
    });

    const recommendation = recommendModel(profile);

    expect(recommendation.model).toBe("qwen3:32b");
    expect(recommendation.quality).toBe("excellent");
    expect(recommendation.reason).toBe("Full power for complex autonomous tasks");
    expect(recommendation.source).toBe("ollama");
    expect(recommendation.ollamaTag).toBe("qwen3:32b");
    expect(recommendation.hfRepo).toBe("bartowski/Qwen3-32B-GGUF");
  });

  it("selects qwen2.5-coder:14b when NVIDIA VRAM is >= 14GB", () => {
    const profile = makeProfile({
      gpuVRAMGB: 14,
      totalRAMGB: 16,
      gpu: { vendor: "nvidia", name: "NVIDIA RTX 4070", vramGB: 14, isAppleSilicon: false },
      availableForModelGB: 14,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen2.5-coder:14b");
    expect(recommendation.quality).toBe("great");
  });

  it("selects qwen3:8b when CPU-only available memory is >= 8GB", () => {
    const profile = makeProfile({
      totalRAMGB: 16,
      availableForModelGB: 8,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen3:8b");
    expect(recommendation.quality).toBe("good");
  });

  it("selects qwen3:4b when available memory is >= 4GB", () => {
    const profile = makeProfile({
      totalRAMGB: 12,
      availableForModelGB: 4,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen3:4b");
    expect(recommendation.quality).toBe("basic");
  });

  it("throws when available memory is below 4GB", () => {
    const profile = makeProfile({
      totalRAMGB: 11.5,
      availableForModelGB: 3.5,
    });

    expect(() => recommendModel(profile)).toThrowError(
      "Insufficient memory. Minimum 16GB RAM recommended.",
    );
  });
});

describe("listCompatibleModels", () => {
  it("returns all fitting models sorted by quality descending", () => {
    const profile = makeProfile({
      totalRAMGB: 22,
      availableForModelGB: 14,
    });

    const compatible = listCompatibleModels(profile);
    expect(compatible.map((entry) => entry.model)).toEqual([
      "qwen2.5-coder:14b",
      "qwen3:8b",
      "qwen3:4b",
    ]);
    expect(compatible.map((entry) => entry.quality)).toEqual(["great", "good", "basic"]);
  });
});

describe("recommendedQuant", () => {
  it("picks Q8_0 when memory is very comfortable", () => {
    const profile = makeProfile({
      totalRAMGB: 52,
      availableForModelGB: 44,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q8_0");
  });

  it("picks Q5_K_M when memory is sufficient but not excessive", () => {
    const profile = makeProfile({
      totalRAMGB: 48,
      availableForModelGB: 40,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q5_K_M");
  });

  it("defaults to Q4_K_M when Q5_K_M threshold is not met", () => {
    const profile = makeProfile({
      totalRAMGB: 16,
      availableForModelGB: 8,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q4_K_M");
  });

  it("falls back to Q3_K_M when memory is tight", () => {
    const profile = makeProfile({
      totalRAMGB: 12,
      availableForModelGB: 4,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q3_K_M");
  });
});
