import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/ui/components/CostSavings.test.tsx",
      "src/ui/components/GettingStarted.test.tsx",
      "src/ui/components/ModelManager.test.tsx",
      "src/ui/components/PrivacyDashboard.test.tsx",
      "src/ui/components/AppShell.test.tsx",
      "src/ui/components/SetupWizard.test.tsx",
      "ui/src/ui/components/CostSavings.test.tsx",
      "ui/src/ui/components/GettingStarted.test.tsx",
      "ui/src/ui/components/ModelManager.test.tsx",
      "ui/src/ui/components/PrivacyDashboard.test.tsx",
      "ui/src/ui/components/AppShell.test.tsx",
      "ui/src/ui/components/SetupWizard.test.tsx",
    ],
    environment: "jsdom",
  },
});
