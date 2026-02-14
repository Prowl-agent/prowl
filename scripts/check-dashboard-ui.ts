import { execSync } from "node:child_process";

const tests = [
  "ui/src/ui/components/CostSavings.test.tsx",
  "ui/src/ui/components/ModelManager.test.tsx",
  "ui/src/ui/components/PrivacyDashboard.test.tsx",
  "ui/src/ui/components/AppShell.test.tsx",
  "ui/src/ui/components/SetupWizard.test.tsx",
];

const command = `pnpm vitest run --config ui/vitest.react.config.ts ${tests.join(" ")}`;

try {
  execSync(command, {
    stdio: "pipe",
    timeout: 180_000,
  });
  console.log("✅ Dashboard UI checks PASSED");
} catch (error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    Buffer.isBuffer((error as { stdout?: unknown }).stdout)
  ) {
    console.log(((error as { stdout: Buffer }).stdout.toString() || "").slice(-1200));
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    Buffer.isBuffer((error as { stderr?: unknown }).stderr)
  ) {
    console.log(((error as { stderr: Buffer }).stderr.toString() || "").slice(-1200));
  }
  throw new Error("Dashboard UI tests failed", { cause: error });
}
