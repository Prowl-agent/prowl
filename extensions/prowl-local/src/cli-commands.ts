/**
 * Prowl-local CLI command registrations.
 *
 * Each exported function takes a Commander `Command` and adds a subcommand.
 * Wired into the plugin via `api.registerCli()` in index.ts.
 */
import type { Command } from "commander";
import type { TaskCategory } from "../../../packages/core/src/benchmark/types.js";
import {
  formatConsoleReport,
  writeAllReports,
} from "../../../packages/core/src/benchmark/reporter.js";
import {
  DEFAULT_BENCHMARK_CONFIG,
  runBenchmark,
  type BenchmarkConfig,
} from "../../../packages/core/src/benchmark/runner.js";
import { BENCHMARK_TASKS } from "../../../packages/core/src/benchmark/tasks.js";

const VALID_CATEGORIES: TaskCategory[] = [
  "single-file-edit",
  "code-generation",
  "tool-use",
  "reasoning",
  "documentation",
];

// Short aliases so users can type `--category code` instead of the full name
const CATEGORY_ALIASES: Record<string, TaskCategory> = {
  "code-edit": "single-file-edit",
  "single-file-edit": "single-file-edit",
  "code-gen": "code-generation",
  "code-generation": "code-generation",
  "tool-use": "tool-use",
  tool: "tool-use",
  reasoning: "reasoning",
  reason: "reasoning",
  documentation: "documentation",
  docs: "documentation",
  doc: "documentation",
};

function resolveCategory(input: string): TaskCategory | undefined {
  const normalized = input.trim().toLowerCase();
  return CATEGORY_ALIASES[normalized];
}

