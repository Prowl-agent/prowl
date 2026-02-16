import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clearCloudPricingOverrideFile: vi.fn(),
  getCloudPricing: vi.fn(),
  getCloudPricingOverridePath: vi.fn(),
  readFile: vi.fn(),
  writeCloudPricingOverrideFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: mocks.readFile,
  },
}));

vi.mock("../../../packages/core/src/analytics/cost-tracker.js", () => ({
  clearCloudPricingOverrideFile: mocks.clearCloudPricingOverrideFile,
  getCloudPricing: mocks.getCloudPricing,
  getCloudPricingOverridePath: mocks.getCloudPricingOverridePath,
  writeCloudPricingOverrideFile: mocks.writeCloudPricingOverrideFile,
}));

import { modelsPricingListCommand, modelsPricingUpdateCommand } from "./pricing.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

describe("models pricing commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloudPricing.mockReturnValue([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 0.0025,
        outputPricePer1kTokens: 0.01,
      },
    ]);
    mocks.getCloudPricingOverridePath.mockReturnValue(
      "/home/tester/.prowl/analytics/cloud-pricing.json",
    );
    mocks.clearCloudPricingOverrideFile.mockResolvedValue(
      "/home/tester/.prowl/analytics/cloud-pricing.json",
    );
    mocks.writeCloudPricingOverrideFile.mockResolvedValue({
      path: "/home/tester/.prowl/analytics/cloud-pricing.json",
      entryCount: 1,
    });
    mocks.readFile.mockResolvedValue(
      JSON.stringify([
        {
          provider: "openai",
          model: "gpt-4o",
          inputPricePer1kTokens: 1,
          outputPricePer1kTokens: 2,
        },
      ]),
    );
  });

  it("lists effective pricing in json mode", async () => {
    const runtime = createRuntime();
    await modelsPricingListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"overridePath": "/home/tester/.prowl/analytics/cloud-pricing.json"'),
    );
  });

  it("updates pricing from file source", async () => {
    const runtime = createRuntime();
    await modelsPricingUpdateCommand({ file: "./pricing.json" }, runtime);

    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeCloudPricingOverrideFile).toHaveBeenCalledWith([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 1,
        outputPricePer1kTokens: 2,
      },
    ]);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Updated cloud pricing override from"),
    );
  });

  it("clears pricing override file", async () => {
    const runtime = createRuntime();
    await modelsPricingUpdateCommand({ clear: true }, runtime);

    expect(mocks.clearCloudPricingOverrideFile).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "Cleared cloud pricing override: /home/tester/.prowl/analytics/cloud-pricing.json",
    );
  });

  it("requires exactly one update source", async () => {
    const runtime = createRuntime();

    await expect(
      modelsPricingUpdateCommand(
        {
          file: "pricing.json",
          url: "https://example.com/pricing.json",
        },
        runtime,
      ),
    ).rejects.toThrow("Specify exactly one source");
  });
});
