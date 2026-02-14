import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/ui/components/CostSavings.test.tsx",
      "src/ui/components/ModelManager.test.tsx",
      "src/ui/components/PrivacyDashboard.test.tsx",
      "ui/src/ui/components/CostSavings.test.tsx",
      "ui/src/ui/components/ModelManager.test.tsx",
      "ui/src/ui/components/PrivacyDashboard.test.tsx",
    ],
    environment: "jsdom",
  },
});
