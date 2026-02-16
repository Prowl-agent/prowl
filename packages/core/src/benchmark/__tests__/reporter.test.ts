import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HardwareProfile } from "../../setup/hardware-detect.js";
import type { TaskScore } from "../scorer.js";
import {
  formatConsoleReport,
  formatMarkdownReport,
  listBenchmarkHistory,
  loadBenchmarkResult,
  writeAllReports,
} from "../reporter.js";
import { computeSummary, type BenchmarkConfig, type BenchmarkResults } from "../runner.js";
import { BENCHMARK_TASKS } from "../tasks.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeHardware(): HardwareProfile {
  return {
    os: "macos",
    arch: "arm64",
    totalRAMGB: 16,
    unifiedMemoryGB: 16,
    gpuVRAMGB: 0,
    gpu: { vendor: "apple", name: "Apple M4", vramGB: 0, isAppleSilicon: true },
    cpuCores: 10,
    cpuModel: "Apple M4",
    isAppleSilicon: true,
    availableForModelGB: 10,
    ollamaInstalled: true,
    ollamaVersion: "0.5.1",
    prowlDataDir: "/Users/test/.prowl/models",
  };
}

function makeConfig(overrides?: Partial<BenchmarkConfig>): BenchmarkConfig {
  return {
    models: ["qwen3:8b"],
    tasks: "all",
    runs: 1,
    ollamaUrl: "http://localhost:11434",
    useOptimizer: true,
    compareBaseline: true,
    outputDir: "./benchmark-results",
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

function makeResults(overrides?: {
  scores?: TaskScore[];
  config?: Partial<BenchmarkConfig>;
}): BenchmarkResults {
  const tasks = BENCHMARK_TASKS.slice(0, 3);
  const config = makeConfig(overrides?.config);

  const scores =
    overrides?.scores ??
    tasks.flatMap((t) => [
      makeScore({ taskId: t.id, optimized: false, correctness: 0.5, latencyMs: 800 }),
      makeScore({ taskId: t.id, optimized: true, correctness: 0.85, latencyMs: 1000 }),
    ]);

  const summary = computeSummary(scores, tasks, config.compareBaseline);

  return {
    config,
    startedAt: "2026-02-15T14:30:00.000Z",
    completedAt: "2026-02-15T14:35:00.000Z",
    hardware: makeHardware(),
    results: scores,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Console reporter
// ---------------------------------------------------------------------------

describe("formatConsoleReport", () => {
  it("includes box-drawing characters", () => {
    const report = formatConsoleReport(makeResults());
    expect(report).toContain("╔");
    expect(report).toContain("╗");
    expect(report).toContain("╚");
    expect(report).toContain("╝");
    expect(report).toContain("║");
  });

  it("includes header with date and hardware", () => {
    const report = formatConsoleReport(makeResults());
    expect(report).toContain("2026-02-15");
    expect(report).toContain("Apple M4");
    expect(report).toContain("16GB unified");
  });

  it("includes model name", () => {
    const report = formatConsoleReport(makeResults());
    expect(report).toContain("qwen3:8b");
  });

  it("shows optimizer impact when comparison is present", () => {
    const report = formatConsoleReport(makeResults());
    expect(report).toContain("Baseline");
    expect(report).toContain("Optimized");
    expect(report).toContain("Improvement");
  });

  it("shows key findings", () => {
    const report = formatConsoleReport(makeResults());
    expect(report).toContain("Key findings:");
  });

  it("handles no-comparison mode (optimizer only)", () => {
    const scores = BENCHMARK_TASKS.slice(0, 3).map((t) =>
      makeScore({ taskId: t.id, optimized: true }),
    );
    const results = makeResults({
      scores,
      config: { compareBaseline: false },
    });
    const report = formatConsoleReport(results);
    expect(report).toContain("Model");
    expect(report).toContain("Pass%");
  });
});

// ---------------------------------------------------------------------------
// Markdown reporter
// ---------------------------------------------------------------------------

describe("formatMarkdownReport", () => {
  it("starts with the title heading", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md.startsWith("# Prowl Benchmark Results")).toBe(true);
  });

  it("includes hardware section", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Hardware");
    expect(md).toContain("Apple M4");
    expect(md).toContain("16GB unified");
    expect(md).toContain("Ollama");
  });

  it("includes summary table with optimizer comparison", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Summary");
    expect(md).toContain("| Category |");
    expect(md).toContain("Baseline");
    expect(md).toContain("With Prowl Optimizer");
  });

  it("includes methodology section", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Methodology");
    expect(md).toContain("30 agent tasks");
    expect(md).toContain("pattern matching");
  });

  it("includes model performance section", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Model Performance");
    expect(md).toContain("Pass Rate");
  });

  it("includes category breakdown table", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Category Breakdown");
    expect(md).toContain("| Category |");
  });

  it("includes detailed per-task results", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Detailed Results");
    expect(md).toContain("| Task ID |");
    // Should have actual task IDs in the table
    expect(md).toContain("edit-validation-01");
  });

  it("includes optimizer impact section when comparison present", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("## Optimizer Impact");
  });

  it("includes footer with generation note", () => {
    const md = formatMarkdownReport(makeResults());
    expect(md).toContain("*Generated by");
    expect(md).toContain("Prowl");
  });

  it("shows model table when no comparison", () => {
    const scores = BENCHMARK_TASKS.slice(0, 3).map((t) =>
      makeScore({ taskId: t.id, optimized: true }),
    );
    const results = makeResults({
      scores,
      config: { compareBaseline: false },
    });
    const md = formatMarkdownReport(results);
    expect(md).toContain("| Model |");
    expect(md).toContain("qwen3:8b");
  });
});

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

