import fs from "node:fs/promises";
import path from "node:path";
import type { BenchmarkTask, TaskCategory } from "./types.js";
import { optimizeModelPrompt } from "../optimizer/model-prompt-optimizer.js";
import { detectHardware, type HardwareProfile } from "../setup/hardware-detect.js";
import { scoreTask, type ScorerOptions, type TaskScore } from "./scorer.js";
import { BENCHMARK_TASKS } from "./tasks.js";

// ---------------------------------------------------------------------------
// Config & result types
// ---------------------------------------------------------------------------

export interface BenchmarkConfig {
  models: string[];
  tasks: string[] | "all";
  categories?: TaskCategory[];
  runs: number;
  ollamaUrl: string;
  useOptimizer: boolean;
  compareBaseline: boolean;
  outputDir: string;
  concurrency: number;
  timeoutMs: number;
  /** Optional LLM-as-judge model for subjective scoring criteria. */
  llmJudgeModel?: string;
}

export interface BenchmarkResults {
  config: BenchmarkConfig;
  startedAt: string;
  completedAt: string;
  hardware: HardwareProfile;
  results: TaskScore[];
  summary: BenchmarkSummary;
}

export interface ModelSummary {
  avgCorrectness: number;
  avgCompleteness: number;
  avgToolAccuracy: number;
  totalTasks: number;
  passRate: number;
  avgLatencyMs: number;
  avgTokens: number;
}

export interface CategorySummary {
  avgCorrectness: number;
  passRate: number;
  bestModel: string;
}

export interface OptimizerImpact {
  baselinePassRate: number;
  optimizedPassRate: number;
  improvement: number;
  categoriesImproved: string[];
  categoriesRegressed: string[];
}

export interface BenchmarkSummary {
  byModel: Record<string, ModelSummary>;
  byCategory: Record<string, CategorySummary>;
  optimizerImpact?: OptimizerImpact;
}

/** Progress callback for streaming UI updates. */
export type BenchmarkProgressCallback = (event: BenchmarkProgressEvent) => void;

export type BenchmarkProgressEvent =
  | { type: "start"; totalRuns: number; models: string[]; taskCount: number }
  | { type: "task-start"; model: string; taskId: string; run: number; optimized: boolean }
  | { type: "task-complete"; score: TaskScore }
  | { type: "task-error"; model: string; taskId: string; error: string }
  | { type: "model-complete"; model: string; summary: ModelSummary }
  | { type: "complete"; summary: BenchmarkSummary };

// ---------------------------------------------------------------------------
// Ollama API helpers
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

interface OllamaGenerateResponse {
  response?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  error?: string;
}

async function ollamaIsRunning(ollamaUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaListModels(ollamaUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name.trim() : ""))
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

/**
 * Call Ollama's /api/generate endpoint (non-streaming).
 * Returns the response text and token counts.
 */
