import { describe, expect, it, vi, beforeEach } from "vitest";
import { readModelTierConfig, resolveModelForComplexity } from "./model-tier.js";

describe("readModelTierConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses default model when no env vars", () => {
    const config = readModelTierConfig("qwen3:8b");
    expect(config.chatModel).toBe("qwen3:8b");
    expect(config.heavyModel).toBe("qwen3:8b");
    expect(config.autoRoute).toBe(false);
  });
});

describe("resolveModelForComplexity", () => {
  it("returns chat model for simple task", () => {
    const result = resolveModelForComplexity("simple", {
      chatModel: "qwen3:4b",
      heavyModel: "qwen3:32b",
      autoRoute: true,
    });
    expect(result.model).toBe("qwen3:4b");
    expect(result.tier).toBe("fast");
  });

  it("returns heavy model for complex task", () => {
    const result = resolveModelForComplexity("complex", {
      chatModel: "qwen3:4b",
      heavyModel: "qwen3:32b",
      autoRoute: true,
    });
    expect(result.model).toBe("qwen3:32b");
    expect(result.tier).toBe("heavy");
  });

  it("returns heavy model for very-complex task", () => {
    const result = resolveModelForComplexity("very-complex", {
      chatModel: "qwen3:4b",
      heavyModel: "qwen3:32b",
      autoRoute: true,
    });
    expect(result.model).toBe("qwen3:32b");
    expect(result.tier).toBe("heavy");
  });

  it("returns chat model when auto-route is off", () => {
    const result = resolveModelForComplexity("complex", {
      chatModel: "qwen3:4b",
      heavyModel: "qwen3:32b",
      autoRoute: false,
    });
    expect(result.model).toBe("qwen3:4b");
    expect(result.tier).toBe("fast");
  });

  it("returns chat model when both tiers are the same", () => {
    const result = resolveModelForComplexity("complex", {
      chatModel: "qwen3:8b",
      heavyModel: "qwen3:8b",
      autoRoute: true,
    });
    expect(result.model).toBe("qwen3:8b");
  });
});
