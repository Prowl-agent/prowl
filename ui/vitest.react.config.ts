import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/ui/components/CostSavings.test.tsx", "src/ui/components/ModelManager.test.tsx"],
    environment: "jsdom",
  },
});
