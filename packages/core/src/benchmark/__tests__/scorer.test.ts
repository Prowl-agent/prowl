import { describe, expect, it } from "vitest";
import type { CriterionScore, ScoringCriterion } from "../types.js";
import {
  argsMatch,
  computeWeightedScore,
  matchesPattern,
  parseLlmJudgeScore,
  scoreCorrectness,
  scoreFormatCompliance,
  scoreTokenEfficiency,
  scoreToolUseAccuracy,
} from "../scorer.js";
import { getTaskById } from "../tasks.js";

// ---------------------------------------------------------------------------
// matchesPattern
// ---------------------------------------------------------------------------

describe("matchesPattern", () => {
  it("matches substring case-insensitively", () => {
    expect(matchesPattern("Hello World", "hello")).toBe(true);
    expect(matchesPattern("Hello World", "WORLD")).toBe(true);
    expect(matchesPattern("Hello World", "xyz")).toBe(false);
  });

  it("matches regex patterns", () => {
    expect(matchesPattern("function foo() {}", "function\\s+\\w+")).toBe(true);
    expect(matchesPattern("const bar = 1", "const\\s+\\w+")).toBe(true);
    expect(matchesPattern("hello", "^hello$")).toBe(true);
  });

  it("falls back to substring for invalid regex", () => {
    expect(matchesPattern("a[b", "a[b")).toBe(true);
    expect(matchesPattern("abc", "a[b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// argsMatch
// ---------------------------------------------------------------------------

describe("argsMatch", () => {
  it("returns true when no required args", () => {
    expect(argsMatch({ foo: "bar" })).toBe(true);
    expect(argsMatch({ foo: "bar" }, undefined)).toBe(true);
  });

  it("matches required arg values as patterns", () => {
    expect(argsMatch({ path: "/tmp/config.json" }, { path: "/tmp/config.json" })).toBe(true);
    expect(argsMatch({ path: "/tmp/config.json" }, { path: "config" })).toBe(true);
    expect(argsMatch({ path: "/tmp/other.json" }, { path: "config" })).toBe(false);
  });

  it("returns false when required arg is missing", () => {
    expect(argsMatch({}, { path: "/tmp/config.json" })).toBe(false);
  });

  it("supports regex patterns in required args", () => {
    expect(argsMatch({ command: "git status" }, { command: ".*git status.*" })).toBe(true);
    expect(argsMatch({ command: "ls -la" }, { command: ".*git.*" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreCorrectness
// ---------------------------------------------------------------------------

describe("scoreCorrectness", () => {
  it("scores based on mustInclude patterns", () => {
    const task = getTaskById("edit-validation-01")!;
    const response = 'if (typeof name !== "string") throw new Error("invalid");\ncheck @';
    const score = scoreCorrectness(task, response, []);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0.5 when no automated checks and response exists", () => {
    const task: BenchmarkTask = {
      id: "test",
      category: "reasoning",
      difficulty: "easy",
      optimizerTaskType: "chat",
      prompt: "test",
      tools: [],
      expectedBehavior: { description: "test" },
      scoringCriteria: [],
      timeoutMs: 1000,
    };
    expect(scoreCorrectness(task, "some response", [])).toBe(0.5);
  });

  it("returns 0 for empty response with no checks", () => {
    const task: BenchmarkTask = {
      id: "test",
      category: "reasoning",
      difficulty: "easy",
      optimizerTaskType: "chat",
      prompt: "test",
      tools: [],
      expectedBehavior: { description: "test" },
      scoringCriteria: [],
      timeoutMs: 1000,
    };
    expect(scoreCorrectness(task, "", [])).toBe(0);
  });

  it("penalizes mustExclude matches", () => {
    const task: BenchmarkTask = {
      id: "test",
      category: "code-generation",
      difficulty: "easy",
      optimizerTaskType: "code",
      prompt: "test",
      tools: [],
      expectedBehavior: {
        mustInclude: ["function"],
        mustExclude: ["JSON.parse"],
        description: "test",
      },
      scoringCriteria: [],
      timeoutMs: 1000,
    };
    // Response includes forbidden pattern
    const bad = scoreCorrectness(task, "function foo() { JSON.parse(x) }", []);
    const good = scoreCorrectness(task, "function foo() { return x }", []);
    expect(good).toBeGreaterThan(bad);
  });
});

// ---------------------------------------------------------------------------
// scoreToolUseAccuracy
// ---------------------------------------------------------------------------

describe("scoreToolUseAccuracy", () => {
  it("returns 1.0 for non-tool tasks", () => {
    const task = getTaskById("edit-validation-01")!;
    expect(scoreToolUseAccuracy(task, [])).toBe(1.0);
  });

  it("scores matching tool calls", () => {
    const task = getTaskById("tool-read-config-01")!;
    const calls = [{ toolName: "file_read", args: { path: "/tmp/config.json" } }];
    const score = scoreToolUseAccuracy(task, calls);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores 0 for missing tool calls", () => {
    const task = getTaskById("tool-read-config-01")!;
    const score = scoreToolUseAccuracy(task, []);
    expect(score).toBe(0);
  });

  it("gives partial credit for partial matches", () => {
    const task = getTaskById("tool-create-file-02")!;
    // Only one of two expected tool calls
    const calls = [{ toolName: "file_write", args: { path: "/tmp/hello.txt" } }];
    const score = scoreToolUseAccuracy(task, calls);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// scoreFormatCompliance
// ---------------------------------------------------------------------------

describe("scoreFormatCompliance", () => {
  it("returns 0 for empty response", () => {
    const task = getTaskById("edit-validation-01")!;
    expect(scoreFormatCompliance(task, "")).toBe(0);
    expect(scoreFormatCompliance(task, "   ")).toBe(0);
  });

  it("scores higher for code tasks with code blocks", () => {
    const task = getTaskById("gen-debounce-01")!;
    const withBlock = "```typescript\nfunction debounce() {}\n```";
    const withoutBlock = "function debounce() {}";
    expect(scoreFormatCompliance(task, withBlock)).toBeGreaterThan(
      scoreFormatCompliance(task, withoutBlock),
    );
  });

  it("scores doc tasks with markdown structure", () => {
    const task = getTaskById("doc-commit-msg-01")!;
    const structured = "## Summary\n- Added auth\n- Fixed bug";
    const plain = "added auth and fixed bug";
    expect(scoreFormatCompliance(task, structured)).toBeGreaterThan(
      scoreFormatCompliance(task, plain),
    );
  });
});

// ---------------------------------------------------------------------------
// scoreTokenEfficiency
// ---------------------------------------------------------------------------

describe("scoreTokenEfficiency", () => {
  it("returns 1.0 when completion is at or under target", () => {
    expect(scoreTokenEfficiency(100, 512)).toBe(1.0);
    expect(scoreTokenEfficiency(512, 512)).toBe(1.0);
  });

  it("returns ratio when over target", () => {
    expect(scoreTokenEfficiency(1024, 512)).toBe(0.5);
    expect(scoreTokenEfficiency(2048, 512)).toBe(0.25);
  });

  it("returns 0 for zero completion tokens", () => {
    expect(scoreTokenEfficiency(0, 512)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseLlmJudgeScore
// ---------------------------------------------------------------------------

describe("parseLlmJudgeScore", () => {
  it("parses a clean integer score", () => {
    expect(parseLlmJudgeScore("7")).toBe(0.7);
    expect(parseLlmJudgeScore("10")).toBe(1.0);
    expect(parseLlmJudgeScore("0")).toBe(0);
  });

  it("extracts score from noisy text", () => {
    expect(parseLlmJudgeScore("I would give this a 8 out of 10.")).toBe(0.8);
    expect(parseLlmJudgeScore("Score: 6")).toBe(0.6);
  });

  it("returns null for unparseable text", () => {
    expect(parseLlmJudgeScore("")).toBeNull();
    expect(parseLlmJudgeScore("great job")).toBeNull();
    expect(parseLlmJudgeScore("fifteen")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeWeightedScore
// ---------------------------------------------------------------------------

describe("computeWeightedScore", () => {
  it("computes weighted average", () => {
    const scores: CriterionScore[] = [
      { criterion: "a", score: 1.0, reasoning: "" },
      { criterion: "b", score: 0.0, reasoning: "" },
    ];
    const criteria: ScoringCriterion[] = [
      { name: "a", description: "", weight: 3 },
      { name: "b", description: "", weight: 1 },
    ];
    // (1.0 * 3 + 0.0 * 1) / 4 = 0.75
    expect(computeWeightedScore(scores, criteria)).toBe(0.75);
  });

  it("returns 0 for empty scores", () => {
    expect(computeWeightedScore([], [])).toBe(0);
  });

  it("defaults to weight 1 for unmatched criteria", () => {
    const scores: CriterionScore[] = [{ criterion: "x", score: 0.8, reasoning: "" }];
    expect(computeWeightedScore(scores, [])).toBe(0.8);
  });
});
