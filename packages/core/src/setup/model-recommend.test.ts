import { describe, expect, it } from "vitest";
import type { HardwareProfile } from "./hardware-detect.js";
import { listCompatibleModels, recommendModel } from "./model-recommend.js";

function makeProfile(overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    os: "linux",
    chip: "Test CPU",
    totalRAM: 32,
    availableRAM: 16,
    gpuName: null,
    gpuVRAM: null,
    unifiedMemory: null,
    cpuCores: 8,
    ...overrides,
  };
}

describe("recommendModel", () => {
  it("selects qwen3:32b when available memory is >= 40GB", () => {
    const profile = makeProfile({
      os: "macos",
      unifiedMemory: 46,
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
      gpuName: "NVIDIA RTX 4070",
      gpuVRAM: 14,
      totalRAM: 16,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen2.5-coder:14b");
    expect(recommendation.quality).toBe("great");
  });

  it("selects qwen3:8b when CPU-only available memory is >= 8GB", () => {
    const profile = makeProfile({
      totalRAM: 16,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen3:8b");
    expect(recommendation.quality).toBe("good");
  });

  it("selects qwen3:4b when available memory is >= 4GB", () => {
    const profile = makeProfile({
      totalRAM: 12,
    });

    const recommendation = recommendModel(profile);
    expect(recommendation.model).toBe("qwen3:4b");
    expect(recommendation.quality).toBe("basic");
  });

  it("throws when available memory is below 4GB", () => {
    const profile = makeProfile({
      totalRAM: 11.5,
    });

    expect(() => recommendModel(profile)).toThrowError(
      "Insufficient memory. Minimum 16GB RAM recommended.",
    );
  });
});

describe("listCompatibleModels", () => {
  it("returns all fitting models sorted by quality descending", () => {
    const profile = makeProfile({
      totalRAM: 22,
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
      totalRAM: 52,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q8_0");
  });

  it("picks Q5_K_M when memory is sufficient but not excessive", () => {
    const profile = makeProfile({
      totalRAM: 48,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q5_K_M");
  });

  it("defaults to Q4_K_M when Q5_K_M threshold is not met", () => {
    const profile = makeProfile({
      totalRAM: 16,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q4_K_M");
  });

  it("falls back to Q3_K_M when memory is tight", () => {
    const profile = makeProfile({
      totalRAM: 12,
    });
    expect(recommendModel(profile).recommendedQuant).toBe("Q3_K_M");
  });
});
