import type { OptimizerTaskType } from "../optimizer/model-prompt-optimizer.js";

// ---------------------------------------------------------------------------
// Benchmark task definitions
// ---------------------------------------------------------------------------

export type TaskCategory =
  | "single-file-edit"
  | "code-generation"
  | "tool-use"
  | "reasoning"
  | "documentation";

export type TaskDifficulty = "easy" | "medium" | "hard";

/**
 * A tool definition provided to the agent during tool-use tasks.
 * Mirrors a simplified OpenAI-style function schema so benchmarks stay
 * model-agnostic.
 */
export interface BenchmarkToolDef {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

/**
 * Describes what a correct response should contain so the scorer can
 * grade objectively without calling an LLM.
 */
export interface ExpectedBehavior {
  /** Substrings or regex patterns that MUST appear in the response. */
  mustInclude?: string[];
  /** Substrings or regex patterns that must NOT appear. */
  mustExclude?: string[];
  /** For tool-use tasks: the tool calls that should be made (in order). */
  expectedToolCalls?: Array<{
    toolName: string;
    /** Key args that must be present (values are regex-matched). */
    requiredArgs?: Record<string, string>;
  }>;
  /** Free-text description for human reviewers / LLM-as-judge fallback. */
  description: string;
}

/**
 * Individual scoring dimension with a weight.
 * The benchmark runner sums (score × weight) / totalWeight for a final 0-1.
 */
export interface ScoringCriterion {
  name: string;
  description: string;
  /** Relative weight (all weights in a task are normalized). */
  weight: number;
}

/**
 * A single benchmark task the agent must complete.
 */
export interface BenchmarkTask {
  id: string;
  category: TaskCategory;
  difficulty: TaskDifficulty;
  /** Maps to the optimizer's task type so we can test with/without optimization. */
  optimizerTaskType: OptimizerTaskType;
  prompt: string;
  tools: BenchmarkToolDef[];
  expectedBehavior: ExpectedBehavior;
  scoringCriteria: ScoringCriterion[];
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Benchmark results
// ---------------------------------------------------------------------------

/**
 * Score for one criterion on one task run.
 */
export interface CriterionScore {
  criterion: string;
  score: number; // 0-1
  reasoning: string;
}

/**
 * Result of running a single benchmark task.
 */
export interface TaskResult {
  taskId: string;
  model: string;
  optimized: boolean;
  response: string;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  criterionScores: CriterionScore[];
  /** Weighted aggregate 0-1. */
  overallScore: number;
  latencyMs: number;
  tokenCount: { prompt: number; completion: number };
}

/**
 * Aggregate results for a full benchmark run (one model, one config).
 */
export interface BenchmarkRunSummary {
  model: string;
  optimized: boolean;
  timestamp: string;
  taskResults: TaskResult[];
  /** Average overallScore across all tasks. */
  meanScore: number;
  /** Scores broken down by category. */
  categoryScores: Record<TaskCategory, number>;
  /** Scores broken down by difficulty. */
  difficultyScores: Record<TaskDifficulty, number>;
  totalLatencyMs: number;
}
