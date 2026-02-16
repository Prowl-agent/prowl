import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fileState, randomUUIDMock } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const fileMtimes = new Map<string, number>();
  let nextMtime = 1;

  const createEnoentError = (filePath: string): Error => {
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    return error;
  };

  const touch = (filePath: string): void => {
    fileMtimes.set(filePath, nextMtime);
    nextMtime += 1;
  };

  const readFile = vi.fn(async (filePath: string) => {
    const value = files.get(filePath);
    if (value === undefined) {
      throw createEnoentError(filePath);
    }
    return value;
  });

  const writeFile = vi.fn(async (filePath: string, contents: string) => {
    files.set(filePath, contents);
    touch(filePath);
  });

  const appendFile = vi.fn(async (filePath: string, contents: string) => {
    const existing = files.get(filePath) ?? "";
    files.set(filePath, `${existing}${contents}`);
    touch(filePath);
  });

  const mkdir = vi.fn(async () => undefined);

  const rm = vi.fn(async (filePath: string) => {
    files.delete(filePath);
    fileMtimes.delete(filePath);
  });

  const readFileSync = vi.fn((filePath: string): string => {
    const value = files.get(filePath);
    if (value === undefined) {
      throw createEnoentError(filePath);
    }
    return value;
  });

  const statSync = vi.fn((filePath: string): { mtimeMs: number } => {
    if (!files.has(filePath)) {
      throw createEnoentError(filePath);
    }
    return {
      mtimeMs: fileMtimes.get(filePath) ?? 0,
    };
  });

  const randomUUID = vi.fn(() => "test-uuid-123");

  return {
    fileState: {
      files,
      fileMtimes,
      readFile,
      writeFile,
      appendFile,
      mkdir,
      rm,
      touch,
      readFileSync,
      statSync,
    },
    randomUUIDMock: randomUUID,
  };
});

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/home/tester",
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: fileState.readFile,
    writeFile: fileState.writeFile,
    appendFile: fileState.appendFile,
    mkdir: fileState.mkdir,
    rm: fileState.rm,
  },
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: fileState.readFileSync,
    statSync: fileState.statSync,
  },
}));

import {
  calculateCloudCost,
  clearCloudPricingOverride,
  clearCloudPricingOverrideFile,
  clearAnalytics,
  CLOUD_PRICING,
  formatSavings,
  getCloudPricing,
  getCloudPricingOverridePath,
  getRunningTotal,
  getSavingsReport,
  recordInference,
  setCloudPricingOverride,
  writeCloudPricingOverrideFile,
} from "./cost-tracker.js";

const analyticsDir = path.join("/home/tester", ".prowl", "analytics");
const inferencesPath = path.join(analyticsDir, "inferences.jsonl");
const totalsPath = path.join(analyticsDir, "totals.json");
const pricingOverridePath = path.join(analyticsDir, "cloud-pricing.json");
const originalCloudPricingEnv = process.env.OPENCLAW_CLOUD_PRICING_JSON;

function seedInferences(records: Array<Record<string, unknown>>): void {
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  fileState.files.set(inferencesPath, lines ? `${lines}\n` : "");
  fileState.touch(inferencesPath);
}

