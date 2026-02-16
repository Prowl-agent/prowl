#!/usr/bin/env npx tsx
/**
 * Prowl Performance Benchmark
 *
 * Reproducible tests for cold-start latency and steady-state generation speed.
 * Saves results to bench/results/ and prints a markdown report.
 *
 * Usage:
 *   npx tsx scripts/perf-bench.ts [--model qwen3:8b] [--url http://127.0.0.1:11434] [--runs 5]
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = process.env.OPENCLAW_DEFAULT_MODEL ?? "qwen3:8b";
const DEFAULT_URL = "http://127.0.0.1:11434";
const DEFAULT_RUNS = 5;

interface BenchResult {
  name: string;
  runs: RunResult[];
  stats: Stats;
}

interface RunResult {
  totalMs: number;
  modelLoadMs: number;
  timeToFirstTokenMs: number;
  tokensPerSec: number;
  promptTokens: number;
  completionTokens: number;
}

interface Stats {
  medianTotalMs: number;
  p95TotalMs: number;
  medianTtft: number;
  p95Ttft: number;
  medianTokPerSec: number;
  medianLoadMs: number;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function ollamaChat(model: string, prompt: string, url: string): Promise<RunResult> {
  const started = Date.now();
  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { num_ctx: 4096, num_predict: 128 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    total_duration?: number;
    load_duration?: number;
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
    eval_count?: number;
    eval_duration?: number;
  };

  const totalMs = Date.now() - started;
  const loadMs = (data.load_duration ?? 0) / 1_000_000;
  const promptEvalMs = (data.prompt_eval_duration ?? 0) / 1_000_000;
  const evalCount = data.eval_count ?? 0;
  const evalDurationSec = (data.eval_duration ?? 0) / 1_000_000_000;
  const tokPerSec = evalDurationSec > 0 ? evalCount / evalDurationSec : 0;

  return {
    totalMs,
    modelLoadMs: Math.round(loadMs),
    timeToFirstTokenMs: Math.round(loadMs + promptEvalMs),
    tokensPerSec: Math.round(tokPerSec * 10) / 10,
    promptTokens: data.prompt_eval_count ?? 0,
    completionTokens: evalCount,
  };
}

async function unloadModel(model: string, url: string): Promise<void> {
  try {
    await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    // Wait for unload.
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    console.warn("Failed to unload model for cold-start test.");
  }
}

function computeStats(runs: RunResult[]): Stats {
  return {
    medianTotalMs: Math.round(median(runs.map((r) => r.totalMs))),
    p95TotalMs: Math.round(
      percentile(
        runs.map((r) => r.totalMs),
        95,
      ),
    ),
    medianTtft: Math.round(median(runs.map((r) => r.timeToFirstTokenMs))),
    p95Ttft: Math.round(
      percentile(
        runs.map((r) => r.timeToFirstTokenMs),
        95,
      ),
    ),
    medianTokPerSec: Math.round(median(runs.map((r) => r.tokensPerSec)) * 10) / 10,
    medianLoadMs: Math.round(median(runs.map((r) => r.modelLoadMs))),
  };
}

async function runBenchmark(
  name: string,
  model: string,
  prompt: string,
  numRuns: number,
  url: string,
  coldStart: boolean,
): Promise<BenchResult> {
  console.log(`\n── ${name} (${numRuns} runs) ──`);
  const runs: RunResult[] = [];

  for (let i = 0; i < numRuns; i++) {
    if (coldStart) {
      await unloadModel(model, url);
    }
    const result = await ollamaChat(model, prompt, url);
    runs.push(result);
    console.log(
      `  [${i + 1}/${numRuns}] total=${result.totalMs}ms load=${result.modelLoadMs}ms ` +
        `ttft=${result.timeToFirstTokenMs}ms tok/s=${result.tokensPerSec}`,
    );
  }

  return { name, runs, stats: computeStats(runs) };
}

async function main(): Promise<void> {
  const model = parseArg("--model") ?? DEFAULT_MODEL;
  const url = (parseArg("--url") ?? DEFAULT_URL).replace(/\/+$/, "");
  const numRuns = Number(parseArg("--runs") ?? DEFAULT_RUNS);

  console.log(`Prowl Performance Benchmark`);
  console.log(`Model: ${model}`);
  console.log(`Ollama URL: ${url}`);
  console.log(`Runs: ${numRuns}`);

  const results: BenchResult[] = [];

  // 1. Cold-start
  results.push(
    await runBenchmark(
      "Cold Start",
      model,
      "Say hello in one sentence.",
      Math.min(numRuns, 3),
      url,
      true,
    ),
  );

  // 2. Warm-start
  results.push(
    await runBenchmark("Warm Start", model, "Say hello in one sentence.", numRuns, url, false),
  );

  // 3. Steady-state chat
  results.push(
    await runBenchmark(
      "Steady State Chat",
      model,
      "Explain what Prowl does in 2-3 sentences.",
      numRuns,
      url,
      false,
    ),
  );

  // 4. Heavy task
  results.push(
    await runBenchmark(
      "Heavy Task",
      model,
      "Write a TypeScript function that implements a basic LRU cache with get() and put() methods. Include type annotations.",
      Math.min(numRuns, 3),
      url,
      false,
    ),
  );

  // Save results
  const resultsDir = path.resolve(process.cwd(), "bench", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(resultsDir, `bench-${timestamp}.json`);
  const mdPath = path.join(resultsDir, `bench-${timestamp}.md`);

  const report = {
    model,
    timestamp: new Date().toISOString(),
    results: results.map((r) => ({ name: r.name, stats: r.stats })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Generate markdown report
  const md = [
    `# Prowl Performance Report`,
    ``,
    `**Model**: ${model}  `,
    `**Date**: ${new Date().toISOString()}  `,
    `**Runs per test**: ${numRuns}`,
    ``,
    `| Test | Median Total | p95 Total | Median TTFT | p95 TTFT | tok/s | Load |`,
    `|------|-------------|-----------|-------------|----------|-------|------|`,
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.stats.medianTotalMs}ms | ${r.stats.p95TotalMs}ms | ` +
        `${r.stats.medianTtft}ms | ${r.stats.p95Ttft}ms | ${r.stats.medianTokPerSec} | ${r.stats.medianLoadMs}ms |`,
    ),
    ``,
    `## Raw Data`,
    ``,
    `See [JSON results](bench-${timestamp}.json)`,
  ].join("\n");

  fs.writeFileSync(mdPath, md);

  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`RESULTS SUMMARY (${model})`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n| Test | Median Total | TTFT | tok/s | Load |`);
  console.log(`|------|-------------|------|-------|------|`);
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.stats.medianTotalMs}ms | ${r.stats.medianTtft}ms | ${r.stats.medianTokPerSec} | ${r.stats.medianLoadMs}ms |`,
    );
  }
  console.log(`\nResults saved to: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

await main();
