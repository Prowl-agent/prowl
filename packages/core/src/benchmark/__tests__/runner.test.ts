import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskScore } from "../scorer.js";
import {
  computeCategorySummary,
  computeModelSummary,
  computeOptimizerImpact,
  computeSummary,
  formatSummaryTable,
  runBenchmark,
  validateConfig,
  type BenchmarkConfig,
  type BenchmarkProgressEvent,
} from "../runner.js";
import { BENCHMARK_TASKS } from "../tasks.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<BenchmarkConfig>): BenchmarkConfig {
  return {
    models: ["qwen3:8b"],
    tasks: "all",
    runs: 1,
    ollamaUrl: "http://localhost:11434",
    useOptimizer: true,
    compareBaseline: true,
    outputDir: "",
    concurrency: 1,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function makeScore(overrides?: Partial<TaskScore>): TaskScore {
  return {
    taskId: "edit-validation-01",
    model: "qwen3:8b",
    optimized: true,
    correctness: 0.8,
    completeness: 0.7,
    toolUseAccuracy: 1.0,
    formatCompliance: 0.9,
    tokenEfficiency: 0.85,
    latencyMs: 1200,
    totalTokens: 450,
    retries: 0,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const errors = validateConfig(makeConfig());
    expect(errors).toHaveLength(0);
  });

  it("rejects empty models array", () => {
    const errors = validateConfig(makeConfig({ models: [] }));
    expect(errors.some((e) => e.field === "models")).toBe(true);
  });

  it("rejects invalid model names", () => {
    const errors = validateConfig(makeConfig({ models: ["", "  "] }));
    expect(errors.filter((e) => e.field === "models").length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown task IDs", () => {
    const errors = validateConfig(makeConfig({ tasks: ["nonexistent-task-xyz"] }));
    expect(errors.some((e) => e.field === "tasks")).toBe(true);
  });

  it("accepts valid task IDs", () => {
    const errors = validateConfig(makeConfig({ tasks: ["edit-validation-01", "gen-debounce-01"] }));
    expect(errors.filter((e) => e.field === "tasks")).toHaveLength(0);
  });

  it("rejects runs out of range", () => {
    expect(validateConfig(makeConfig({ runs: 0 })).some((e) => e.field === "runs")).toBe(true);
    expect(validateConfig(makeConfig({ runs: 100 })).some((e) => e.field === "runs")).toBe(true);
  });

  it("rejects invalid concurrency", () => {
    expect(
      validateConfig(makeConfig({ concurrency: 0 })).some((e) => e.field === "concurrency"),
    ).toBe(true);
    expect(
      validateConfig(makeConfig({ concurrency: 20 })).some((e) => e.field === "concurrency"),
    ).toBe(true);
  });

  it("rejects timeout below minimum", () => {
    expect(
      validateConfig(makeConfig({ timeoutMs: 100 })).some((e) => e.field === "timeoutMs"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

describe("computeModelSummary", () => {
  it("computes averages correctly", () => {
    const scores = [
      makeScore({ correctness: 1.0, completeness: 0.8, latencyMs: 1000, totalTokens: 200 }),
      makeScore({ correctness: 0.5, completeness: 0.6, latencyMs: 2000, totalTokens: 400 }),
    ];
    const summary = computeModelSummary(scores);
    expect(summary.avgCorrectness).toBe(0.75);
    expect(summary.avgCompleteness).toBe(0.7);
    expect(summary.totalTasks).toBe(2);
    expect(summary.avgLatencyMs).toBe(1500);
    expect(summary.avgTokens).toBe(300);
  });

  it("computes pass rate with 0.7 threshold", () => {
    const scores = [
      makeScore({ correctness: 0.8 }),
      makeScore({ correctness: 0.9 }),
      makeScore({ correctness: 0.5 }),
      makeScore({ correctness: 0.3 }),
    ];
    const summary = computeModelSummary(scores);
    // 2 out of 4 pass (>= 0.7)
    expect(summary.passRate).toBe(0.5);
  });

  it("returns zeros for empty input", () => {
    const summary = computeModelSummary([]);
    expect(summary.avgCorrectness).toBe(0);
    expect(summary.totalTasks).toBe(0);
    expect(summary.passRate).toBe(0);
  });
});

describe("computeCategorySummary", () => {
  it("finds the best model for a category", () => {
    const tasks = BENCHMARK_TASKS.filter((t) => t.category === "single-file-edit");
    const taskIds = tasks.map((t) => t.id);

    const scores = [
      makeScore({ taskId: taskIds[0], model: "qwen3:8b", correctness: 0.9 }),
      makeScore({ taskId: taskIds[1], model: "qwen3:8b", correctness: 0.8 }),
      makeScore({ taskId: taskIds[0], model: "qwen3:4b", correctness: 0.5 }),
      makeScore({ taskId: taskIds[1], model: "qwen3:4b", correctness: 0.6 }),
    ];

    const summary = computeCategorySummary(scores, BENCHMARK_TASKS, "single-file-edit");
    expect(summary.bestModel).toBe("qwen3:8b");
    expect(summary.avgCorrectness).toBeGreaterThan(0);
  });
});

describe("computeOptimizerImpact", () => {
  it("detects improvement when optimized scores higher", () => {
    const tasks = BENCHMARK_TASKS.slice(0, 4);
    const scores = tasks.flatMap((t) => [
      makeScore({ taskId: t.id, optimized: false, correctness: 0.5 }),
      makeScore({ taskId: t.id, optimized: true, correctness: 0.9 }),
    ]);

    const impact = computeOptimizerImpact(scores, tasks);
    expect(impact).toBeDefined();
    expect(impact!.optimizedPassRate).toBeGreaterThan(impact!.baselinePassRate);
    expect(impact!.improvement).toBeGreaterThan(0);
  });

  it("returns undefined when no baseline or no optimized scores", () => {
    const tasks = BENCHMARK_TASKS.slice(0, 2);
    const onlyOptimized = tasks.map((t) => makeScore({ taskId: t.id, optimized: true }));
    expect(computeOptimizerImpact(onlyOptimized, tasks)).toBeUndefined();
  });
});

describe("computeSummary", () => {
  it("groups by model and category", () => {
    const tasks = BENCHMARK_TASKS.slice(0, 3);
    const scores = tasks.flatMap((t) => [
      makeScore({ taskId: t.id, model: "qwen3:8b", optimized: true, correctness: 0.8 }),
      makeScore({ taskId: t.id, model: "qwen3:8b", optimized: false, correctness: 0.6 }),
    ]);

    const summary = computeSummary(scores, tasks, true);
    expect(summary.byModel["qwen3:8b"]).toBeDefined();
    expect(summary.byModel["qwen3:8b (baseline)"]).toBeDefined();
    expect(summary.optimizerImpact).toBeDefined();
    expect(Object.keys(summary.byCategory).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Summary table formatting
// ---------------------------------------------------------------------------

describe("formatSummaryTable", () => {
  it("produces a non-empty string with headers", () => {
    const tasks = BENCHMARK_TASKS.slice(0, 2);
    const scores = tasks.map((t) => makeScore({ taskId: t.id }));
    const summary = computeSummary(scores, tasks, false);
    const table = formatSummaryTable(summary);

    expect(table).toContain("BENCHMARK RESULTS");
    expect(table).toContain("Model");
    expect(table).toContain("Category");
  });

  it("includes optimizer impact when present", () => {
    const tasks = BENCHMARK_TASKS.slice(0, 2);
    const scores = tasks.flatMap((t) => [
      makeScore({ taskId: t.id, optimized: false, correctness: 0.5 }),
      makeScore({ taskId: t.id, optimized: true, correctness: 0.9 }),
    ]);
    const summary = computeSummary(scores, tasks, true);
    const table = formatSummaryTable(summary);

    expect(table).toContain("OPTIMIZER IMPACT");
    expect(table).toContain("Baseline pass rate");
    expect(table).toContain("Optimized pass rate");
  });
});

// ---------------------------------------------------------------------------
// Runner integration (mocked Ollama)
// ---------------------------------------------------------------------------

describe("runBenchmark", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prowl-bench-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Mock global fetch to simulate Ollama responses
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setupOllamaMock(): void {
    mockFetch.mockImplementation(async (url: string) => {
      const urlStr = typeof url === "string" ? url : String(url);

      // /api/version — Ollama running check
      if (urlStr.includes("/api/version")) {
        return new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 });
      }

      // /api/tags — list installed models
      if (urlStr.includes("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen3:8b", size: 5_000_000_000 },
              { name: "qwen3:4b", size: 2_500_000_000 },
            ],
          }),
          { status: 200 },
        );
      }

      // /api/generate — mock inference
      if (urlStr.includes("/api/generate")) {
        return new Response(
          JSON.stringify({
            response:
              "Here is the solution:\n```javascript\nfunction validate(name, age, email) {\n  if (typeof name !== 'string') throw new Error('invalid');\n  if (age <= 0) throw new Error('invalid age');\n  if (!email.includes('@')) throw new Error('invalid email');\n}\n```",
            eval_count: 120,
            prompt_eval_count: 80,
          }),
          { status: 200 },
        );
      }

      return new Response("Not found", { status: 404 });
    });
  }

  it("throws on invalid config", async () => {
    await expect(runBenchmark(makeConfig({ models: [], outputDir: tmpDir }))).rejects.toThrow(
      "Invalid benchmark config",
    );
  });

  it("throws when Ollama is not running", async () => {
    mockFetch.mockImplementation(async () => {
      throw new Error("Connection refused");
    });

    await expect(
      runBenchmark(makeConfig({ outputDir: tmpDir, tasks: ["edit-validation-01"] })),
    ).rejects.toThrow("Ollama is not running");
  });

  it("throws when models are not installed", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/version")) {
        return new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 });
      }
      if (String(url).includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    await expect(
      runBenchmark(makeConfig({ outputDir: tmpDir, tasks: ["edit-validation-01"] })),
    ).rejects.toThrow("Models not installed");
  });

  it("runs a single task and produces results", async () => {
    setupOllamaMock();

    const events: BenchmarkProgressEvent[] = [];
    const results = await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 1,
        outputDir: tmpDir,
      }),
      (e) => events.push(e),
    );

    // Should have both baseline and optimized results
    expect(results.results.length).toBe(2);
    expect(results.results.some((r) => r.optimized)).toBe(true);
    expect(results.results.some((r) => !r.optimized)).toBe(true);

    // All scores should be populated
    for (const score of results.results) {
      expect(score.taskId).toBe("edit-validation-01");
      expect(score.model).toBe("qwen3:8b");
      expect(typeof score.correctness).toBe("number");
      expect(typeof score.latencyMs).toBe("number");
    }

    // Summary should exist
    expect(results.summary.byModel).toBeDefined();
    expect(Object.keys(results.summary.byModel).length).toBeGreaterThan(0);

    // Progress events should have been fired
    expect(events.some((e) => e.type === "start")).toBe(true);
    expect(events.some((e) => e.type === "task-complete")).toBe(true);
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });

  it("writes JSONL file with streaming results", async () => {
    setupOllamaMock();

    await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 1,
        outputDir: tmpDir,
      }),
    );

    // Find the JSONL file
    const files = await fs.readdir(tmpDir);
    const jsonlFile = files.find((f) => f.endsWith(".jsonl"));
    expect(jsonlFile).toBeDefined();

    const content = await fs.readFile(path.join(tmpDir, jsonlFile!), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // baseline + optimized

    // Each line should be valid JSON with TaskScore fields
    for (const line of lines) {
      const parsed = JSON.parse(line) as TaskScore;
      expect(parsed.taskId).toBe("edit-validation-01");
      expect(typeof parsed.correctness).toBe("number");
    }
  });

  it("writes full results JSON file", async () => {
    setupOllamaMock();

    await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 1,
        outputDir: tmpDir,
      }),
    );

    const files = await fs.readdir(tmpDir);
    const jsonFile = files.find((f) => f.endsWith(".json"));
    expect(jsonFile).toBeDefined();

    const content = await fs.readFile(path.join(tmpDir, jsonFile!), "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.config).toBeDefined();
    expect(parsed.hardware).toBeDefined();
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.summary).toBeDefined();
    expect(parsed.startedAt).toBeDefined();
    expect(parsed.completedAt).toBeDefined();
  });

  it("runs only baseline when optimizer is disabled", async () => {
    setupOllamaMock();

    const results = await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 1,
        useOptimizer: false,
        compareBaseline: true,
        outputDir: tmpDir,
      }),
    );

    expect(results.results.length).toBe(1);
    expect(results.results[0].optimized).toBe(false);
  });

  it("runs only optimized when baseline is disabled", async () => {
    setupOllamaMock();

    const results = await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 1,
        useOptimizer: true,
        compareBaseline: false,
        outputDir: tmpDir,
      }),
    );

    expect(results.results.length).toBe(1);
    expect(results.results[0].optimized).toBe(true);
  });

  it("respects category filter", async () => {
    setupOllamaMock();

    const results = await runBenchmark(
      makeConfig({
        tasks: "all",
        categories: ["tool-use"],
        runs: 1,
        useOptimizer: true,
        compareBaseline: false,
        outputDir: tmpDir,
      }),
    );

    const toolTaskIds = new Set(
      BENCHMARK_TASKS.filter((t) => t.category === "tool-use").map((t) => t.id),
    );
    for (const score of results.results) {
      expect(toolTaskIds.has(score.taskId)).toBe(true);
    }
    expect(results.results.length).toBe(toolTaskIds.size);
  });

  it("runs multiple times when runs > 1", async () => {
    setupOllamaMock();

    const results = await runBenchmark(
      makeConfig({
        tasks: ["edit-validation-01"],
        runs: 3,
        useOptimizer: true,
        compareBaseline: false,
        outputDir: tmpDir,
      }),
    );

    expect(results.results.length).toBe(3);
  });
});
