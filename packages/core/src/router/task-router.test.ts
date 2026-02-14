import { describe, expect, it, vi } from "vitest";
import type { EstimatedCost, TaskComplexity } from "./task-router.js";
import {
  compareComplexityLevels,
  createDefaultConfig,
  estimateComplexity,
  estimateTokenCount,
  routeTask,
  shouldWarnAboutCost,
} from "./task-router.js";

describe("estimateComplexity", () => {
  it("returns simple for a short chat prompt", () => {
    const complexity = estimateComplexity({
      prompt: "hello",
      taskType: "chat",
    });

    expect(complexity).toBe("simple");
  });

  it("returns moderate for mid-weight code task", () => {
    const complexity = estimateComplexity({
      prompt: "x".repeat(300),
      taskType: "code",
      conversationHistory: [{ role: "user", content: "previous" }],
    });

    expect(complexity).toBe("moderate");
  });

  it("returns complex for long-context agent task", () => {
    const complexity = estimateComplexity({
      prompt: "Investigate root cause and produce implementation plan",
      taskType: "agent",
      conversationHistory: Array.from({ length: 10 }, () => ({
        role: "user" as const,
        content: "step",
      })),
      requiresLongContext: true,
    });

    expect(complexity).toBe("complex");
  });

  it("caps score at 100 and maps to very-complex", () => {
    const complexity = estimateComplexity({
      prompt: "x".repeat(3_000),
      taskType: "agent",
      conversationHistory: Array.from({ length: 20 }, () => ({
        role: "assistant" as const,
        content: "a",
      })),
      attachments: [{ type: "image" }],
      requiresInternetAccess: true,
      requiresLongContext: true,
    });

    expect(complexity).toBe("very-complex");
  });
});

describe("routeTask", () => {
  it("always routes local when cloud fallback is disabled", async () => {
    const decision = await routeTask(
      {
        prompt: "x".repeat(3_500),
        taskType: "agent",
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "disabled",
        localContextWindowTokens: 100,
      },
    );

    expect(decision.route).toBe("local");
    expect(decision.reasoning).toBe("Local: cloud fallback disabled, routing all tasks locally");
    expect(decision.warnings).toContain(
      "Prompt exceeds local context window (875 tokens estimated)",
    );
  });

  it("routes local for simple tasks in manual mode", async () => {
    const confirmCloudCallback = vi.fn(async () => true);

    const decision = await routeTask(
      {
        prompt: "hello",
        taskType: "chat",
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "manual",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        complexityThreshold: "complex",
        confirmCloudCallback,
      },
    );

    expect(decision.route).toBe("local");
    expect(confirmCloudCallback).not.toHaveBeenCalled();
  });

  it("calls confirmCloudCallback for complex tasks in manual mode", async () => {
    const confirmCloudCallback = vi.fn(async (_cost: EstimatedCost) => true);

    await routeTask(
      {
        prompt: "x".repeat(700),
        taskType: "agent",
        requiresLongContext: true,
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "manual",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        complexityThreshold: "complex",
        confirmCloudCallback,
      },
    );

    expect(confirmCloudCallback).toHaveBeenCalledTimes(1);
    const firstCall = confirmCloudCallback.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("routes cloud when manual callback approves", async () => {
    const decision = await routeTask(
      {
        prompt: "x".repeat(700),
        taskType: "agent",
        requiresLongContext: true,
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "manual",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        complexityThreshold: "complex",
        confirmCloudCallback: async () => true,
      },
    );

    expect(decision.route).toBe("cloud");
    expect(decision.estimatedCost).toBeDefined();
  });

  it("routes local when manual callback rejects", async () => {
    const decision = await routeTask(
      {
        prompt: "x".repeat(700),
        taskType: "agent",
        requiresLongContext: true,
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "manual",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        complexityThreshold: "complex",
        confirmCloudCallback: async () => false,
      },
    );

    expect(decision.route).toBe("local");
    expect(decision.warnings).toContain("Cloud routing rejected by user confirmation callback");
  });

  it("routes cloud automatically in auto mode for complex tasks", async () => {
    const decision = await routeTask(
      {
        prompt: "x".repeat(700),
        taskType: "agent",
        requiresLongContext: true,
      },
      {
        localModel: "qwen3:8b",
        cloudFallbackMode: "auto",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        complexityThreshold: "complex",
      },
    );

    expect(decision.route).toBe("cloud");
    expect(decision.estimatedCost).toBeDefined();
  });

  it("adds context-overflow warning in both local and cloud routing paths", async () => {
    const context = {
      prompt: "x".repeat(1_000),
      taskType: "chat" as const,
    };

    const localDecision = await routeTask(context, {
      localModel: "qwen3:8b",
      cloudFallbackMode: "disabled",
      localContextWindowTokens: 100,
    });

    const cloudDecision = await routeTask(context, {
      localModel: "qwen3:8b",
      cloudFallbackMode: "auto",
      localContextWindowTokens: 100,
      cloudProvider: "openai",
      cloudModel: "gpt-4o",
      complexityThreshold: "very-complex",
    });

    expect(localDecision.route).toBe("local");
    expect(cloudDecision.route).toBe("cloud");
    expect(localDecision.warnings[0]).toBe(
      "Prompt exceeds local context window (250 tokens estimated)",
    );
    expect(cloudDecision.warnings[0]).toBe(
      "Prompt exceeds local context window (250 tokens estimated)",
    );
  });
});

describe("compareComplexityLevels", () => {
  const levels: TaskComplexity[] = ["simple", "moderate", "complex", "very-complex"];

  it("returns expected ordering for all pairs", () => {
    levels.forEach((a, aIndex) => {
      levels.forEach((b, bIndex) => {
        const expected = aIndex === bIndex ? 0 : aIndex < bIndex ? -1 : 1;
        expect(compareComplexityLevels(a, b)).toBe(expected);
      });
    });
  });
});

describe("estimateTokenCount", () => {
  it("uses ceil(length / 4)", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("a".repeat(10))).toBe(3);
  });
});

describe("shouldWarnAboutCost", () => {
  it("warns only when cost is above $0.10", () => {
    const atThreshold: EstimatedCost = {
      promptTokens: 1_000,
      estimatedCompletionTokens: 1_000,
      estimatedTotalUSD: 0.1,
      provider: "openai",
      model: "gpt-4o",
    };
    const aboveThreshold: EstimatedCost = {
      ...atThreshold,
      estimatedTotalUSD: 0.1001,
    };

    expect(shouldWarnAboutCost(atThreshold)).toBe(false);
    expect(shouldWarnAboutCost(aboveThreshold)).toBe(true);
  });
});

describe("createDefaultConfig", () => {
  it("returns local-first defaults with no cloud provider", () => {
    expect(createDefaultConfig("qwen3:8b")).toEqual({
      localModel: "qwen3:8b",
      cloudFallbackMode: "disabled",
      localContextWindowTokens: 8_192,
      complexityThreshold: "complex",
    });
  });
});
