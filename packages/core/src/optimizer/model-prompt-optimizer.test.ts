import { describe, expect, it } from "vitest";
import {
  optimizeModelPrompt,
  optimizeSamplingSettings,
  resolveModelTier,
  type HistoryMessage,
} from "./model-prompt-optimizer.js";

describe("resolveModelTier", () => {
  it("classifies model tiers from model size", () => {
    expect(resolveModelTier("qwen3:4b")).toBe("small");
    expect(resolveModelTier("qwen2.5-coder:14b")).toBe("medium");
    expect(resolveModelTier("llama-3.3-70b")).toBe("large");
  });
});

describe("optimizeSamplingSettings", () => {
  it("adapts temperature and topP by task type", () => {
    const chat = optimizeSamplingSettings({ taskType: "chat", modelTier: "medium" });
    const code = optimizeSamplingSettings({ taskType: "code", modelTier: "medium" });

    expect(code.temperature).toBeLessThan(chat.temperature);
    expect(code.topP).toBeGreaterThan(chat.topP - 0.1);
  });

  it("uses more deterministic settings for small models", () => {
    const medium = optimizeSamplingSettings({ taskType: "agent", modelTier: "medium" });
    const small = optimizeSamplingSettings({ taskType: "agent", modelTier: "small" });

    expect(small.temperature).toBeLessThan(medium.temperature);
    expect(small.topP).toBeLessThan(medium.topP);
    expect(small.maxOutputTokens).toBeLessThanOrEqual(medium.maxOutputTokens);
  });
});

describe("optimizeModelPrompt", () => {
  it("applies compact structured system templates for small models", () => {
    const optimized = optimizeModelPrompt({
      model: "qwen3:4b",
      taskType: "code",
      userPrompt: "Implement binary search.",
    });

    expect(optimized.modelTier).toBe("small");
    expect(optimized.systemPrompt).toContain("Format:");
    expect(optimized.systemPrompt).toContain("1) Plan");
    expect(optimized.systemPrompt.length).toBeLessThan(800);
  });

  it("truncates history to fit an 8k context window", () => {
    const history: HistoryMessage[] = Array.from({ length: 48 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} ${"x".repeat(900)}`,
    }));

    const optimized = optimizeModelPrompt({
      model: "qwen3:8b",
      taskType: "agent",
      userPrompt: "Summarize what happened and propose next steps.",
      conversationHistory: history,
      contextWindowTokens: 8_192,
      reservedOutputTokens: 1_024,
    });

    expect(optimized.context.strategy).toBe("head-tail");
    expect(optimized.context.truncated).toBe(true);
    expect(optimized.context.afterTokens).toBeLessThanOrEqual(optimized.context.inputBudgetTokens);
    expect(
      optimized.conversationHistory.some((message) => message.content.includes("message-0")),
    ).toBe(true);
    expect(
      optimized.conversationHistory.some((message) => message.content.includes("message-47")),
    ).toBe(true);
  });

  it("truncates oversized user prompts to stay inside budget", () => {
    const longPrompt = "y".repeat(70_000);
    const optimized = optimizeModelPrompt({
      model: "qwen3:8b",
      taskType: "chat",
      userPrompt: longPrompt,
      contextWindowTokens: 8_192,
      reservedOutputTokens: 2_048,
    });

    expect(optimized.userPrompt.length).toBeLessThan(longPrompt.length);
    expect(optimized.context.afterTokens).toBeLessThanOrEqual(optimized.context.inputBudgetTokens);
  });
});
