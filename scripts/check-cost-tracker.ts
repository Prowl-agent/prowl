import {
  formatSavings,
  getRunningTotal,
  getSavingsReport,
  initAnalytics,
  recordInference,
} from "../packages/core/src/analytics/cost-tracker.js";

await initAnalytics();
console.log("=== COST TRACKER ===");

await recordInference({
  localModel: "qwen3:8b",
  promptTokens: 512,
  completionTokens: 256,
  durationMs: 1840,
  tokensPerSecond: 18.5,
  taskType: "chat",
});

await recordInference({
  localModel: "qwen3:8b",
  promptTokens: 1024,
  completionTokens: 512,
  durationMs: 3200,
  tokensPerSecond: 16.0,
  taskType: "code",
});

await recordInference({
  localModel: "qwen3:8b",
  promptTokens: 2048,
  completionTokens: 1024,
  durationMs: 6100,
  tokensPerSecond: 15.2,
  taskType: "agent",
});

const report = await getSavingsReport("month");
const totals = await getRunningTotal();

console.log(`Total inferences: ${report.totalInferences}`);
console.log(`Total tokens: ${report.totalTokens.toLocaleString()}`);
console.log(
  `Best savings: ${formatSavings(report.bestSavingsUSD)} vs ${report.bestSavingsProvider}`,
);
console.log(`Running total savings: ${totals.formattedSavings}`);
console.log("");
console.log("Cloud equivalents:");
for (const equiv of report.cloudEquivalents.slice(0, 3)) {
  console.log(`  ${equiv.provider} ${equiv.model}: ${formatSavings(equiv.estimatedCostUSD)}`);
}

if (report.totalInferences < 3) {
  throw new Error("FAIL: inferences not persisted correctly");
}
if (report.bestSavingsUSD <= 0) {
  throw new Error("FAIL: savings calculation returned 0");
}

console.log("✅ Cost tracker PASSED");
console.log("Data written to: ~/.prowl/analytics/");
