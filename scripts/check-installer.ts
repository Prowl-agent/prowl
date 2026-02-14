import { runInstaller } from "../packages/core/src/setup/installer.js";

console.log("=== INSTALLER FLOW (skipModelPull=true) ===");

const result = await runInstaller({
  skipModelPull: true,
  onProgress: (progress) => {
    const bar =
      "█".repeat(Math.floor(progress.percentComplete / 5)) +
      "░".repeat(20 - Math.floor(progress.percentComplete / 5));
    console.log(`[${bar}] ${progress.percentComplete}% — ${progress.phase}: ${progress.message}`);
  },
});

console.log("");
if (!result.success) {
  throw new Error(`FAIL: Installer failed — ${result.error}`);
}

console.log("Profile:", result.profile ? "✅" : "❌");
console.log("Recommendation:", result.recommendation?.displayName ?? "❌");
console.log("Config written:", result.success ? "✅" : "❌");
console.log(`Total time: ${result.totalTimeMs}ms`);
console.log("✅ Installer flow PASSED");
