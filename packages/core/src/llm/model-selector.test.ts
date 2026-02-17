import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./model-selector.js";

const mockFetch = vi.fn();

describe("ModelSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  const twoModelsResponse = {
    ok: true,
    json: async () => ({
      models: [
        {
          name: "qwen3:8b",
          size: 5_936_648_224,
          size_vram: 5_936_648_224,
          details: { family: "qwen3", parameter_size: "8B" },
        },
        {
          name: "qwen3:1.7b",
          size: 2_355_771_424,
          size_vram: 2_355_771_424,
          details: { family: "qwen3", parameter_size: "1.7B" },
        },
      ],
    }),
  };

  const oneModelResponse = {
    ok: true,
    json: async () => ({
      models: [
        {
          name: "qwen3:8b",
          size: 5_936_648_224,
          size_vram: 5_936_648_224,
          details: { family: "qwen3", parameter_size: "8B" },
        },
      ],
    }),
  };

  it("selects the smallest model for quick tasks", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:8b");

    const result = await selector.select("quick");
    expect(result.model).toBe("qwen3:1.7b");
    expect(result.taskWeight).toBe("quick");
  });

  it("selects the largest model for heavy tasks", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:8b");

    const result = await selector.select("heavy");
    expect(result.model).toBe("qwen3:8b");
    expect(result.taskWeight).toBe("heavy");
  });

  it("prefers configured model for standard tasks", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:8b");

    const result = await selector.select("standard");
    expect(result.model).toBe("qwen3:8b");
  });

  it("falls back when preferred standard model is not loaded", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:14b");

    const result = await selector.select("standard");
    expect(result.model).toBe("qwen3:8b");
    expect(result.reason).toContain("not loaded");
  });

  it("uses the only loaded model for every task", async () => {
    mockFetch.mockResolvedValue(oneModelResponse);
    const selector = new ModelSelector("qwen3:8b");

    const quickResult = await selector.select("quick");
    const heavyResult = await selector.select("heavy");
    expect(quickResult.model).toBe("qwen3:8b");
    expect(heavyResult.model).toBe("qwen3:8b");
  });

  it("falls back to preferred model when Ollama is unreachable", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    const selector = new ModelSelector("qwen3:8b");

    const result = await selector.select("standard");
    expect(result.model).toBe("qwen3:8b");
    expect(result.allAvailable).toEqual([]);
  });

  it("classifies greetings as quick", () => {
    const selector = new ModelSelector("qwen3:8b");
    expect(selector.classifyTaskWeight("hi")).toBe("quick");
    expect(selector.classifyTaskWeight("hello there")).toBe("quick");
    expect(selector.classifyTaskWeight("thanks!")).toBe("quick");
  });

  it("classifies code requests as heavy", () => {
    const selector = new ModelSelector("qwen3:8b");
    expect(selector.classifyTaskWeight("implement a binary search tree")).toBe("heavy");
    expect(selector.classifyTaskWeight("refactor this module")).toBe("heavy");
  });

  it("classifies normal chat as standard", () => {
    const selector = new ModelSelector("qwen3:8b");
    expect(selector.classifyTaskWeight("tell me about the history of Rome")).toBe("standard");
  });

  it("classifies as heavy when many tools are provided", () => {
    const selector = new ModelSelector("qwen3:8b");
    const tools = [{}, {}, {}, {}];
    expect(selector.classifyTaskWeight("do something", tools)).toBe("heavy");
  });

  it("classifies as heavy for long conversations", () => {
    const selector = new ModelSelector("qwen3:8b");
    expect(selector.classifyTaskWeight("continue", undefined, 25)).toBe("heavy");
  });

  it("lists all available models in the selection result", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:8b");

    const result = await selector.select("standard");
    expect(result.allAvailable).toContain("qwen3:8b");
    expect(result.allAvailable).toContain("qwen3:1.7b");
  });

  it("caches loaded models and does not re-fetch inside the interval", async () => {
    mockFetch.mockResolvedValue(twoModelsResponse);
    const selector = new ModelSelector("qwen3:8b");

    await selector.select("quick");
    await selector.select("heavy");
    await selector.select("standard");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
