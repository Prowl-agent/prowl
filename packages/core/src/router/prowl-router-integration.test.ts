import { describe, it, expect, beforeEach } from "vitest";
import {
  initRouter,
  resetRouter,
  routeMessage,
  needsCloudConfirmation,
  getRouterStatus,
  detectTaskType,
  detectInternetNeed,
} from "./prowl-router-integration.js";

beforeEach(() => {
  resetRouter();
});

describe("detectTaskType", () => {
  it("returns 'tool' when tools are provided", () => {
    expect(detectTaskType("hello", [{ type: "function" }])).toBe("tool");
  });

  it("returns 'code' for coding prompts", () => {
    expect(detectTaskType("Write a TypeScript function")).toBe("code");
    expect(detectTaskType("debug this error")).toBe("code");
    expect(detectTaskType("refactor the module")).toBe("code");
  });

  it("returns 'agent' for multi-step task prompts", () => {
    expect(detectTaskType("search for all TODO comments")).toBe("agent");
    expect(detectTaskType("create a file called foo.ts")).toBe("agent");
    expect(detectTaskType("step by step, do the following tasks")).toBe("agent");
  });

  it("returns 'chat' for general conversation", () => {
    expect(detectTaskType("Hello, how are you?")).toBe("chat");
    expect(detectTaskType("What is the meaning of life?")).toBe("chat");
  });
});

describe("detectInternetNeed", () => {
  it("detects internet-related prompts", () => {
    expect(detectInternetNeed("search for the latest news")).toBe(true);
    expect(detectInternetNeed("google this topic")).toBe(true);
  });

  it("returns false for offline prompts", () => {
    expect(detectInternetNeed("write a function")).toBe(false);
    expect(detectInternetNeed("hello world")).toBe(false);
  });
});

describe("routeMessage", () => {
  it("returns local fallback when router not initialized", async () => {
    const decision = await routeMessage("Hello");
    expect(decision.route).toBe("local");
    expect(decision.complexity).toBe("simple");
    expect(decision.reasoning).toContain("not initialized");
  });

  it("returns local for simple chat with cloud disabled", async () => {
    initRouter("qwen3:8b");
    const decision = await routeMessage("Hello, how are you?");
    expect(decision.route).toBe("local");
    expect(decision.localModel).toBe("qwen3:8b");
  });

  it("routes locally even for complex tasks when cloud is disabled", async () => {
    initRouter("qwen3:8b"); // defaults to cloudFallbackMode: 'disabled'
    const longPrompt = "implement a complete authentication system with ".repeat(100);
    const decision = await routeMessage(longPrompt);
    expect(decision.route).toBe("local");
  });
});

describe("needsCloudConfirmation", () => {
  it("returns false when mode is disabled", () => {
    initRouter("qwen3:8b");
    const decision = {
      route: "cloud" as const,
      complexity: "complex" as const,
      localModel: "qwen3:8b",
      reasoning: "test",
      warnings: [],
    };
    // Cloud disabled, so no confirmation needed regardless of decision
    expect(needsCloudConfirmation(decision)).toBe(false);
  });
});

describe("getRouterStatus", () => {
  it("returns defaults when not initialized", () => {
    const status = getRouterStatus();
    expect(status.mode).toBe("disabled");
    expect(status.localModel).toBe("qwen3:8b");
    expect(status.cloudEnabled).toBe(false);
  });

  it("reflects initialized config", () => {
    initRouter("llama3:8b");
    const status = getRouterStatus();
    expect(status.localModel).toBe("llama3:8b");
    expect(status.mode).toBe("disabled");
    expect(status.cloudEnabled).toBe(false);
  });
});

describe("initRouter", () => {
  it("configures the singleton properly", async () => {
    initRouter("qwen3:8b");
    const decision = await routeMessage("Hello");
    expect(decision.route).toBe("local");
    expect(decision.localModel).toBe("qwen3:8b");
  });

  it("accepts partial config overrides", () => {
    initRouter("qwen3:8b", { complexityThreshold: "simple" });
    const status = getRouterStatus();
    expect(status.localModel).toBe("qwen3:8b");
  });
});
