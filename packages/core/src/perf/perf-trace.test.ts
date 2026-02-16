import { describe, expect, it } from "vitest";
import {
  createPerfTrace,
  finalizePerfTrace,
  formatPerfTrace,
  type OllamaTimings,
} from "./perf-trace.js";

describe("createPerfTrace", () => {
  it("creates a trace with a unique ID", () => {
    const trace = createPerfTrace("qwen3:8b", "http://localhost:11434");
    expect(trace.traceId).toMatch(/^[a-f0-9]{8}$/);
    expect(trace.model).toBe("qwen3:8b");
    expect(trace.totalMs).toBe(0);
  });
});

describe("finalizePerfTrace", () => {
  it("computes metrics from Ollama timings", () => {
    const trace = createPerfTrace("qwen3:8b", "http://localhost:11434");
    const timings: OllamaTimings = {
      total_duration: 2_000_000_000, // 2s
      load_duration: 100_000_000, // 100ms → warm
      prompt_eval_count: 50,
      prompt_eval_duration: 500_000_000,
      eval_count: 100,
      eval_duration: 2_000_000_000, // 2s → 50 tok/s
    };

    const result = finalizePerfTrace(trace, timings, trace.startedAt + 200, 4096);

    expect(result.modelLoadMs).toBe(100);
    expect(result.tokensPerSec).toBe(50);
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(100);
    expect(result.wasWarm).toBe(true);
    expect(result.timeToFirstTokenMs).toBe(200);
    expect(result.numCtx).toBe(4096);
  });

  it("marks as cold when load exceeds threshold", () => {
    const trace = createPerfTrace("qwen3:32b", "http://localhost:11434");
    const timings: OllamaTimings = {
      load_duration: 5_000_000_000, // 5s
      eval_count: 10,
      eval_duration: 1_000_000_000,
    };

    const result = finalizePerfTrace(trace, timings, 0, 8192);

    expect(result.wasWarm).toBe(false);
    expect(result.modelLoadMs).toBe(5000);
  });
});

describe("formatPerfTrace", () => {
  it("formats a readable log line", () => {
    const trace = createPerfTrace("qwen3:8b", "http://localhost:11434");
    const timings: OllamaTimings = {
      load_duration: 100_000_000,
      eval_count: 50,
      eval_duration: 1_000_000_000,
      prompt_eval_count: 20,
    };
    const finalized = finalizePerfTrace(trace, timings, trace.startedAt + 100, 4096);
    const formatted = formatPerfTrace(finalized);

    expect(formatted).toContain("qwen3:8b");
    expect(formatted).toContain("warm");
    expect(formatted).toContain("tok/s=50");
    expect(formatted).toContain("ctx=4096");
  });
});
