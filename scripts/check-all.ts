import { execSync } from "node:child_process";

const checks = [
  "check-hardware",
  "check-recommend",
  "check-ollama",
  "check-installer",
  "check-cost-tracker",
  "check-dashboard-ui",
  "check-privacy",
  "check-router",
  "check-hf-search",
  "check-data-dir",
];

let passed = 0;
let failed = 0;

for (const check of checks) {
  process.stdout.write(`Running ${check}... `);
  try {
    execSync(`npx tsx scripts/${check}.ts`, {
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log("✅ PASSED");
    passed++;
  } catch (error) {
    console.log("❌ FAILED");
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      Buffer.isBuffer((error as { stdout?: unknown }).stdout)
    ) {
      console.log(((error as { stdout: Buffer }).stdout.toString() || "").slice(-500));
    }
    failed++;
  }
}

console.log("");
console.log("=== INTEGRITY CHECK COMPLETE ===");
console.log(`Passed: ${passed}/${checks.length}`);
console.log(`Failed: ${failed}/${checks.length}`);

if (failed > 0) {
  console.log("");
  console.log("Fix the failing checks above before proceeding to Task 11.");
  process.exit(1);
} else {
  console.log("");
  console.log("🐾 All systems go. Ready for Task 11.");
}
