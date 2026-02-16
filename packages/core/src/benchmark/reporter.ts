import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HardwareProfile } from "../setup/hardware-detect.js";
import type { BenchmarkResults } from "./runner.js";
import type { TaskScore } from "./scorer.js";
import type { TaskCategory } from "./types.js";
import { BENCHMARK_TASKS } from "./tasks.js";

// ---------------------------------------------------------------------------
// Display-name mappings
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  "single-file-edit": "Single-File Edit",
  "code-generation": "Code Generation",
  "tool-use": "Tool Use",
  reasoning: "Reasoning",
  documentation: "Documentation",
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat as TaskCategory] ?? cat;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function sign(value: number): string {
  return value >= 0 ? "+" : "";
}

function pts(value: number): string {
  return `${sign(value)}${(value * 100).toFixed(0)} pts`;
}

function hardwareOneLiner(hw: HardwareProfile): string {
  const chip = hw.gpu.name !== "Unknown GPU" ? hw.gpu.name : hw.cpuModel;
  const mem = hw.isAppleSilicon
    ? `${hw.unifiedMemoryGB}GB unified`
    : hw.gpuVRAMGB > 0
      ? `${hw.gpuVRAMGB}GB VRAM, ${hw.totalRAMGB}GB RAM`
      : `${hw.totalRAMGB}GB RAM`;
  return `${chip}, ${mem}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso.slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// 3A: Console Reporter
// ---------------------------------------------------------------------------

/**
 * Pretty-print benchmark results to a terminal-friendly box-drawn table.
 * Returns the full string — caller can console.log() it.
 */
export function formatConsoleReport(results: BenchmarkResults): string {
  const W = 64; // inner width
  const border = "═".repeat(W);
  const divider = "─".repeat(W - 2);
  const { summary, hardware, config, results: scores } = results;
  const models = config.models;

  const lines: string[] = [];

  // Header box
  lines.push(`╔${border}╗`);
  lines.push(boxLine(W, `Prowl Benchmark Results — ${formatDate(results.startedAt)}`));
  lines.push(boxLine(W, `Hardware: ${hardwareOneLiner(hardware)}`));
  lines.push(boxLine(W, `Model${models.length > 1 ? "s" : ""}: ${models.join(", ")}`));
  lines.push(boxLine(W, `Tasks: ${scores.length} runs, ${config.runs}x each`));
  lines.push(`╠${border}╣`);

  // Comparison table (baseline vs optimized) when both are present
  if (summary.optimizerImpact) {
    lines.push(boxLine(W, ""));
    lines.push(
      boxLine(W, padRow("Category", "Baseline", "Optimized", "Improvement", 18, 10, 11, 15)),
    );
    lines.push(boxLine(W, `  ${divider}`));

    const allCategories = Object.keys(summary.byCategory);
    const catDetails = buildCategoryComparison(scores, allCategories);

    for (const cd of catDetails) {
      const imp = cd.improvement;
      const marker = imp >= 0.05 ? " ✅" : imp <= -0.05 ? " ⚠️" : "";
      lines.push(
        boxLine(
          W,
          padRow(
            categoryLabel(cd.category),
            pct(cd.baselinePassRate),
            pct(cd.optimizedPassRate),
            `${pts(imp)}${marker}`,
            18,
            10,
            11,
            15,
          ),
        ),
      );
    }

    // Overall row
    const imp = summary.optimizerImpact;
    lines.push(boxLine(W, `  ${divider}`));
    const overallMarker = imp.improvement >= 0.05 ? " ✅" : "";
    lines.push(
      boxLine(
        W,
        padRow(
          "Overall",
          pct(imp.baselinePassRate),
          pct(imp.optimizedPassRate),
          `${pts(imp.improvement)}${overallMarker}`,
          18,
          10,
          11,
          15,
        ),
      ),
    );
    lines.push(boxLine(W, ""));

    // Key findings
    lines.push(boxLine(W, "Key findings:"));
    const findings = generateFindings(results);
    for (const f of findings) {
      lines.push(boxLine(W, `  • ${f}`));
    }
  } else {
    // No comparison — just show model table
    lines.push(boxLine(W, ""));
    lines.push(boxLine(W, padRow("Model", "Pass%", "Correct", "Latency", 26, 8, 10, 10)));
    lines.push(boxLine(W, `  ${divider}`));

    for (const [model, s] of Object.entries(summary.byModel)) {
      lines.push(
        boxLine(
          W,
          padRow(
            truncate(model, 24),
            pct(s.passRate),
            s.avgCorrectness.toFixed(2),
            `${Math.round(s.avgLatencyMs)}ms`,
            26,
            8,
            10,
            10,
          ),
        ),
      );
    }
  }

  lines.push(boxLine(W, ""));
  lines.push(`╚${border}╝`);
  return lines.join("\n");
}

function boxLine(innerWidth: number, content: string): string {
  // Strip ANSI for length calculation
  const visibleLen = stripAnsi(content).length;
  const padded =
    visibleLen < innerWidth
      ? `${content}${" ".repeat(innerWidth - visibleLen)}`
      : content.slice(0, innerWidth);
  return `║  ${padded}║`;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001B\[[0-9;]*m/g, "");
}

function padRow(
  col1: string,
  col2: string,
  col3: string,
  col4: string,
  w1: number,
  w2: number,
  w3: number,
  w4: number,
): string {
  return `${col1.padEnd(w1)}│${col2.padStart(w2)} │${col3.padStart(w3)} │${col4.padStart(w4)}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return `${str.slice(0, maxLen - 3)}...`;
}

