import {
  exportAuditCSV,
  getPrivacyStats,
  getPrivacyStatus,
  initPrivacy,
  recordRequest,
} from "../packages/core/src/privacy/privacy-tracker.js";

await initPrivacy();
console.log("=== PRIVACY TRACKER ===");

await recordRequest({
  taskType: "chat",
  promptPreview: "What is the capital of France?",
  destination: "local",
  localModel: "qwen3:8b",
  promptTokens: 12,
  completionTokens: 8,
  durationMs: 320,
  routingReason: "Local: cloud fallback disabled",
});

await recordRequest({
  taskType: "code",
  promptPreview: "Write a binary search function in TypeScript",
  destination: "local",
  localModel: "qwen3:8b",
  promptTokens: 28,
  completionTokens: 95,
  durationMs: 1100,
  routingReason: "Local: cloud fallback disabled",
});

const stats = await getPrivacyStats();
const status = getPrivacyStatus(stats);
const csv = await exportAuditCSV();

console.log(`Total requests: ${stats.totalRequests}`);
console.log(`Local percent: ${stats.localPercent}%`);
console.log(`Status: ${status.label}`);
console.log(`Current streak: ${stats.currentStreak} days`);
console.log("");
console.log("CSV preview (first 2 lines):");
console.log(csv.split("\n").slice(0, 2).join("\n"));

if (stats.totalRequests < 2) {
  throw new Error("FAIL: requests not persisted");
}
if (status.level !== "full") {
  throw new Error(`FAIL: expected 'full' status, got '${status.level}'`);
}

console.log("✅ Privacy tracker PASSED");
