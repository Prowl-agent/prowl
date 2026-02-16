import { describe, expect, it } from "vitest";
import type { TaskCategory, TaskDifficulty } from "../types.js";
import {
  BENCHMARK_TASKS,
  getTaskById,
  getTasksByCategory,
  getTasksByDifficulty,
} from "../tasks.js";

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe("benchmark task definitions", () => {
  it("contains exactly 30 tasks", () => {
    expect(BENCHMARK_TASKS).toHaveLength(30);
  });

  it("has unique task IDs", () => {
    const ids = BENCHMARK_TASKS.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("has all required fields on every task", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(task.id, `task missing id`).toBeTruthy();
      expect(typeof task.id).toBe("string");

      expect(task.category, `${task.id}: missing category`).toBeTruthy();
      expect(task.difficulty, `${task.id}: missing difficulty`).toBeTruthy();
      expect(task.optimizerTaskType, `${task.id}: missing optimizerTaskType`).toBeTruthy();

      expect(task.prompt.length, `${task.id}: prompt is empty`).toBeGreaterThan(0);
      expect(Array.isArray(task.tools), `${task.id}: tools is not an array`).toBe(true);

      expect(task.expectedBehavior, `${task.id}: missing expectedBehavior`).toBeTruthy();
      expect(
        task.expectedBehavior.description.length,
        `${task.id}: expectedBehavior.description is empty`,
      ).toBeGreaterThan(0);

      expect(task.scoringCriteria.length, `${task.id}: scoringCriteria is empty`).toBeGreaterThan(
        0,
      );

      expect(task.timeoutMs, `${task.id}: timeoutMs is not positive`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Category distribution
// ---------------------------------------------------------------------------

describe("category distribution", () => {
  const categories: TaskCategory[] = [
    "single-file-edit",
    "code-generation",
    "tool-use",
    "reasoning",
    "documentation",
  ];

  for (const category of categories) {
    it(`has at least 5 tasks in category "${category}"`, () => {
      const tasks = getTasksByCategory(category);
      expect(tasks.length).toBeGreaterThanOrEqual(5);
    });
  }

  it("every task belongs to a known category", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(categories).toContain(task.category);
    }
  });
});

// ---------------------------------------------------------------------------
// Difficulty distribution
// ---------------------------------------------------------------------------

describe("difficulty distribution", () => {
  const difficulties: TaskDifficulty[] = ["easy", "medium", "hard"];

  for (const difficulty of difficulties) {
    it(`has tasks at difficulty "${difficulty}"`, () => {
      const tasks = getTasksByDifficulty(difficulty);
      expect(tasks.length).toBeGreaterThan(0);
    });
  }

  it("every task has a valid difficulty", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(difficulties).toContain(task.difficulty);
    }
  });
});

// ---------------------------------------------------------------------------
// Scoring criteria validation
// ---------------------------------------------------------------------------

describe("scoring criteria", () => {
  it("every task has at least 2 scoring criteria", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(
        task.scoringCriteria.length,
        `${task.id}: needs at least 2 scoring criteria`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("all criteria have a name, description, and positive weight", () => {
    for (const task of BENCHMARK_TASKS) {
      for (const criterion of task.scoringCriteria) {
        expect(criterion.name, `${task.id}: criterion missing name`).toBeTruthy();
        expect(criterion.description, `${task.id}: criterion missing description`).toBeTruthy();
        expect(
          criterion.weight,
          `${task.id}/${criterion.name}: weight must be positive`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("criteria names are unique within each task", () => {
    for (const task of BENCHMARK_TASKS) {
      const names = task.scoringCriteria.map((c) => c.name);
      const unique = new Set(names);
      expect(unique.size, `${task.id}: duplicate criterion names`).toBe(names.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool definitions for tool-use tasks
// ---------------------------------------------------------------------------

describe("tool definitions", () => {
  it("tool-use tasks have at least one tool defined", () => {
    const toolTasks = BENCHMARK_TASKS.filter((t) => t.category === "tool-use");
    for (const task of toolTasks) {
      expect(task.tools.length, `${task.id}: tool-use task has no tools`).toBeGreaterThan(0);
    }
  });

  it("all tool definitions have name, description, and parameters", () => {
    for (const task of BENCHMARK_TASKS) {
      for (const tool of task.tools) {
        expect(tool.name, `${task.id}: tool missing name`).toBeTruthy();
        expect(tool.description, `${task.id}/${tool.name}: tool missing description`).toBeTruthy();
        expect(tool.parameters, `${task.id}/${tool.name}: tool missing parameters`).toBeTruthy();
        expect(
          typeof tool.parameters,
          `${task.id}/${tool.name}: parameters should be an object`,
        ).toBe("object");
      }
    }
  });

  it("tool-use tasks with expectedToolCalls reference tools that are provided", () => {
    const toolTasks = BENCHMARK_TASKS.filter((t) => t.category === "tool-use");
    for (const task of toolTasks) {
      const expected = task.expectedBehavior.expectedToolCalls ?? [];
      const availableToolNames = new Set(task.tools.map((t) => t.name));
      for (const exp of expected) {
        expect(
          availableToolNames.has(exp.toolName),
          `${task.id}: expectedToolCall "${exp.toolName}" not in available tools`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Expected behavior validation
// ---------------------------------------------------------------------------

describe("expected behavior", () => {
  it("every task has a non-empty description in expectedBehavior", () => {
    for (const task of BENCHMARK_TASKS) {
      expect(
        task.expectedBehavior.description.trim().length,
        `${task.id}: expectedBehavior.description is empty`,
      ).toBeGreaterThan(10);
    }
  });

  it("mustInclude patterns are non-empty strings when present", () => {
    for (const task of BENCHMARK_TASKS) {
      if (task.expectedBehavior.mustInclude) {
        for (const pattern of task.expectedBehavior.mustInclude) {
          expect(pattern.length, `${task.id}: empty mustInclude pattern`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("mustExclude patterns are non-empty strings when present", () => {
    for (const task of BENCHMARK_TASKS) {
      if (task.expectedBehavior.mustExclude) {
        for (const pattern of task.expectedBehavior.mustExclude) {
          expect(pattern.length, `${task.id}: empty mustExclude pattern`).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("helper functions", () => {
  it("getTaskById returns the correct task", () => {
    const task = getTaskById("edit-validation-01");
    expect(task).toBeDefined();
    expect(task!.id).toBe("edit-validation-01");
    expect(task!.category).toBe("single-file-edit");
  });

  it("getTaskById returns undefined for unknown ID", () => {
    expect(getTaskById("nonexistent-task")).toBeUndefined();
  });

  it("getTasksByCategory returns only tasks of that category", () => {
    const tasks = getTasksByCategory("tool-use");
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.category).toBe("tool-use");
    }
  });

  it("getTasksByDifficulty returns only tasks of that difficulty", () => {
    const tasks = getTasksByDifficulty("hard");
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.difficulty).toBe("hard");
    }
  });
});
