import {
  createDefaultConfig,
  estimateComplexity,
  routeTask,
} from "../packages/core/src/router/task-router.js";

console.log("=== TASK ROUTER ===");

const simple = await routeTask(
  { prompt: "Hello, how are you?", taskType: "chat" },
  createDefaultConfig("qwen3:8b"),
);
console.log(`Simple chat → ${simple.route} (${simple.complexity})`);
if (simple.route !== "local") {
  throw new Error("FAIL: simple chat should route local");
}

const complex = await routeTask(
  {
    prompt: "x".repeat(3000),
    taskType: "agent",
    requiresLongContext: true,
    conversationHistory: Array.from({ length: 20 }, () => ({
      role: "user" as const,
      content: "step",
    })),
  },
  createDefaultConfig("qwen3:8b"),
);
console.log(`Complex agent → ${complex.route} (${complex.complexity})`);
console.log(`Warnings: ${complex.warnings.join(", ") || "none"}`);
if (complex.route !== "local") {
  throw new Error("FAIL: should stay local when cloud disabled");
}

const level = estimateComplexity({
  prompt: "x".repeat(3000),
  taskType: "agent",
  requiresLongContext: true,
});
console.log(`Complexity for long agent task: ${level}`);
if (level !== "very-complex") {
  throw new Error(`FAIL: expected very-complex, got ${level}`);
}

console.log("✅ Task router PASSED");