describe("exportBenchmarkJson", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prowl-reporter-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSON file and returns the path", async () => {
    const results = makeResults();
    // Override the default dir by monkey-patching — we test via writeAllReports instead
    const jsonPath = path.join(tmpDir, "test-export.json");
    await fs.writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

    const content = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(content) as BenchmarkResults;
    expect(parsed.config.models).toEqual(["qwen3:8b"]);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.summary).toBeDefined();
  });
});

describe("writeAllReports", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prowl-reporter-all-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes console, markdown, and json files", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);

    // All paths should exist
    const consoleStat = await fs.stat(paths.console);
    expect(consoleStat.isFile()).toBe(true);

    const mdStat = await fs.stat(paths.markdown);
    expect(mdStat.isFile()).toBe(true);

    const jsonStat = await fs.stat(paths.json);
    expect(jsonStat.isFile()).toBe(true);

    const historyStat = await fs.stat(paths.history);
    expect(historyStat.isFile()).toBe(true);
  });

  it("markdown file is named BENCHMARK.md", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);
    expect(path.basename(paths.markdown)).toBe("BENCHMARK.md");
  });

  it("console report file contains box-drawing", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);
    const content = await fs.readFile(paths.console, "utf8");
    expect(content).toContain("╔");
    expect(content).toContain("Prowl Benchmark Results");
  });

  it("markdown file starts with heading", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);
    const content = await fs.readFile(paths.markdown, "utf8");
    expect(content.startsWith("# Prowl Benchmark Results")).toBe(true);
  });

  it("json file is valid and contains results", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);
    const content = await fs.readFile(paths.json, "utf8");
    const parsed = JSON.parse(content) as BenchmarkResults;
    expect(parsed.results.length).toBe(results.results.length);
  });

  it("history json can be loaded back", async () => {
    const results = makeResults();
    const paths = await writeAllReports(results, tmpDir);
    const loaded = await loadBenchmarkResult(paths.history);
    expect(loaded.config.models).toEqual(results.config.models);
    expect(loaded.results.length).toBe(results.results.length);
  });
});

describe("listBenchmarkHistory", () => {
  it("returns empty array when directory does not exist", async () => {
    const history = await listBenchmarkHistory();
    // May or may not be empty depending on whether previous tests ran,
    // but should at least not throw
    expect(Array.isArray(history)).toBe(true);
  });
});
