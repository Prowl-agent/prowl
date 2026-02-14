import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CloudProvider = "openai" | "anthropic" | "google" | "groq";

export interface CloudPricing {
  provider: CloudProvider;
  model: string;
  inputPricePer1kTokens: number;
  outputPricePer1kTokens: number;
}

export interface InferenceRecord {
  id: string;
  timestamp: string;
  localModel: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  tokensPerSecond: number;
  taskType: "chat" | "code" | "agent" | "tool" | "unknown";
}

export interface SavingsReport {
  period: "day" | "week" | "month" | "all-time";
  totalInferences: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  localCostUSD: number;
  cloudEquivalents: CloudEquivalent[];
  bestSavingsUSD: number;
  bestSavingsProvider: string;
  avgTokensPerSecond: number;
  totalDurationMs: number;
}

export interface CloudEquivalent {
  provider: CloudProvider;
  model: string;
  estimatedCostUSD: number;
  savingsUSD: number;
  savingsPercent: number;
}

interface AnalyticsTotals {
  totalInferences: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  allTimeSavingsUSD: number;
  lastUpdated: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export const CLOUD_PRICING: CloudPricing[] = [
  {
    provider: "openai",
    model: "gpt-4o",
    inputPricePer1kTokens: 0.0025,
    outputPricePer1kTokens: 0.01,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPricePer1kTokens: 0.00015,
    outputPricePer1kTokens: 0.0006,
  },
  {
    provider: "openai",
    model: "o3-mini",
    inputPricePer1kTokens: 0.0011,
    outputPricePer1kTokens: 0.0044,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputPricePer1kTokens: 0.003,
    outputPricePer1kTokens: 0.015,
  },
  {
    provider: "anthropic",
    model: "claude-haiku-3-5",
    inputPricePer1kTokens: 0.0008,
    outputPricePer1kTokens: 0.004,
  },
  {
    provider: "google",
    model: "gemini-2.0-flash",
    inputPricePer1kTokens: 0.0001,
    outputPricePer1kTokens: 0.0004,
  },
  {
    provider: "google",
    model: "gemini-1.5-pro",
    inputPricePer1kTokens: 0.00125,
    outputPricePer1kTokens: 0.005,
  },
  {
    provider: "groq",
    model: "llama-3.3-70b",
    inputPricePer1kTokens: 0.00059,
    outputPricePer1kTokens: 0.00079,
  },
];

const PRIMARY_COMPARISON = CLOUD_PRICING.find(
  (pricing) => pricing.provider === "openai" && pricing.model === "gpt-4o",
)!;

function getAnalyticsDir(): string {
  return path.join(os.homedir(), ".prowl", "analytics");
}

function getInferencesPath(): string {
  return path.join(getAnalyticsDir(), "inferences.jsonl");
}

function getTotalsPath(): string {
  return path.join(getAnalyticsDir(), "totals.json");
}

function createDefaultTotals(lastUpdated = new Date().toISOString()): AnalyticsTotals {
  return {
    totalInferences: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    allTimeSavingsUSD: 0,
    lastUpdated,
  };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTotals(value: unknown): AnalyticsTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultTotals();
  }

  const raw = value as Partial<AnalyticsTotals>;
  const lastUpdated =
    typeof raw.lastUpdated === "string" && raw.lastUpdated.length > 0
      ? raw.lastUpdated
      : new Date().toISOString();

  return {
    totalInferences: toFiniteNumber(raw.totalInferences),
    totalPromptTokens: toFiniteNumber(raw.totalPromptTokens),
    totalCompletionTokens: toFiniteNumber(raw.totalCompletionTokens),
    allTimeSavingsUSD: toFiniteNumber(raw.allTimeSavingsUSD),
    lastUpdated,
  };
}

function isInferenceRecord(value: unknown): value is InferenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<InferenceRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.localModel === "string" &&
    typeof record.promptTokens === "number" &&
    Number.isFinite(record.promptTokens) &&
    typeof record.completionTokens === "number" &&
    Number.isFinite(record.completionTokens) &&
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs) &&
    typeof record.tokensPerSecond === "number" &&
    Number.isFinite(record.tokensPerSecond) &&
    typeof record.taskType === "string"
  );
}

async function readTotals(): Promise<AnalyticsTotals> {
  try {
    const raw = await fs.readFile(getTotalsPath(), "utf8");
    return normalizeTotals(JSON.parse(raw));
  } catch {
    return createDefaultTotals();
  }
}

async function writeTotals(totals: AnalyticsTotals): Promise<void> {
  await fs.writeFile(getTotalsPath(), `${JSON.stringify(totals, null, 2)}\n`, "utf8");
}

async function readInferenceRecords(): Promise<InferenceRecord[]> {
  try {
    const content = await fs.readFile(getInferencesPath(), "utf8");
    const records: InferenceRecord[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isInferenceRecord(parsed)) {
          records.push(parsed);
        }
      } catch {
        continue;
      }
    }

    return records;
  } catch {
    return [];
  }
}

