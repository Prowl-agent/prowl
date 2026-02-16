/**
 * Performance Tracing
 *
 * Structured perf traces for Ollama requests. Each request gets a unique trace
 * ID and captures: model load time, time-to-first-token, tokens/sec, token
 * counts, context length, and whether the model was already resident.
 */

import { randomUUID } from "node:crypto";

export interface PerfTrace {
  /** Unique trace ID for correlating log events. */
  traceId: string;
  /** Timestamp when the request was initiated. */
  startedAt: number;
  /** Total wall-clock time in ms. */
  totalMs: number;
  /** Model load time in ms (from Ollama's load_duration). ~0 means warm. */
  modelLoadMs: number;
  /** Time from request start to first streamed token in ms. */
  timeToFirstTokenMs: number;
  /** Output tokens per second. */
  tokensPerSec: number;
  /** Prompt (input) token count. */
  promptTokens: number;
  /** Completion (output) token count. */
  completionTokens: number;
  /** Total context length sent to the model. */
  contextTokens: number;
  /** Whether the model was already loaded when the request arrived. */
  wasWarm: boolean;
  /** Model ID (e.g. "qwen3:8b"). */
  model: string;
  /** Ollama base URL used. */
  ollamaUrl: string;
  /** num_ctx actually used for this request. */
  numCtx: number;
}

/** Threshold in ms below which we consider the model "warm" (already loaded). */
const WARM_THRESHOLD_MS = 500;

export function createPerfTrace(model: string, ollamaUrl: string): PerfTrace {
  return {
    traceId: randomUUID().slice(0, 8),
    startedAt: Date.now(),
    totalMs: 0,
    modelLoadMs: 0,
    timeToFirstTokenMs: 0,
    tokensPerSec: 0,
    promptTokens: 0,
    completionTokens: 0,
    contextTokens: 0,
    wasWarm: false,
    model,
    ollamaUrl,
    numCtx: 0,
  };
}

export interface OllamaTimings {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Finalize a perf trace with timing data from the Ollama response.
 * Durations from Ollama are in nanoseconds.
 */
export function finalizePerfTrace(
  trace: PerfTrace,
  timings: OllamaTimings,
  firstTokenAt: number,
  numCtx: number,
): PerfTrace {
  const now = Date.now();
  const totalMs = now - trace.startedAt;
  const loadMs = (timings.load_duration ?? 0) / 1_000_000;
  const evalCount = timings.eval_count ?? 0;
  const evalDurationNs = timings.eval_duration ?? 0;
  const evalDurationSec = evalDurationNs / 1_000_000_000;
  const tokensPerSec = evalDurationSec > 0 ? evalCount / evalDurationSec : 0;
  const promptTokens = timings.prompt_eval_count ?? 0;
  const ttft = firstTokenAt > 0 ? firstTokenAt - trace.startedAt : totalMs;

  return {
    ...trace,
    totalMs,
    modelLoadMs: Math.round(loadMs),
    timeToFirstTokenMs: Math.round(ttft),
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    promptTokens,
    completionTokens: evalCount,
    contextTokens: promptTokens + evalCount,
    wasWarm: loadMs < WARM_THRESHOLD_MS,
    numCtx,
  };
}

/**
 * Format a perf trace as a structured log line.
 */
export function formatPerfTrace(trace: PerfTrace): string {
  const warmLabel = trace.wasWarm ? "warm" : "cold";
  return (
    `[perf:${trace.traceId}] ${trace.model} (${warmLabel}) ` +
    `load=${trace.modelLoadMs}ms ttft=${trace.timeToFirstTokenMs}ms ` +
    `tok/s=${trace.tokensPerSec} prompt=${trace.promptTokens} ` +
    `completion=${trace.completionTokens} ctx=${trace.numCtx} ` +
    `total=${trace.totalMs}ms`
  );
}

/**
 * Emit a structured perf trace to stdout. Best-effort, never throws.
 */
export function logPerfTrace(trace: PerfTrace): void {
  try {
    console.log(formatPerfTrace(trace));
  } catch {
    // Best-effort logging.
  }
}
