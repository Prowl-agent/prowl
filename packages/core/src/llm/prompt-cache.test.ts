import { describe, expect, it } from "vitest";
import { PromptCache, quickHash } from "./prompt-cache.js";

describe("PromptCache", () => {
  it("returns wasCached=false on first call", () => {
    const cache = new PromptCache();
    const result = cache.getOrBuild("qwen3:8b", () => "You are helpful.");
    expect(result.wasCached).toBe(false);
    expect(result.systemPrompt).toBe("You are helpful.");
  });

  it("returns wasCached=true on same model + tools", () => {
    const cache = new PromptCache();
    const tools = [
      { type: "function", function: { name: "bash", description: "Run", parameters: {} } },
    ];

    const first = cache.getOrBuild("qwen3:8b", () => "You are helpful.", tools);
    expect(first.wasCached).toBe(false);

    let buildCalled = false;
    const second = cache.getOrBuild(
      "qwen3:8b",
      () => {
        buildCalled = true;
        return "Rebuilt";
      },
      tools,
    );
    expect(second.wasCached).toBe(true);
    expect(second.systemPrompt).toBe("You are helpful.");
    expect(buildCalled).toBe(false);
  });

  it("cache miss on different model", () => {
    const cache = new PromptCache();
    cache.getOrBuild("qwen3:8b", () => "Small model prompt.");
    const result = cache.getOrBuild("llama3:70b", () => "Large model prompt.");
    expect(result.wasCached).toBe(false);
    expect(result.systemPrompt).toBe("Large model prompt.");
  });

  it("cache miss on different tools", () => {
    const cache = new PromptCache();
    const tools1 = [
      { type: "function", function: { name: "bash", description: "Run", parameters: {} } },
    ];
    const tools2 = [
      { type: "function", function: { name: "read", description: "Read", parameters: {} } },
    ];

    cache.getOrBuild("qwen3:8b", () => "Prompt A", tools1);
    const result = cache.getOrBuild("qwen3:8b", () => "Prompt B", tools2);
    expect(result.wasCached).toBe(false);
    expect(result.systemPrompt).toBe("Prompt B");
  });

  it("invalidate() clears cache", () => {
    const cache = new PromptCache();
    cache.getOrBuild("qwen3:8b", () => "Cached prompt.");
    expect(cache.current).not.toBeNull();

    cache.invalidate();
    expect(cache.current).toBeNull();

    const result = cache.getOrBuild("qwen3:8b", () => "Rebuilt prompt.");
    expect(result.wasCached).toBe(false);
    expect(result.systemPrompt).toBe("Rebuilt prompt.");
  });

  it("caches tool schemas JSON", () => {
    const cache = new PromptCache();
    const tools = [
      { type: "function", function: { name: "search", description: "Search", parameters: {} } },
    ];
    const result = cache.getOrBuild("qwen3:8b", () => "prompt", tools);
    expect(result.toolSchemas).toBe(JSON.stringify(tools));
  });

  it("handles no tools (empty string)", () => {
    const cache = new PromptCache();
    const result = cache.getOrBuild("qwen3:8b", () => "prompt");
    expect(result.toolSchemas).toBe("");
  });
});

describe("quickHash", () => {
  it("produces different values for different inputs", () => {
    const a = quickHash("qwen3:8b");
    const b = quickHash("llama3:70b");
    expect(a).not.toBe(b);
  });

  it("produces same value for same input", () => {
    const a = quickHash("qwen3:8b[tools]");
    const b = quickHash("qwen3:8b[tools]");
    expect(a).toBe(b);
  });

  it("returns a string", () => {
    const hash = quickHash("test");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const hash = quickHash("");
    expect(typeof hash).toBe("string");
  });
});