function getCutoffTimestamp(period: SavingsReport["period"], nowMs: number): number | null {
  if (period === "day") {
    return nowMs - DAY_MS;
  }
  if (period === "week") {
    return nowMs - 7 * DAY_MS;
  }
  if (period === "month") {
    return nowMs - 30 * DAY_MS;
  }
  return null;
}

function isRecordInPeriod(record: InferenceRecord, cutoffMs: number | null): boolean {
  if (cutoffMs === null) {
    return true;
  }
  const timestampMs = Date.parse(record.timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
}

export function calculateCloudCost(
  promptTokens: number,
  completionTokens: number,
  pricing: CloudPricing,
): number {
  const promptCost = (promptTokens / 1000) * pricing.inputPricePer1kTokens;
  const completionCost = (completionTokens / 1000) * pricing.outputPricePer1kTokens;
  return promptCost + completionCost;
}

export function formatSavings(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  if (value === 0) {
    return "$0.00";
  }

  const absoluteValue = Math.abs(value);
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: absoluteValue >= 1000,
  });
  const formatted = formatter.format(absoluteValue);
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export async function initAnalytics(): Promise<void> {
  await fs.mkdir(getAnalyticsDir(), { recursive: true });
  try {
    await fs.readFile(getTotalsPath(), "utf8");
  } catch {
    await writeTotals(createDefaultTotals());
  }
}

export async function recordInference(
  record: Omit<InferenceRecord, "id" | "timestamp">,
): Promise<InferenceRecord> {
  await initAnalytics();

  const nowIso = new Date().toISOString();
  const completeRecord: InferenceRecord = {
    id: randomUUID(),
    timestamp: nowIso,
    ...record,
  };

  await fs.appendFile(getInferencesPath(), `${JSON.stringify(completeRecord)}\n`, "utf8");

  const totals = await readTotals();
  const updatedTotals: AnalyticsTotals = {
    totalInferences: totals.totalInferences + 1,
    totalPromptTokens: totals.totalPromptTokens + completeRecord.promptTokens,
    totalCompletionTokens: totals.totalCompletionTokens + completeRecord.completionTokens,
    allTimeSavingsUSD:
      totals.allTimeSavingsUSD +
      calculateCloudCost(
        completeRecord.promptTokens,
        completeRecord.completionTokens,
        PRIMARY_COMPARISON,
      ),
    lastUpdated: nowIso,
  };
  await writeTotals(updatedTotals);

  return completeRecord;
}

export async function getSavingsReport(period: SavingsReport["period"]): Promise<SavingsReport> {
  await initAnalytics();

  const nowMs = Date.now();
  const cutoff = getCutoffTimestamp(period, nowMs);
  const records = (await readInferenceRecords()).filter((record) =>
    isRecordInPeriod(record, cutoff),
  );

  const totalInferences = records.length;
  const totalPromptTokens = records.reduce((sum, record) => sum + record.promptTokens, 0);
  const totalCompletionTokens = records.reduce((sum, record) => sum + record.completionTokens, 0);
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const totalDurationMs = records.reduce((sum, record) => sum + record.durationMs, 0);
  const avgTokensPerSecond =
    totalInferences > 0
      ? records.reduce((sum, record) => sum + record.tokensPerSecond, 0) / totalInferences
      : 0;

  const cloudEquivalents = CLOUD_PRICING.map((pricing) => {
    const estimatedCostUSD = calculateCloudCost(totalPromptTokens, totalCompletionTokens, pricing);
    return {
      provider: pricing.provider,
      model: pricing.model,
      estimatedCostUSD,
      savingsUSD: estimatedCostUSD,
      savingsPercent: 100,
    } satisfies CloudEquivalent;
  }).toSorted((a, b) => b.estimatedCostUSD - a.estimatedCostUSD);

  const best = cloudEquivalents[0];

  return {
    period,
    totalInferences,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    localCostUSD: 0,
    cloudEquivalents,
    bestSavingsUSD: best?.estimatedCostUSD ?? 0,
    bestSavingsProvider: best ? `${best.provider} ${best.model}` : "",
    avgTokensPerSecond,
    totalDurationMs,
  };
}

export async function getRunningTotal(): Promise<{
  allTimeSavingsUSD: number;
  totalInferences: number;
  formattedSavings: string;
}> {
  await initAnalytics();
  const totals = await readTotals();
  return {
    allTimeSavingsUSD: totals.allTimeSavingsUSD,
    totalInferences: totals.totalInferences,
    formattedSavings: formatSavings(totals.allTimeSavingsUSD),
  };
}

export async function clearAnalytics(): Promise<void> {
  await Promise.all([
    fs.rm(getInferencesPath(), { force: true }),
    fs.rm(getTotalsPath(), { force: true }),
  ]);
}
