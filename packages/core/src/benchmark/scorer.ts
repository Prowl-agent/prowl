import type {
  BenchmarkTask,
  CriterionScore,
  ExpectedBehavior,
  ScoringCriterion,
  TaskResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public scorer interface
// ---------------------------------------------------------------------------

export interface TaskScore {
  taskId: string;
  model: string;
  optimized: boolean;

  correctness: number;
  completeness: number;
  toolUseAccuracy: number;
  formatCompliance: number;
  tokenEfficiency: number;

  latencyMs: number;
  totalTokens: number;
  retries: number;
  error: string | null;
}

/** Raw data the benchmark runner provides for scoring. */
export interface ScorerInput {
  task: BenchmarkTask;
  model: string;
  optimized: boolean;
  response: string;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  latencyMs: number;
  tokenCount: { prompt: number; completion: number };
  retries: number;
  error: string | null;
}

/**
 * Optional configuration for the scorer.
 * When `llmJudge` is provided the scorer can fall back to a local Ollama
 * model for subjective criteria that automated checks cannot handle.
 */
export interface ScorerOptions {
  /** Ollama endpoint, defaults to http://localhost:11434 */
  ollamaUrl?: string;
  /** Model to use for LLM-as-judge (e.g. "qwen3:14b"). Omit to skip. */
  llmJudgeModel?: string;
  /** Timeout for each LLM-judge call in ms. Default 60 000. */
  llmJudgeTimeoutMs?: number;
  /** Target token count per task for efficiency scoring. Default 512. */
  targetTokens?: number;
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_LLM_JUDGE_TIMEOUT_MS = 60_000;
const DEFAULT_TARGET_TOKENS = 512;

// ---------------------------------------------------------------------------
// Top-level scoring entry point
// ---------------------------------------------------------------------------

/**
 * Score a single task run. Combines automated checks with an optional
 * LLM-as-judge fallback for subjective criteria. Fully local — no cloud APIs.
 */
export async function scoreTask(input: ScorerInput, options?: ScorerOptions): Promise<TaskScore> {
  const { task, response, toolCalls } = input;
  const expected = task.expectedBehavior;

  const correctness = scoreCorrectness(task, response, toolCalls);
  const completeness = scoreCompleteness(task, response, toolCalls);
  const toolUseAccuracy = scoreToolUseAccuracy(task, toolCalls);
  const formatCompliance = scoreFormatCompliance(task, response);
  const tokenEfficiency = scoreTokenEfficiency(
    input.tokenCount.completion,
    options?.targetTokens ?? DEFAULT_TARGET_TOKENS,
  );

  // Automated per-criterion scores
  const criterionScores = scoreCriteriaAutomated(
    task.scoringCriteria,
    expected,
    response,
    toolCalls,
  );

  // If any criterion scored 0 and we have an LLM judge, try the fallback
  const hasZeros = criterionScores.some((cs) => cs.score === 0);
  if (hasZeros && options?.llmJudgeModel) {
    await applyLlmJudgeFallback(criterionScores, task, response, options);
  }

  return {
    taskId: task.id,
    model: input.model,
    optimized: input.optimized,
    correctness,
    completeness,
    toolUseAccuracy,
    formatCompliance,
    tokenEfficiency,
    latencyMs: input.latencyMs,
    totalTokens: input.tokenCount.prompt + input.tokenCount.completion,
    retries: input.retries,
    error: input.error,
  };
}

/**
 * Build a full TaskResult (as defined in types.ts) from scorer input + scoring.
 * Convenience wrapper around `scoreTask` that returns the result shape the
 * benchmark runner summary expects.
 */
export async function scoreTaskResult(
  input: ScorerInput,
  options?: ScorerOptions,
): Promise<TaskResult> {
  const { task, response, toolCalls } = input;
  const expected = task.expectedBehavior;

  const criterionScores = scoreCriteriaAutomated(
    task.scoringCriteria,
    expected,
    response,
    toolCalls,
  );

  const hasZeros = criterionScores.some((cs) => cs.score === 0);
  if (hasZeros && options?.llmJudgeModel) {
    await applyLlmJudgeFallback(criterionScores, task, response, options);
  }

  const overallScore = computeWeightedScore(criterionScores, task.scoringCriteria);

  return {
    taskId: task.id,
    model: input.model,
    optimized: input.optimized,
    response,
    toolCalls,
    criterionScores,
    overallScore,
    latencyMs: input.latencyMs,
    tokenCount: input.tokenCount,
  };
}

// ---------------------------------------------------------------------------
// Dimension scorers
// ---------------------------------------------------------------------------

/** Match mustInclude/mustExclude patterns + expected tool calls. */
export function scoreCorrectness(
  task: BenchmarkTask,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  const eb = task.expectedBehavior;
  let checks = 0;
  let passed = 0;

  // mustInclude
  if (eb.mustInclude && eb.mustInclude.length > 0) {
    for (const pattern of eb.mustInclude) {
      checks += 1;
      if (matchesPattern(response, pattern)) {
        passed += 1;
      }
    }
  }

  // mustExclude
  if (eb.mustExclude && eb.mustExclude.length > 0) {
    for (const pattern of eb.mustExclude) {
      checks += 1;
      if (!matchesPattern(response, pattern)) {
        passed += 1;
      }
    }
  }

  // Tool calls correctness (for tool-use tasks)
  if (eb.expectedToolCalls && eb.expectedToolCalls.length > 0) {
    for (const expected of eb.expectedToolCalls) {
      checks += 1;
      const matchingCall = toolCalls.find((tc) => tc.toolName === expected.toolName);
      if (matchingCall && argsMatch(matchingCall.args, expected.requiredArgs)) {
        passed += 1;
      }
    }
  }

  if (checks === 0) {
    // No automated checks defined — response exists = baseline pass
    return response.trim().length > 0 ? 0.5 : 0;
  }

  return clamp01(passed / checks);
}

/** How many of the scoring criteria's subject areas are addressed? */
export function scoreCompleteness(
  task: BenchmarkTask,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  const criteria = task.scoringCriteria;
  if (criteria.length === 0) {
    return response.trim().length > 0 ? 0.5 : 0;
  }

  let addressed = 0;
  for (const criterion of criteria) {
    if (criterionLikelyAddressed(criterion, response, toolCalls)) {
      addressed += 1;
    }
  }

  return clamp01(addressed / criteria.length);
}

/** For tool-use tasks: did the agent call the right tools with right args? */
export function scoreToolUseAccuracy(
  task: BenchmarkTask,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  const expected = task.expectedBehavior.expectedToolCalls;
  if (!expected || expected.length === 0) {
    // Not a tool-use task — full marks
    return 1.0;
  }

  let matched = 0;
  let orderScore = 0;
  const totalExpected = expected.length;

  for (let i = 0; i < totalExpected; i++) {
    const exp = expected[i];
    if (!exp) {
      continue;
    }

    // Check if any actual call matches (name + args)
    const callIndex = toolCalls.findIndex(
      (tc) => tc.toolName === exp.toolName && argsMatch(tc.args, exp.requiredArgs),
    );

    if (callIndex !== -1) {
      matched += 1;
      // Partial credit for ordering: earlier expected = lower index preferred
      if (callIndex >= i) {
        orderScore += 1;
      } else {
        orderScore += 0.5;
      }
    }
  }

  if (totalExpected === 0) {
    return 1.0;
  }

  const matchRatio = matched / totalExpected;
  const orderRatio = totalExpected > 0 ? orderScore / totalExpected : 1;

  // 70% weight on having the right calls, 30% on ordering
  return clamp01(matchRatio * 0.7 + orderRatio * 0.3);
}

/** Does the output look like code / structured text as expected? */
export function scoreFormatCompliance(task: BenchmarkTask, response: string): number {
  if (!response.trim()) {
    return 0;
  }

  let score = 0.5; // baseline for any non-empty response

  const isCodeTask = task.category === "single-file-edit" || task.category === "code-generation";
  const isDocTask = task.category === "documentation";

  if (isCodeTask) {
    // Expect code blocks or function definitions
    const hasCodeBlock = /```[\s\S]*?```/.test(response);
    const hasFunctionDef = /function\s+\w+|const\s+\w+\s*=|class\s+\w+|=>\s*\{/.test(response);
    if (hasCodeBlock) {
      score += 0.3;
    }
    if (hasFunctionDef) {
      score += 0.2;
    }
  } else if (isDocTask) {
    // Expect markdown structure
    const hasHeadings = /^#{1,3}\s/m.test(response);
    const hasStructure = /[-*]\s/.test(response) || /\d+\.\s/.test(response);
    if (hasHeadings) {
      score += 0.25;
    }
    if (hasStructure) {
      score += 0.25;
    }
  } else if (task.category === "tool-use") {
    // Tool-use: just needs to be coherent
    score += 0.3;
  } else {
    // Reasoning: structured analysis
    const hasStructure = /[-*]\s/.test(response) || /\d+[.)]\s/.test(response);
    if (hasStructure) {
      score += 0.3;
    }
    if (response.length > 100) {
      score += 0.2;
    }
  }

  return clamp01(score);
}

/** Ratio of target tokens to actual, capped at 1.0. */
export function scoreTokenEfficiency(completionTokens: number, targetTokens: number): number {
  if (completionTokens <= 0) {
    return 0;
  }
  if (completionTokens <= targetTokens) {
    return 1.0;
  }
  return clamp01(targetTokens / completionTokens);
}

// ---------------------------------------------------------------------------
// Per-criterion automated scoring
// ---------------------------------------------------------------------------

/**
 * Score each named criterion using heuristic pattern checks.
 * Returns a mutable array — the LLM-judge fallback can upgrade 0-scores.
 */
export function scoreCriteriaAutomated(
  criteria: ScoringCriterion[],
  expected: ExpectedBehavior,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): CriterionScore[] {
  return criteria.map((criterion) => {
    const score = scoreSingleCriterion(criterion, expected, response, toolCalls);
    return {
      criterion: criterion.name,
      score,
      reasoning: score > 0 ? "Automated check passed." : "Automated check did not match.",
    };
  });
}

function scoreSingleCriterion(
  criterion: ScoringCriterion,
  expected: ExpectedBehavior,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  const name = criterion.name.toLowerCase();
  const desc = criterion.description.toLowerCase();
  const combined = `${name} ${desc}`;

  // Correctness / fix / bug identification criteria
  if (/correct|fix|bug|identif|root.?cause|diagnos/.test(combined)) {
    return scoreCorrectnessCriterion(expected, response, toolCalls);
  }

  // Tool usage criteria
  if (/tool|call|sequenc|step/.test(combined)) {
    return scoreToolCriterion(expected, response, toolCalls);
  }

  // Code quality / readability
  if (/quality|readab|clean|idiomatic|minimal/.test(combined)) {
    return scoreCodeQualityCriterion(response);
  }

  // Completeness / all parts / sections
  if (/complet|all\s|section|endpoint|phase|aspect/.test(combined)) {
    return scoreCompletenessFromText(expected, response);
  }

  // Structure / format
  if (/format|structur|organiz|markdown|table/.test(combined)) {
    return scoreStructureCriterion(response);
  }

  // Explanation / clarity / reasoning
  if (/explain|clarity|clear|reason|tone|audience|welcom/.test(combined)) {
    return response.trim().length > 50 ? 0.7 : response.trim().length > 0 ? 0.3 : 0;
  }

  // Actionable / specific
  if (/action|specific|suggest|recommend|command|copy.?paste/.test(combined)) {
    return response.trim().length > 80 ? 0.7 : response.trim().length > 0 ? 0.3 : 0;
  }

  // Edge cases / error handling / graceful
  if (/edge|error.?handl|graceful|missing|empty/.test(combined)) {
    const hasEdge = /edge case|error|throw|catch|null|undefined|empty|0|NaN|invalid/i.test(
      response,
    );
    return hasEdge ? 0.7 : 0.3;
  }

  // Fallback: content existence check
  return response.trim().length > 20 ? 0.5 : 0;
}

// ---------------------------------------------------------------------------
// Criterion sub-scorers
// ---------------------------------------------------------------------------

function scoreCorrectnessCriterion(
  expected: ExpectedBehavior,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  let checks = 0;
  let passed = 0;

  if (expected.mustInclude) {
    for (const p of expected.mustInclude) {
      checks += 1;
      if (matchesPattern(response, p)) {
        passed += 1;
      }
    }
  }
  if (expected.mustExclude) {
    for (const p of expected.mustExclude) {
      checks += 1;
      if (!matchesPattern(response, p)) {
        passed += 1;
      }
    }
  }
  if (expected.expectedToolCalls) {
    for (const exp of expected.expectedToolCalls) {
      checks += 1;
      if (
        toolCalls.some((tc) => tc.toolName === exp.toolName && argsMatch(tc.args, exp.requiredArgs))
      ) {
        passed += 1;
      }
    }
  }

  if (checks === 0) {
    return response.trim().length > 0 ? 0.5 : 0;
  }
  return clamp01(passed / checks);
}

function scoreToolCriterion(
  expected: ExpectedBehavior,
  _response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): number {
  if (!expected.expectedToolCalls || expected.expectedToolCalls.length === 0) {
    return toolCalls.length > 0 ? 0.5 : 0.3;
  }

  let matched = 0;
  for (const exp of expected.expectedToolCalls) {
    if (
      toolCalls.some((tc) => tc.toolName === exp.toolName && argsMatch(tc.args, exp.requiredArgs))
    ) {
      matched += 1;
    }
  }
  return clamp01(matched / expected.expectedToolCalls.length);
}

function scoreCodeQualityCriterion(response: string): number {
  if (!response.trim()) {
    return 0;
  }

  let score = 0.3;
  const hasCodeBlock = /```[\s\S]*?```/.test(response);
  const linesInCode = (response.match(/\n/g) || []).length;
  const hasComments = /\/\/|\/\*|\*\/|#\s/.test(response);

  if (hasCodeBlock) {
    score += 0.3;
  }
  if (linesInCode > 3 && linesInCode < 200) {
    score += 0.2;
  }
  if (hasComments) {
    score += 0.2;
  }

  return clamp01(score);
}

function scoreCompletenessFromText(expected: ExpectedBehavior, response: string): number {
  if (expected.mustInclude && expected.mustInclude.length > 0) {
    let found = 0;
    for (const p of expected.mustInclude) {
      if (matchesPattern(response, p)) {
        found += 1;
      }
    }
    return clamp01(found / expected.mustInclude.length);
  }
  // Heuristic: longer, structured responses tend to be more complete
  if (response.length > 500) {
    return 0.7;
  }
  if (response.length > 200) {
    return 0.5;
  }
  return response.trim().length > 0 ? 0.3 : 0;
}

function scoreStructureCriterion(response: string): number {
  if (!response.trim()) {
    return 0;
  }

  let score = 0.2;
  if (/^#{1,3}\s/m.test(response)) {
    score += 0.2;
  }
  if (/[-*]\s/.test(response)) {
    score += 0.15;
  }
  if (/\d+[.)]\s/.test(response)) {
    score += 0.15;
  }
  if (/```[\s\S]*?```/.test(response)) {
    score += 0.15;
  }
  if (/\|.*\|/.test(response)) {
    score += 0.15;
  } // table

  return clamp01(score);
}

// ---------------------------------------------------------------------------
// LLM-as-judge fallback (local Ollama only)
// ---------------------------------------------------------------------------

/**
 * For criteria that scored 0 in automated checks, ask a local Ollama model
 * to evaluate the response on a 0-10 scale. Mutates `criterionScores` in place.
 */
async function applyLlmJudgeFallback(
  criterionScores: CriterionScore[],
  task: BenchmarkTask,
  response: string,
  options: ScorerOptions,
): Promise<void> {
  const ollamaUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options.llmJudgeModel;
  if (!model) {
    return;
  }

  const timeout = options.llmJudgeTimeoutMs ?? DEFAULT_LLM_JUDGE_TIMEOUT_MS;

  for (const cs of criterionScores) {
    if (cs.score > 0) {
      continue;
    }

    const matchingCriterion = task.scoringCriteria.find((sc) => sc.name === cs.criterion);
    if (!matchingCriterion) {
      continue;
    }

    try {
      const judgeScore = await callLlmJudge({
        ollamaUrl,
        model,
        timeout,
        taskPrompt: task.prompt,
        expectedDescription: task.expectedBehavior.description,
        criterionName: matchingCriterion.name,
        criterionDescription: matchingCriterion.description,
        response,
      });

      if (judgeScore !== null) {
        cs.score = judgeScore;
        cs.reasoning = `LLM-judge (${model}) scored ${(judgeScore * 10).toFixed(0)}/10.`;
      }
    } catch {
      // LLM judge is best-effort; keep the automated 0 score
      cs.reasoning = "Automated check failed; LLM-judge unavailable.";
    }
  }
}

interface LlmJudgeParams {
  ollamaUrl: string;
  model: string;
  timeout: number;
  taskPrompt: string;
  expectedDescription: string;
  criterionName: string;
  criterionDescription: string;
  response: string;
}

/**
 * Call a local Ollama model to score a criterion on a 0-10 scale.
 * Returns a normalized 0-1 score, or null if the response can't be parsed.
 */
async function callLlmJudge(params: LlmJudgeParams): Promise<number | null> {
  // Truncate long response/prompt to keep judge calls fast
  const maxChars = 3000;
  const truncatedResponse =
    params.response.length > maxChars
      ? `${params.response.slice(0, maxChars)}\n...[truncated]`
      : params.response;
  const truncatedPrompt =
    params.taskPrompt.length > maxChars
      ? `${params.taskPrompt.slice(0, maxChars)}\n...[truncated]`
      : params.taskPrompt;

  const judgePrompt = [
    "You are a code review judge. Score the following response on a specific criterion.",
    "Reply with ONLY a single integer from 0 to 10. No explanation.",
    "",
    `## Task`,
    truncatedPrompt,
    "",
    `## Expected behavior`,
    params.expectedDescription,
    "",
    `## Criterion: ${params.criterionName}`,
    params.criterionDescription,
    "",
    `## Response to evaluate`,
    truncatedResponse,
    "",
    "Score (0-10):",
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeout);

  try {
    const res = await fetch(`${params.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: params.model,
        prompt: judgePrompt,
        stream: false,
        keep_alive: "5m",
        options: {
          temperature: 0.1,
          top_p: 0.9,
          num_predict: 8,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const body = (await res.json()) as { response?: string };
    const text = typeof body.response === "string" ? body.response.trim() : "";

    return parseLlmJudgeScore(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a 0-10 integer from LLM output and normalize to 0-1. */
export function parseLlmJudgeScore(text: string): number | null {
  // Try to find a number 0-10 in the response
  const match = text.match(/\b(10|[0-9])\b/);
  if (!match || match[1] === undefined) {
    return null;
  }

  const num = Number.parseInt(match[1], 10);
  if (!Number.isFinite(num) || num < 0 || num > 10) {
    return null;
  }

  return clamp01(num / 10);
}

// ---------------------------------------------------------------------------
// Weighted aggregate
// ---------------------------------------------------------------------------

/** Compute a single 0-1 score from per-criterion scores and their weights. */
export function computeWeightedScore(
  criterionScores: CriterionScore[],
  criteria: ScoringCriterion[],
): number {
  if (criterionScores.length === 0) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const cs of criterionScores) {
    const matchingCriterion = criteria.find((c) => c.name === cs.criterion);
    const weight = matchingCriterion?.weight ?? 1;
    weightedSum += cs.score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    return 0;
  }
  return clamp01(weightedSum / totalWeight);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Check if text matches a pattern (substring or regex). */
export function matchesPattern(text: string, pattern: string): boolean {
  // Try as regex first
  try {
    const regex = new RegExp(pattern, "i");
    if (regex.test(text)) {
      return true;
    }
  } catch {
    // Not a valid regex, fall through to substring
  }

  // Substring match (case-insensitive)
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/** Check if actual args satisfy required arg patterns. */
export function argsMatch(
  actual: Record<string, unknown>,
  required?: Record<string, string>,
): boolean {
  if (!required) {
    return true;
  }

  for (const [key, pattern] of Object.entries(required)) {
    const actualValue = actual[key];
    if (actualValue === undefined) {
      return false;
    }

    const actualStr = typeof actualValue === "string" ? actualValue : JSON.stringify(actualValue);
    if (!matchesPattern(actualStr, pattern)) {
      return false;
    }
  }

  return true;
}

/**
 * Heuristic: does the response appear to address a scoring criterion?
 * Looks for keywords from the criterion name/description in the response.
 */
function criterionLikelyAddressed(
  criterion: ScoringCriterion,
  response: string,
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
): boolean {
  const responseLower = response.toLowerCase();
  const keywords = extractKeywords(criterion.name, criterion.description);

  // If at least 40% of keywords are present, consider it addressed
  let found = 0;
  for (const kw of keywords) {
    if (responseLower.includes(kw)) {
      found += 1;
    }
  }

  if (keywords.length > 0 && found / keywords.length >= 0.4) {
    return true;
  }

  // For tool criteria, check if any relevant tool was called
  if (/tool|call|step/.test(criterion.name.toLowerCase()) && toolCalls.length > 0) {
    return true;
  }

  return false;
}

/** Pull meaningful keywords from criterion name + description. */
function extractKeywords(name: string, description: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "has",
    "have",
    "had",
    "do",
    "does",
    "did",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "not",
    "no",
    "all",
    "each",
    "every",
    "any",
    "this",
    "that",
    "it",
    "its",
    "if",
    "so",
    "up",
    "out",
    "as",
    "can",
  ]);

  const combined = `${name} ${description}`.toLowerCase();
  const words = combined.split(/[\s/(),-]+/).filter((w) => w.length > 2 && !stopWords.has(w));

  // Deduplicate
  return [...new Set(words)];
}