async function ollamaGenerate(params: {
  ollamaUrl: string;
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeoutMs: number;
}): Promise<{
  response: string;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model: params.model,
      prompt: params.prompt,
      stream: false,
      options: {
        temperature: params.temperature ?? 0.4,
        top_p: params.topP ?? 0.9,
        ...(params.maxTokens ? { num_predict: params.maxTokens } : {}),
      },
    };
    if (params.system) {
      body.system = params.system;
    }

    const res = await fetch(`${params.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        response: "",
        promptTokens: 0,
        completionTokens: 0,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    if (data.error) {
      return { response: "", promptTokens: 0, completionTokens: 0, error: data.error };
    }

    return {
      response: typeof data.response === "string" ? data.response : "",
      promptTokens: typeof data.prompt_eval_count === "number" ? data.prompt_eval_count : 0,
      completionTokens: typeof data.eval_count === "number" ? data.eval_count : 0,
      error: null,
    };
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === "AbortError"
        ? `Timeout after ${params.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { response: "", promptTokens: 0, completionTokens: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

export function validateConfig(config: BenchmarkConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(config.models) || config.models.length === 0) {
    errors.push({ field: "models", message: "At least one model is required." });
  }
  for (const m of config.models) {
    if (typeof m !== "string" || m.trim().length === 0) {
      errors.push({ field: "models", message: `Invalid model name: "${m}"` });
    }
  }

  if (config.tasks !== "all") {
    if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
      errors.push({ field: "tasks", message: 'Provide task IDs or "all".' });
    }
    for (const id of config.tasks) {
      if (!BENCHMARK_TASKS.some((t) => t.id === id)) {
        errors.push({ field: "tasks", message: `Unknown task ID: "${id}"` });
      }
    }
  }

  if (typeof config.runs !== "number" || config.runs < 1 || config.runs > 50) {
    errors.push({ field: "runs", message: "Runs must be 1-50." });
  }
  if (typeof config.concurrency !== "number" || config.concurrency < 1 || config.concurrency > 8) {
    errors.push({ field: "concurrency", message: "Concurrency must be 1-8." });
  }
  if (typeof config.timeoutMs !== "number" || config.timeoutMs < 5_000) {
    errors.push({ field: "timeoutMs", message: "Timeout must be at least 5000ms." });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Task resolution
// ---------------------------------------------------------------------------

function resolveTasks(config: BenchmarkConfig): BenchmarkTask[] {
  let tasks: BenchmarkTask[];

  if (config.tasks === "all") {
    tasks = [...BENCHMARK_TASKS];
  } else {
    tasks = config.tasks
      .map((id) => BENCHMARK_TASKS.find((t) => t.id === id))
      .filter((t): t is BenchmarkTask => t !== undefined);
  }

  if (config.categories && config.categories.length > 0) {
    const cats = new Set(config.categories);
    tasks = tasks.filter((t) => cats.has(t.category));
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Single task execution
// ---------------------------------------------------------------------------

/**
 * Run a single task against Ollama (baseline: no optimizer).
 */
async function runBaseline(
  task: BenchmarkTask,
  model: string,
  ollamaUrl: string,
  timeoutMs: number,
): Promise<{
  response: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error: string | null;
}> {
  const start = performance.now();
  const result = await ollamaGenerate({
    ollamaUrl,
    model,
    prompt: task.prompt,
    timeoutMs,
  });
  const latencyMs = performance.now() - start;
  return { ...result, latencyMs };
}

/**
 * Run a single task WITH the Prowl optimizer.
 */
async function runOptimized(
  task: BenchmarkTask,
  model: string,
  ollamaUrl: string,
  timeoutMs: number,
): Promise<{
  response: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error: string | null;
}> {
  const optimized: OptimizedPromptResult = optimizeModelPrompt({
    model,
    taskType: task.optimizerTaskType,
    userPrompt: task.prompt,
  });

  const start = performance.now();
  const result = await ollamaGenerate({
    ollamaUrl,
    model,
    prompt: optimized.userPrompt,
    system: optimized.systemPrompt,
    temperature: optimized.sampling.temperature,
    topP: optimized.sampling.topP,
    maxTokens: optimized.sampling.maxOutputTokens,
    timeoutMs,
  });
  const latencyMs = performance.now() - start;
  return { ...result, latencyMs };
}

// ---------------------------------------------------------------------------
// JSONL writer (streaming results to disk)
// ---------------------------------------------------------------------------

async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

function computePassRate(scores: TaskScore[], threshold = 0.7): number {
  if (scores.length === 0) {
    return 0;
  }
  const passing = scores.filter((s) => s.correctness >= threshold).length;
  return passing / scores.length;
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeModelSummary(scores: TaskScore[]): ModelSummary {
  return {
    avgCorrectness: avg(scores.map((s) => s.correctness)),
    avgCompleteness: avg(scores.map((s) => s.completeness)),
    avgToolAccuracy: avg(scores.map((s) => s.toolUseAccuracy)),
    totalTasks: scores.length,
    passRate: computePassRate(scores),
    avgLatencyMs: avg(scores.map((s) => s.latencyMs)),
    avgTokens: avg(scores.map((s) => s.totalTokens)),
  };
}

export function computeCategorySummary(
  scores: TaskScore[],
  tasks: BenchmarkTask[],
  category: string,
): CategorySummary {
  const catTaskIds = new Set(tasks.filter((t) => t.category === category).map((t) => t.id));
  const catScores = scores.filter((s) => catTaskIds.has(s.taskId));

  // Best model by avg correctness
  const modelScores = new Map<string, number[]>();
  for (const s of catScores) {
    const existing = modelScores.get(s.model) ?? [];
    existing.push(s.correctness);
    modelScores.set(s.model, existing);
  }
  let bestModel = "";
  let bestAvg = -1;
  for (const [model, vals] of modelScores) {
    const a = avg(vals);
    if (a > bestAvg) {
      bestAvg = a;
      bestModel = model;
    }
  }

  return {
    avgCorrectness: avg(catScores.map((s) => s.correctness)),
    passRate: computePassRate(catScores),
    bestModel,
  };
}

export function computeOptimizerImpact(
  scores: TaskScore[],
  tasks: BenchmarkTask[],
): OptimizerImpact | undefined {
  const baseline = scores.filter((s) => !s.optimized);
  const optimized = scores.filter((s) => s.optimized);

  if (baseline.length === 0 || optimized.length === 0) {
    return undefined;
  }

  const baselinePassRate = computePassRate(baseline);
  const optimizedPassRate = computePassRate(optimized);

  const categories = [...new Set(tasks.map((t) => t.category))];
  const categoriesImproved: string[] = [];
  const categoriesRegressed: string[] = [];

  for (const cat of categories) {
    const catTaskIds = new Set(tasks.filter((t) => t.category === cat).map((t) => t.id));
    const baselineCat = baseline.filter((s) => catTaskIds.has(s.taskId));
    const optimizedCat = optimized.filter((s) => catTaskIds.has(s.taskId));

    const bAvg = avg(baselineCat.map((s) => s.correctness));
    const oAvg = avg(optimizedCat.map((s) => s.correctness));

    if (oAvg > bAvg + 0.02) {
      categoriesImproved.push(cat);
    } else if (bAvg > oAvg + 0.02) {
      categoriesRegressed.push(cat);
    }
  }

  return {
    baselinePassRate,
    optimizedPassRate,
    improvement: optimizedPassRate - baselinePassRate,
    categoriesImproved,
    categoriesRegressed,
  };
}

export function computeSummary(
  scores: TaskScore[],
  tasks: BenchmarkTask[],
  compareBaseline: boolean,
): BenchmarkSummary {
  // By model (group by model + optimized combo for display, key by "model" or "model (baseline)")
  const byModel: Record<string, ModelSummary> = {};
  const modelNames = [...new Set(scores.map((s) => s.model))];
  for (const model of modelNames) {
    const optimizedScores = scores.filter((s) => s.model === model && s.optimized);
    const baselineScores = scores.filter((s) => s.model === model && !s.optimized);

    if (optimizedScores.length > 0) {
      byModel[model] = computeModelSummary(optimizedScores);
    }
    if (baselineScores.length > 0) {
      byModel[`${model} (baseline)`] = computeModelSummary(baselineScores);
    }
  }

  // By category
  const categories = [...new Set(tasks.map((t) => t.category))];
  const byCategory: Record<string, CategorySummary> = {};
  for (const cat of categories) {
    byCategory[cat] = computeCategorySummary(scores, tasks, cat);
  }

  const summary: BenchmarkSummary = { byModel, byCategory };

  if (compareBaseline) {
    summary.optimizerImpact = computeOptimizerImpact(scores, tasks);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Console summary table
// ---------------------------------------------------------------------------

export function formatSummaryTable(summary: BenchmarkSummary): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  BENCHMARK RESULTS");
  lines.push("═══════════════════════════════════════════════════════════════");

  // Model summary table
  lines.push("");
  lines.push("  Model                        Pass%   Correct  Complete  Latency");
  lines.push("  ─────────────────────────────────────────────────────────────");
  for (const [model, s] of Object.entries(summary.byModel)) {
    const name = model.length > 28 ? `${model.slice(0, 25)}...` : model.padEnd(28);
    const pass = `${(s.passRate * 100).toFixed(0)}%`.padStart(5);
    const corr = s.avgCorrectness.toFixed(2).padStart(8);
    const comp = s.avgCompleteness.toFixed(2).padStart(9);
    const lat = `${Math.round(s.avgLatencyMs)}ms`.padStart(8);
    lines.push(`  ${name} ${pass}  ${corr}  ${comp}  ${lat}`);
  }

  // Category summary
  lines.push("");
  lines.push("  Category              Pass%   Correct  Best Model");
  lines.push("  ─────────────────────────────────────────────────────────────");
  for (const [cat, s] of Object.entries(summary.byCategory)) {
    const name = cat.padEnd(22);
    const pass = `${(s.passRate * 100).toFixed(0)}%`.padStart(5);
    const corr = s.avgCorrectness.toFixed(2).padStart(8);
    lines.push(`  ${name} ${pass}  ${corr}  ${s.bestModel}`);
  }

  // Optimizer impact
  if (summary.optimizerImpact) {
    const imp = summary.optimizerImpact;
    lines.push("");
    lines.push("  OPTIMIZER IMPACT");
    lines.push("  ─────────────────────────────────────────────────────────────");
    lines.push(`  Baseline pass rate:   ${(imp.baselinePassRate * 100).toFixed(1)}%`);
    lines.push(`  Optimized pass rate:  ${(imp.optimizedPassRate * 100).toFixed(1)}%`);
    const sign = imp.improvement >= 0 ? "+" : "";
    lines.push(
      `  Improvement:          ${sign}${(imp.improvement * 100).toFixed(1)} percentage points`,
    );
    if (imp.categoriesImproved.length > 0) {
      lines.push(`  Improved categories:  ${imp.categoriesImproved.join(", ")}`);
    }
    if (imp.categoriesRegressed.length > 0) {
      lines.push(`  Regressed categories: ${imp.categoriesRegressed.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  models: ["qwen3:8b"],
  tasks: "all",
  runs: 1,
  ollamaUrl: DEFAULT_OLLAMA_URL,
  useOptimizer: true,
  compareBaseline: true,
  outputDir: "./benchmark-results",
  concurrency: 1,
  timeoutMs: 120_000,
};

/**
 * Run the full benchmark suite. Streams results to JSONL as they complete.
 * Returns the aggregate BenchmarkResults.
 */
export async function runBenchmark(
  config: BenchmarkConfig,
  onProgress?: BenchmarkProgressCallback,
): Promise<BenchmarkResults> {
  // Validate config
  const errors = validateConfig(config);
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Invalid benchmark config: ${messages}`);
  }

  // Verify Ollama
  const running = await ollamaIsRunning(config.ollamaUrl);
  if (!running) {
    throw new Error(`Ollama is not running at ${config.ollamaUrl}. Start it with: ollama serve`);
  }

  // Verify models are installed
  const installedModels = await ollamaListModels(config.ollamaUrl);
  const missingModels = config.models.filter(
    (m) => !installedModels.some((im) => im === m || im.startsWith(`${m}:`)),
  );
  if (missingModels.length > 0) {
    throw new Error(
      `Models not installed: ${missingModels.join(", ")}. Install with: ollama pull <model>`,
    );
  }

  // Detect hardware
  const hardware = await detectHardware();

  // Resolve tasks
  const tasks = resolveTasks(config);
  if (tasks.length === 0) {
    throw new Error("No tasks matched the provided filters.");
  }

  // Prepare output directory and JSONL file
  await fs.mkdir(config.outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = path.join(config.outputDir, `benchmark-${timestamp}.jsonl`);

  // Calculate total runs
  const modesPerModel = config.compareBaseline ? 2 : 1;
  const totalRuns = config.models.length * tasks.length * config.runs * modesPerModel;

  const startedAt = new Date().toISOString();
  onProgress?.({
    type: "start",
    totalRuns,
    models: config.models,
    taskCount: tasks.length,
  });

  const allScores: TaskScore[] = [];
  const scorerOptions: ScorerOptions = {
    ollamaUrl: config.ollamaUrl,
    llmJudgeModel: config.llmJudgeModel,
  };

  for (const model of config.models) {
    for (const task of tasks) {
      for (let run = 0; run < config.runs; run++) {
        // --- Baseline (no optimizer) ---
        if (config.compareBaseline) {
          onProgress?.({
            type: "task-start",
            model,
            taskId: task.id,
            run,
            optimized: false,
          });

          try {
            const result = await runBaseline(task, model, config.ollamaUrl, config.timeoutMs);
            const score = await scoreTask(
              {
                task,
                model,
                optimized: false,
                response: result.response,
                toolCalls: [],
                latencyMs: result.latencyMs,
                tokenCount: { prompt: result.promptTokens, completion: result.completionTokens },
                retries: 0,
                error: result.error,
              },
              scorerOptions,
            );
            allScores.push(score);
            await appendJsonl(jsonlPath, score);
            onProgress?.({ type: "task-complete", score });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            onProgress?.({ type: "task-error", model, taskId: task.id, error: errorMsg });
          }
        }

        // --- Optimized (with Prowl optimizer) ---
        if (config.useOptimizer) {
          onProgress?.({
            type: "task-start",
            model,
            taskId: task.id,
            run,
            optimized: true,
          });

          try {
            const result = await runOptimized(task, model, config.ollamaUrl, config.timeoutMs);
            const score = await scoreTask(
              {
                task,
                model,
                optimized: true,
                response: result.response,
                toolCalls: [],
                latencyMs: result.latencyMs,
                tokenCount: { prompt: result.promptTokens, completion: result.completionTokens },
                retries: 0,
                error: result.error,
              },
              scorerOptions,
            );
            allScores.push(score);
            await appendJsonl(jsonlPath, score);
            onProgress?.({ type: "task-complete", score });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            onProgress?.({ type: "task-error", model, taskId: task.id, error: errorMsg });
          }
        }
      }
    }

    // Per-model summary event
    const modelScores = allScores.filter((s) => s.model === model);
    if (modelScores.length > 0) {
      onProgress?.({
        type: "model-complete",
        model,
        summary: computeModelSummary(modelScores),
      });
    }
  }

  // Compute final summary
  const summary = computeSummary(allScores, tasks, config.compareBaseline);
  const completedAt = new Date().toISOString();

  onProgress?.({ type: "complete", summary });

  const results: BenchmarkResults = {
    config,
    startedAt,
    completedAt,
    hardware,
    results: allScores,
    summary,
  };

  // Write full results JSON
  const jsonPath = path.join(config.outputDir, `benchmark-${timestamp}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  return results;
}