interface CategoryComparison {
  category: string;
  baselinePassRate: number;
  optimizedPassRate: number;
  improvement: number;
}

function buildCategoryComparison(scores: TaskScore[], categories: string[]): CategoryComparison[] {
  return categories.map((cat) => {
    const catTaskIds = new Set(BENCHMARK_TASKS.filter((t) => t.category === cat).map((t) => t.id));
    const catScores = scores.filter((s) => catTaskIds.has(s.taskId));
    const baseline = catScores.filter((s) => !s.optimized);
    const optimized = catScores.filter((s) => s.optimized);

    const bPass = passRate(baseline);
    const oPass = passRate(optimized);

    return {
      category: cat,
      baselinePassRate: bPass,
      optimizedPassRate: oPass,
      improvement: oPass - bPass,
    };
  });
}

function passRate(scores: TaskScore[], threshold = 0.7): number {
  if (scores.length === 0) {
    return 0;
  }
  return scores.filter((s) => s.correctness >= threshold).length / scores.length;
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function generateFindings(results: BenchmarkResults): string[] {
  const findings: string[] = [];
  const { summary, results: scores } = results;

  if (summary.optimizerImpact) {
    const imp = summary.optimizerImpact;

    // Biggest improvement category
    if (imp.categoriesImproved.length > 0) {
      const catComps = buildCategoryComparison(scores, imp.categoriesImproved);
      catComps.sort((a, b) => b.improvement - a.improvement);
      const best = catComps[0];
      if (best) {
        findings.push(
          `${categoryLabel(best.category)} saw biggest improvement (${pts(best.improvement)})`,
        );
      }
    }

    // Latency overhead
    const baselineLatency = avg(scores.filter((s) => !s.optimized).map((s) => s.latencyMs));
    const optimizedLatency = avg(scores.filter((s) => s.optimized).map((s) => s.latencyMs));
    const overhead = optimizedLatency - baselineLatency;
    if (Math.abs(overhead) > 10) {
      const direction = overhead > 0 ? "adds" : "saves";
      findings.push(
        `Optimizer ${direction} ~${Math.abs(Math.round(overhead))}ms avg latency per task`,
      );
    }

    // Regressed tasks
    const regressedTasks = findRegressedTasks(scores);
    if (regressedTasks.length > 0) {
      const taskList = regressedTasks.slice(0, 3).join(", ");
      const more = regressedTasks.length > 3 ? ` +${regressedTasks.length - 3} more` : "";
      findings.push(`${regressedTasks.length} task(s) regressed (investigate: ${taskList}${more})`);
    }

    // Overall improvement
    if (imp.improvement > 0.01) {
      findings.push(`Overall pass rate improved by ${pts(imp.improvement)}`);
    } else if (imp.improvement < -0.01) {
      findings.push(`Overall pass rate decreased by ${pts(Math.abs(imp.improvement))}`);
    }
  }

  if (findings.length === 0) {
    findings.push("No comparison data — run with --compare-baseline for optimizer impact analysis");
  }

  return findings;
}

/** Find task IDs where optimized scored lower than baseline. */
function findRegressedTasks(scores: TaskScore[]): string[] {
  const taskIds = [...new Set(scores.map((s) => s.taskId))];
  const regressed: string[] = [];

  for (const taskId of taskIds) {
    const baseline = scores.filter((s) => s.taskId === taskId && !s.optimized);
    const optimized = scores.filter((s) => s.taskId === taskId && s.optimized);

    if (baseline.length === 0 || optimized.length === 0) {
      continue;
    }

    const bAvg = avg(baseline.map((s) => s.correctness));
    const oAvg = avg(optimized.map((s) => s.correctness));

    if (bAvg > oAvg + 0.05) {
      regressed.push(taskId);
    }
  }

  return regressed;
}

// ---------------------------------------------------------------------------
// 3B: Markdown Reporter
// ---------------------------------------------------------------------------

/**
 * Generate a BENCHMARK.md string suitable for the repo root or a blog post.
 */
export function formatMarkdownReport(results: BenchmarkResults): string {
  const { summary, hardware, config, results: scores } = results;
  const lines: string[] = [];

  lines.push("# Prowl Benchmark Results");
  lines.push("");
  lines.push(`> Generated on ${formatDate(results.startedAt)}`);
  lines.push("");

  // Hardware section
  lines.push("## Hardware");
  lines.push("");
  lines.push(
    `- **Device**: ${hardware.gpu.name !== "Unknown GPU" ? hardware.gpu.name : hardware.cpuModel}`,
  );
  if (hardware.isAppleSilicon) {
    lines.push(`- **Memory**: ${hardware.unifiedMemoryGB}GB unified`);
  } else if (hardware.gpuVRAMGB > 0) {
    lines.push(`- **GPU VRAM**: ${hardware.gpuVRAMGB}GB`);
    lines.push(`- **RAM**: ${hardware.totalRAMGB}GB`);
  } else {
    lines.push(`- **RAM**: ${hardware.totalRAMGB}GB`);
  }
  lines.push(`- **OS**: ${hardware.os} (${hardware.arch})`);
  lines.push(`- **Ollama**: ${hardware.ollamaVersion ?? "unknown version"}`);
  lines.push(`- **Model${config.models.length > 1 ? "s" : ""}**: ${config.models.join(", ")}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");

  if (summary.optimizerImpact) {
    lines.push("| Category | Baseline | With Prowl Optimizer | Change |");
    lines.push("|----------|----------|---------------------|--------|");

    const catComps = buildCategoryComparison(scores, Object.keys(summary.byCategory));
    for (const cd of catComps) {
      const change = pts(cd.improvement);
      lines.push(
        `| ${categoryLabel(cd.category)} | ${pct(cd.baselinePassRate)} | ${pct(cd.optimizedPassRate)} | ${change} |`,
      );
    }

    const imp = summary.optimizerImpact;
    lines.push(
      `| **Overall** | **${pct(imp.baselinePassRate)}** | **${pct(imp.optimizedPassRate)}** | **${pts(imp.improvement)}** |`,
    );
    lines.push("");
  } else {
    lines.push("| Model | Pass Rate | Avg Correctness | Avg Latency |");
    lines.push("|-------|-----------|----------------|-------------|");
    for (const [model, s] of Object.entries(summary.byModel)) {
      lines.push(
        `| ${model} | ${pct(s.passRate)} | ${s.avgCorrectness.toFixed(2)} | ${Math.round(s.avgLatencyMs)}ms |`,
      );
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology");
  lines.push("");
  lines.push(`- **${BENCHMARK_TASKS.length} agent tasks** across 5 categories`);
  lines.push(
    `- Each task run **${config.runs} time${config.runs > 1 ? "s" : ""}**, scores averaged`,
  );
  if (config.compareBaseline) {
    lines.push("- **Baseline**: raw Ollama call, default parameters");
  }
  if (config.useOptimizer) {
    lines.push(
      "- **Optimized**: Prowl prompt optimizer (tier-aware system prompts + sampling tuning)",
    );
  }
  lines.push("- **Scoring**: automated pattern matching + tool call verification");
  if (config.llmJudgeModel) {
    lines.push(`- **LLM-as-judge fallback**: ${config.llmJudgeModel} for subjective criteria`);
  }
  lines.push(`- **Timeout**: ${config.timeoutMs / 1000}s per task`);
  lines.push("");

  // Per-model detail tables
  lines.push("## Model Performance");
  lines.push("");
  for (const [model, s] of Object.entries(summary.byModel)) {
    lines.push(`### ${model}`);
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Pass Rate (>70% correctness) | ${pct(s.passRate)} |`);
    lines.push(`| Avg Correctness | ${s.avgCorrectness.toFixed(3)} |`);
    lines.push(`| Avg Completeness | ${s.avgCompleteness.toFixed(3)} |`);
    lines.push(`| Avg Tool Accuracy | ${s.avgToolAccuracy.toFixed(3)} |`);
    lines.push(`| Avg Latency | ${Math.round(s.avgLatencyMs)}ms |`);
    lines.push(`| Avg Tokens | ${Math.round(s.avgTokens)} |`);
    lines.push(`| Total Tasks | ${s.totalTasks} |`);
    lines.push("");
  }

  // Category breakdown
  lines.push("## Category Breakdown");
  lines.push("");
  lines.push("| Category | Pass Rate | Avg Correctness | Best Model |");
  lines.push("|----------|-----------|----------------|------------|");
  for (const [cat, s] of Object.entries(summary.byCategory)) {
    lines.push(
      `| ${categoryLabel(cat)} | ${pct(s.passRate)} | ${s.avgCorrectness.toFixed(3)} | ${s.bestModel} |`,
    );
  }
  lines.push("");

  // Detailed per-task results
  lines.push("## Detailed Results");
  lines.push("");
  lines.push("| Task ID | Model | Optimized | Correctness | Completeness | Latency |");
  lines.push("|---------|-------|-----------|-------------|-------------|---------|");
  for (const s of scores) {
    lines.push(
      `| ${s.taskId} | ${s.model} | ${s.optimized ? "Yes" : "No"} | ${s.correctness.toFixed(2)} | ${s.completeness.toFixed(2)} | ${Math.round(s.latencyMs)}ms |`,
    );
  }
  lines.push("");

  // Optimizer impact
  if (summary.optimizerImpact) {
    lines.push("## Optimizer Impact");
    lines.push("");
    const imp = summary.optimizerImpact;
    lines.push(`- **Baseline pass rate**: ${pct(imp.baselinePassRate)}`);
    lines.push(`- **Optimized pass rate**: ${pct(imp.optimizedPassRate)}`);
    lines.push(`- **Improvement**: ${pts(imp.improvement)}`);
    if (imp.categoriesImproved.length > 0) {
      lines.push(`- **Improved**: ${imp.categoriesImproved.map(categoryLabel).join(", ")}`);
    }
    if (imp.categoriesRegressed.length > 0) {
      lines.push(`- **Regressed**: ${imp.categoriesRegressed.map(categoryLabel).join(", ")}`);
    }

    const regressed = findRegressedTasks(scores);
    if (regressed.length > 0) {
      lines.push("");
      lines.push("### Tasks That Regressed");
      lines.push("");
      lines.push("| Task ID | Baseline | Optimized | Delta |");
      lines.push("|---------|----------|-----------|-------|");
      for (const taskId of regressed) {
        const bScores = scores.filter((s) => s.taskId === taskId && !s.optimized);
        const oScores = scores.filter((s) => s.taskId === taskId && s.optimized);
        const bAvg = avg(bScores.map((s) => s.correctness));
        const oAvg = avg(oScores.map((s) => s.correctness));
        lines.push(
          `| ${taskId} | ${bAvg.toFixed(2)} | ${oAvg.toFixed(2)} | ${(oAvg - bAvg).toFixed(2)} |`,
        );
      }
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(
    `*Generated by [Prowl](https://github.com/openclaw/openclaw) benchmark suite on ${formatDate(results.startedAt)}*`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 3C: JSON Export to ~/.prowl/benchmarks/
// ---------------------------------------------------------------------------

const PROWL_BENCHMARKS_DIR = path.join(os.homedir(), ".prowl", "benchmarks");

/**
 * Write the full benchmark results to ~/.prowl/benchmarks/YYYY-MM-DD-HHmmss.json
 * for historical tracking. Returns the file path written.
 */
export async function exportBenchmarkJson(results: BenchmarkResults): Promise<string> {
  await fs.mkdir(PROWL_BENCHMARKS_DIR, { recursive: true });

  const timestamp = results.startedAt.replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  const fileName = `${timestamp}.json`;
  const filePath = path.join(PROWL_BENCHMARKS_DIR, fileName);

  await fs.writeFile(filePath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  return filePath;
}

/**
 * List all previously saved benchmark results.
 * Returns paths sorted newest-first.
 */
export async function listBenchmarkHistory(): Promise<string[]> {
  try {
    const files = await fs.readdir(PROWL_BENCHMARKS_DIR);
    return files
      .filter((f) => f.endsWith(".json"))
      .toSorted()
      .toReversed()
      .map((f) => path.join(PROWL_BENCHMARKS_DIR, f));
  } catch {
    return [];
  }
}

/**
 * Load a benchmark result from a JSON file.
 */
export async function loadBenchmarkResult(filePath: string): Promise<BenchmarkResults> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as BenchmarkResults;
}

// ---------------------------------------------------------------------------
// Convenience: write all report formats at once
// ---------------------------------------------------------------------------

export interface ReportOutputPaths {
  console: string;
  markdown: string;
  json: string;
  history: string;
}

/**
 * Write all report formats — console (to stdout), markdown (to file),
 * JSON (to outputDir), and historical JSON (to ~/.prowl/benchmarks/).
 * Returns paths of all written files.
 */
export async function writeAllReports(
  results: BenchmarkResults,
  outputDir: string,
): Promise<ReportOutputPaths> {
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = results.startedAt.replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);

  // Console report as text file
  const consolePath = path.join(outputDir, `report-${timestamp}.txt`);
  await fs.writeFile(consolePath, `${formatConsoleReport(results)}\n`, "utf8");

  // Markdown
  const mdPath = path.join(outputDir, `BENCHMARK.md`);
  await fs.writeFile(mdPath, formatMarkdownReport(results), "utf8");

  // JSON to outputDir
  const jsonPath = path.join(outputDir, `benchmark-${timestamp}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  // Historical JSON to ~/.prowl/benchmarks/
  const historyPath = await exportBenchmarkJson(results);

  return {
    console: consolePath,
    markdown: mdPath,
    json: jsonPath,
    history: historyPath,
  };
}