export function registerBenchmarkCommand(program: Command): void {
  program
    .command("benchmark")
    .description("Run the Prowl benchmark suite to evaluate model + optimizer performance")
    .option(
      "-m, --models <models>",
      "Comma-separated list of Ollama model tags",
      DEFAULT_BENCHMARK_CONFIG.models.join(","),
    )
    .option(
      "-c, --category <category>",
      `Filter by category: ${VALID_CATEGORIES.join(", ")} (or aliases: code-edit, code-gen, tool, reason, docs)`,
    )
    .option("-t, --tasks <tasks>", "Comma-separated task IDs (default: all)")
    .option(
      "-r, --runs <n>",
      "Number of runs per task for variance measurement",
      String(DEFAULT_BENCHMARK_CONFIG.runs),
    )
    .option(
      "-o, --output <dir>",
      "Output directory for results",
      DEFAULT_BENCHMARK_CONFIG.outputDir,
    )
    .option("--no-optimizer", "Skip optimized runs (baseline only)")
    .option("--no-baseline", "Skip baseline runs (optimized only)")
    .option("--ollama-url <url>", "Ollama API URL", DEFAULT_BENCHMARK_CONFIG.ollamaUrl)
    .option(
      "--timeout <ms>",
      "Per-task timeout in milliseconds",
      String(DEFAULT_BENCHMARK_CONFIG.timeoutMs),
    )
    .option(
      "--concurrency <n>",
      "Parallel task runs (default 1 for local)",
      String(DEFAULT_BENCHMARK_CONFIG.concurrency),
    )
    .option("--judge <model>", "Ollama model for LLM-as-judge fallback scoring")
    .option("--list", "List available tasks and exit")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      // --list: just print tasks and exit
      if (opts.list) {
        printTaskList();
        return;
      }

      const models =
        typeof opts.models === "string"
          ? opts.models
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
          : DEFAULT_BENCHMARK_CONFIG.models;

      let categories: TaskCategory[] | undefined;
      if (typeof opts.category === "string") {
        const resolved = resolveCategory(opts.category);
        if (!resolved) {
          console.error(
            `Unknown category: "${opts.category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        categories = [resolved];
      }

      let tasks: string[] | "all" = "all";
      if (typeof opts.tasks === "string") {
        tasks = opts.tasks
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }

      const useOptimizer = opts.optimizer !== false;
      const compareBaseline = opts.baseline !== false;

      if (!useOptimizer && !compareBaseline) {
        console.error("Cannot disable both optimizer and baseline — nothing to run.");
        process.exitCode = 1;
        return;
      }

      const config: BenchmarkConfig = {
        models,
        tasks,
        categories,
        runs: Number(opts.runs) || DEFAULT_BENCHMARK_CONFIG.runs,
        ollamaUrl:
          typeof opts.ollamaUrl === "string" ? opts.ollamaUrl : DEFAULT_BENCHMARK_CONFIG.ollamaUrl,
        useOptimizer,
        compareBaseline,
        outputDir:
          typeof opts.output === "string" ? opts.output : DEFAULT_BENCHMARK_CONFIG.outputDir,
        concurrency: Number(opts.concurrency) || DEFAULT_BENCHMARK_CONFIG.concurrency,
        timeoutMs: Number(opts.timeout) || DEFAULT_BENCHMARK_CONFIG.timeoutMs,
        llmJudgeModel: typeof opts.judge === "string" ? opts.judge : undefined,
      };

      console.log(`\nProwl Benchmark Suite`);
      console.log(`Models:     ${config.models.join(", ")}`);
      console.log(
        `Tasks:      ${config.tasks === "all" ? `all (${BENCHMARK_TASKS.length})` : config.tasks.length}`,
      );
      if (categories) {
        console.log(`Category:   ${categories.join(", ")}`);
      }
      console.log(`Runs:       ${config.runs}`);
      console.log(`Optimizer:  ${config.useOptimizer ? "yes" : "no"}`);
      console.log(`Baseline:   ${config.compareBaseline ? "yes" : "no"}`);
      console.log(`Output:     ${config.outputDir}`);
      console.log("");

      let completed = 0;
      let errored = 0;

      try {
        const results = await runBenchmark(config, (event) => {
          switch (event.type) {
            case "start":
              console.log(
                `Starting ${event.totalRuns} benchmark runs across ${event.models.length} model(s)...\n`,
              );
              break;
            case "task-start":
              process.stdout.write(
                `  [${event.model}] ${event.taskId} (${event.optimized ? "optimized" : "baseline"}, run ${event.run + 1})...`,
              );
              break;
            case "task-complete":
              completed += 1;
              console.log(
                ` ✓ correctness=${event.score.correctness.toFixed(2)} (${event.score.latencyMs.toFixed(0)}ms)`,
              );
              break;
            case "task-error":
              errored += 1;
              console.log(` ✗ ${event.error}`);
              break;
            case "model-complete":
              console.log(
                `\n  ${event.model}: pass=${(event.summary.passRate * 100).toFixed(0)}% avg_correct=${event.summary.avgCorrectness.toFixed(2)}\n`,
              );
              break;
            case "complete":
              break;
          }
        });

        // Write all report formats (console txt, markdown, JSON, history)
        const paths = await writeAllReports(results, config.outputDir);

        // Print the pretty console report
        console.log(formatConsoleReport(results));
        console.log(`\nCompleted: ${completed}  Errors: ${errored}`);
        console.log(`\nReports written:`);
        console.log(`  Markdown:  ${paths.markdown}`);
        console.log(`  JSON:      ${paths.json}`);
        console.log(`  History:   ${paths.history}`);
      } catch (err) {
        console.error(`\nBenchmark failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}

function printTaskList(): void {
  console.log("\nAvailable benchmark tasks:\n");
  console.log("  ID                              Category             Difficulty");
  console.log("  ─────────────────────────────────────────────────────────────────");
  for (const task of BENCHMARK_TASKS) {
    const id = task.id.padEnd(33);
    const cat = task.category.padEnd(20);
    console.log(`  ${id} ${cat} ${task.difficulty}`);
  }
  console.log(`\n  Total: ${BENCHMARK_TASKS.length} tasks`);
}
