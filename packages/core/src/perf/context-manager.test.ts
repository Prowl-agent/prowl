import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  computeNumCtx,
  trimConversationToFit,
  readContextConfig,
  type ContextConfig,
} from "./context-manager.js";

const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 8192,
  summaryTriggerTokens: 6144,
  toolSchemaMode: "lazy",
};

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("hello world this is a test")).toBe(7);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateMessageTokens", () => {
  it("estimates total tokens across messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const tokens = estimateMessageTokens(messages);
    // 2 messages × (~2 content tokens + 4 overhead) = ~12
    expect(tokens).toBeGreaterThanOrEqual(10);
    expect(tokens).toBeLessThan(20);
  });

  it("includes system prompt tokens", () => {
    const messages = [{ role: "user", content: "hi" }];
    const withSystem = estimateMessageTokens(messages, "You are a helpful assistant.");
    const withoutSystem = estimateMessageTokens(messages);
    expect(withSystem).toBeGreaterThan(withoutSystem);
  });
});

describe("computeNumCtx", () => {
  it("returns power-of-2 sized context", () => {
    const result = computeNumCtx(500, 500, DEFAULT_CONFIG);
    // 500 + 500 = 1000 × 1.2 = 1200, next power of 2 = 2048
    expect(result).toBe(2048);
  });

  it("caps at maxContextTokens", () => {
    const result = computeNumCtx(10000, 4096, DEFAULT_CONFIG);
    expect(result).toBeLessThanOrEqual(DEFAULT_CONFIG.maxContextTokens);
  });

  it("caps at model context window when smaller", () => {
    const result = computeNumCtx(500, 500, DEFAULT_CONFIG, 4096);
    expect(result).toBeLessThanOrEqual(4096);
  });

  it("has minimum of 2048", () => {
    const result = computeNumCtx(10, 10, DEFAULT_CONFIG);
    expect(result).toBeGreaterThanOrEqual(2048);
  });
});

describe("trimConversationToFit", () => {
  it("returns all messages when under budget", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = trimConversationToFit(messages, 1000);
    expect(result).toEqual(messages);
  });

  it("keeps most recent messages when over budget", () => {
    const messages = [
      { role: "user", content: "old message ".repeat(100) },
      { role: "assistant", content: "old reply ".repeat(100) },
      { role: "user", content: "new" },
      { role: "assistant", content: "response" },
    ];
    const result = trimConversationToFit(messages, 50);
    expect(result.length).toBeLessThan(messages.length);
    expect(result[result.length - 1].content).toBe("response");
  });

  it("always keeps at least one message", () => {
    const messages = [{ role: "user", content: "very long ".repeat(1000) }];
    const result = trimConversationToFit(messages, 1);
    expect(result).toHaveLength(1);
  });
});

describe("readContextConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns defaults when no env vars set", () => {
    const config = readContextConfig();
    expect(config.maxContextTokens).toBe(8192);
    expect(config.summaryTriggerTokens).toBe(6144);
    expect(config.toolSchemaMode).toBe("lazy");
  });
});