describe("cost-tracker", () => {
  beforeEach(() => {
    fileState.files.clear();
    fileState.fileMtimes.clear();
    fileState.readFile.mockClear();
    fileState.writeFile.mockClear();
    fileState.appendFile.mockClear();
    fileState.mkdir.mockClear();
    fileState.rm.mockClear();
    fileState.readFileSync.mockClear();
    fileState.statSync.mockClear();
    randomUUIDMock.mockReset();
    randomUUIDMock.mockReturnValue("test-uuid-123");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-14T12:00:00.000Z"));
    clearCloudPricingOverride();
    delete process.env.OPENCLAW_CLOUD_PRICING_JSON;
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCloudPricingOverride();
    if (originalCloudPricingEnv === undefined) {
      delete process.env.OPENCLAW_CLOUD_PRICING_JSON;
    } else {
      process.env.OPENCLAW_CLOUD_PRICING_JSON = originalCloudPricingEnv;
    }
  });

  it("recordInference creates record with id/timestamp and appends to inferences file", async () => {
    const record = await recordInference({
      localModel: "qwen3:8b",
      promptTokens: 120,
      completionTokens: 80,
      durationMs: 1_500,
      tokensPerSecond: 53.2,
      taskType: "chat",
    });

    expect(record.id).toBe("test-uuid-123");
    expect(record.timestamp).toBe("2026-02-14T12:00:00.000Z");

    const storedLine = fileState.files.get(inferencesPath);
    expect(storedLine).toBeDefined();
    expect(storedLine).toContain('"id":"test-uuid-123"');
    expect(storedLine).toContain('"localModel":"qwen3:8b"');
  });

  it("recordInference updates totals.json with counts and gpt-4o savings", async () => {
    await recordInference({
      localModel: "qwen3:8b",
      promptTokens: 1_000,
      completionTokens: 500,
      durationMs: 1_000,
      tokensPerSecond: 30,
      taskType: "agent",
    });

    const totals = JSON.parse(fileState.files.get(totalsPath) ?? "{}") as {
      totalInferences: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      allTimeSavingsUSD: number;
    };

    expect(totals.totalInferences).toBe(1);
    expect(totals.totalPromptTokens).toBe(1_000);
    expect(totals.totalCompletionTokens).toBe(500);
    expect(totals.allTimeSavingsUSD).toBeCloseTo(0.0075);
  });

  it("recordInference uses overridden gpt-4o prices when provided", async () => {
    setCloudPricingOverride([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 1,
        outputPricePer1kTokens: 2,
      },
    ]);

    await recordInference({
      localModel: "qwen3:8b",
      promptTokens: 1_000,
      completionTokens: 500,
      durationMs: 1_000,
      tokensPerSecond: 30,
      taskType: "agent",
    });

    const totals = JSON.parse(fileState.files.get(totalsPath) ?? "{}") as {
      allTimeSavingsUSD: number;
    };

    expect(totals.allTimeSavingsUSD).toBeCloseTo(2);
  });

  it("getSavingsReport filters inferences by period", async () => {
    seedInferences([
      {
        id: "a",
        timestamp: "2026-02-14T10:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 100,
        completionTokens: 100,
        durationMs: 100,
        tokensPerSecond: 10,
        taskType: "chat",
      },
      {
        id: "b",
        timestamp: "2026-02-08T12:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 200,
        completionTokens: 200,
        durationMs: 200,
        tokensPerSecond: 20,
        taskType: "code",
      },
      {
        id: "c",
        timestamp: "2026-01-10T12:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 300,
        completionTokens: 300,
        durationMs: 300,
        tokensPerSecond: 30,
        taskType: "agent",
      },
    ]);

    const dayReport = await getSavingsReport("day");
    const weekReport = await getSavingsReport("week");
    const monthReport = await getSavingsReport("month");

    expect(dayReport.totalInferences).toBe(1);
    expect(weekReport.totalInferences).toBe(2);
    expect(monthReport.totalInferences).toBe(2);
  });

  it("getSavingsReport calculates cloud equivalents for known token totals", async () => {
    seedInferences([
      {
        id: "one",
        timestamp: "2026-02-14T11:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 1_000,
        completionTokens: 1_000,
        durationMs: 2_000,
        tokensPerSecond: 42,
        taskType: "chat",
      },
    ]);

    const report = await getSavingsReport("all-time");
    const gpt4o = report.cloudEquivalents.find(
      (entry) => entry.provider === "openai" && entry.model === "gpt-4o",
    );

    expect(gpt4o).toBeDefined();
    expect(gpt4o?.estimatedCostUSD).toBeCloseTo(0.0125);
    expect(gpt4o?.savingsUSD).toBeCloseTo(0.0125);
    expect(gpt4o?.savingsPercent).toBe(100);
    expect(report.avgTokensPerSecond).toBe(42);
    expect(report.totalDurationMs).toBe(2_000);
  });

  it("getSavingsReport sorts cloud equivalents by cost descending and reports best provider", async () => {
    seedInferences([
      {
        id: "one",
        timestamp: "2026-02-14T11:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 1_000,
        completionTokens: 1_000,
        durationMs: 2_000,
        tokensPerSecond: 42,
        taskType: "chat",
      },
    ]);

    const report = await getSavingsReport("all-time");

    expect(report.cloudEquivalents[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(report.bestSavingsProvider).toBe("anthropic claude-sonnet-4-5");
    expect(report.bestSavingsUSD).toBeCloseTo(report.cloudEquivalents[0].estimatedCostUSD);
  });

  it("getSavingsReport uses OPENCLAW_CLOUD_PRICING_JSON when provided", async () => {
    process.env.OPENCLAW_CLOUD_PRICING_JSON = JSON.stringify([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 1,
        outputPricePer1kTokens: 1,
      },
    ]);
    seedInferences([
      {
        id: "one",
        timestamp: "2026-02-14T11:00:00.000Z",
        localModel: "qwen3:8b",
        promptTokens: 1_000,
        completionTokens: 1_000,
        durationMs: 2_000,
        tokensPerSecond: 42,
        taskType: "chat",
      },
    ]);

    const report = await getSavingsReport("all-time");

    expect(report.cloudEquivalents).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        estimatedCostUSD: 2,
        savingsUSD: 2,
        savingsPercent: 100,
      },
    ]);
    expect(report.bestSavingsProvider).toBe("openai gpt-4o");
  });

  it("getCloudPricing uses override file when env is not set", () => {
    fileState.files.set(
      pricingOverridePath,
      JSON.stringify([
        {
          provider: "openai",
          model: "gpt-4o",
          inputPricePer1kTokens: 7,
          outputPricePer1kTokens: 8,
        },
      ]),
    );
    fileState.touch(pricingOverridePath);

    expect(getCloudPricing()).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 7,
        outputPricePer1kTokens: 8,
      },
    ]);
  });

  it("getRunningTotal reads totals.json and formats savings", async () => {
    fileState.files.set(
      totalsPath,
      JSON.stringify({
        totalInferences: 7,
        totalPromptTokens: 9_000,
        totalCompletionTokens: 3_000,
        allTimeSavingsUSD: 1_204.5,
        lastUpdated: "2026-02-14T12:00:00.000Z",
      }),
    );

    const runningTotal = await getRunningTotal();
    expect(runningTotal).toEqual({
      allTimeSavingsUSD: 1_204.5,
      totalInferences: 7,
      formattedSavings: "$1,204.50",
    });
  });

  it("formatSavings formats small and large amounts", () => {
    expect(formatSavings(0)).toBe("$0.00");
    expect(formatSavings(9.99)).toBe("$9.99");
    expect(formatSavings(99.99)).toBe("$99.99");
    expect(formatSavings(1000)).toBe("$1,000.00");
    expect(formatSavings(12345.67)).toBe("$12,345.67");
  });

  it("calculateCloudCost computes prompt/output token pricing", () => {
    const pricing = CLOUD_PRICING.find(
      (entry) => entry.provider === "openai" && entry.model === "gpt-4o",
    );
    expect(pricing).toBeDefined();
    expect(calculateCloudCost(2_000, 3_000, pricing!)).toBeCloseTo(0.035);
  });

  it("runtime cloud pricing override takes precedence over env override", () => {
    process.env.OPENCLAW_CLOUD_PRICING_JSON = JSON.stringify([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 0.1,
        outputPricePer1kTokens: 0.1,
      },
    ]);
    setCloudPricingOverride([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputPricePer1kTokens: 0.2,
        outputPricePer1kTokens: 0.3,
      },
    ]);

    expect(getCloudPricing()).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputPricePer1kTokens: 0.2,
        outputPricePer1kTokens: 0.3,
      },
    ]);
  });

  it("writeCloudPricingOverrideFile writes normalized entries and reports path", async () => {
    const result = await writeCloudPricingOverrideFile([
      {
        provider: "openai",
        model: "gpt-4o",
        inputPricePer1kTokens: 1,
        outputPricePer1kTokens: 2,
      },
      {
        provider: "invalid",
        model: "",
        inputPricePer1kTokens: -1,
        outputPricePer1kTokens: 0,
      },
    ]);

    expect(result).toEqual({
      path: pricingOverridePath,
      entryCount: 1,
    });
    expect(getCloudPricingOverridePath()).toBe(pricingOverridePath);
    expect(fileState.files.get(pricingOverridePath)).toContain('"model": "gpt-4o"');
  });

  it("clearCloudPricingOverrideFile deletes override file", async () => {
    fileState.files.set(
      pricingOverridePath,
      JSON.stringify([
        {
          provider: "openai",
          model: "gpt-4o",
          inputPricePer1kTokens: 1,
          outputPricePer1kTokens: 2,
        },
      ]),
    );
    fileState.touch(pricingOverridePath);

    await clearCloudPricingOverrideFile();

    expect(fileState.files.has(pricingOverridePath)).toBe(false);
  });

  it("clearAnalytics removes inferences and totals files", async () => {
    fileState.files.set(inferencesPath, '{"id":"x"}\n');
    fileState.files.set(totalsPath, '{"totalInferences":1}\n');

    await clearAnalytics();

    expect(fileState.files.has(inferencesPath)).toBe(false);
    expect(fileState.files.has(totalsPath)).toBe(false);
  });
});
