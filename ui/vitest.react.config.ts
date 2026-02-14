import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/ui/components/CostSavings.test.tsx"],
    environment: "jsdom",
  },
});
