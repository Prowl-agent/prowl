import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DataDestination = "local" | "cloud" | "hybrid";

export interface RequestAuditEntry {
  id: string;
  timestamp: string;
  taskType: "chat" | "code" | "agent" | "tool" | "unknown";
  promptPreview: string;
  destination: DataDestination;
  localModel?: string;
  cloudProvider?: string;
  cloudModel?: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  routingReason: string;
}

export interface PrivacyStats {
  totalRequests: number;
  localRequests: number;
  cloudRequests: number;
  localPercent: number;
  daysFullyLocal: number;
  currentStreak: number;
  tokensProcessedLocally: number;
  tokensProcessedCloud: number;
  lastCloudRequest: string | null;
}

export interface PrivacyStatus {
  level: "full" | "hybrid" | "cloud-heavy";
  label: string;
  color: "green" | "yellow" | "red";
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function getPrivacyDir(): string {
  return path.join(os.homedir(), ".prowl", "privacy");
}

function getAuditPath(): string {
  return path.join(getPrivacyDir(), "audit.jsonl");
}

function getStatsPath(): string {
  return path.join(getPrivacyDir(), "stats.json");
}

function createDefaultStats(): PrivacyStats {
  return {
    totalRequests: 0,
    localRequests: 0,
    cloudRequests: 0,
    localPercent: 0,
    daysFullyLocal: 0,
    currentStreak: 0,
    tokensProcessedLocally: 0,
    tokensProcessedCloud: 0,
    lastCloudRequest: null,
  };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function normalizeStats(value: unknown): PrivacyStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultStats();
  }

  const raw = value as Partial<PrivacyStats>;

  return {
    totalRequests: toFiniteNumber(raw.totalRequests),
    localRequests: toFiniteNumber(raw.localRequests),
    cloudRequests: toFiniteNumber(raw.cloudRequests),
    localPercent: toFiniteNumber(raw.localPercent),
    daysFullyLocal: toFiniteNumber(raw.daysFullyLocal),
    currentStreak: toFiniteNumber(raw.currentStreak),
    tokensProcessedLocally: toFiniteNumber(raw.tokensProcessedLocally),
    tokensProcessedCloud: toFiniteNumber(raw.tokensProcessedCloud),
    lastCloudRequest: normalizeTimestamp(raw.lastCloudRequest),
  };
}

function isTaskType(value: unknown): value is RequestAuditEntry["taskType"] {
  return (
    value === "chat" ||
    value === "code" ||
    value === "agent" ||
    value === "tool" ||
    value === "unknown"
  );
}

function isDataDestination(value: unknown): value is DataDestination {
  return value === "local" || value === "cloud" || value === "hybrid";
}

function isRequestAuditEntry(value: unknown): value is RequestAuditEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const entry = value as Partial<RequestAuditEntry>;
  return (
    typeof entry.id === "string" &&
    normalizeTimestamp(entry.timestamp) !== null &&
    isTaskType(entry.taskType) &&
    typeof entry.promptPreview === "string" &&
    isDataDestination(entry.destination) &&
    (entry.localModel === undefined || typeof entry.localModel === "string") &&
    (entry.cloudProvider === undefined || typeof entry.cloudProvider === "string") &&
    (entry.cloudModel === undefined || typeof entry.cloudModel === "string") &&
    typeof entry.promptTokens === "number" &&
    Number.isFinite(entry.promptTokens) &&
    typeof entry.completionTokens === "number" &&
    Number.isFinite(entry.completionTokens) &&
    typeof entry.durationMs === "number" &&
    Number.isFinite(entry.durationMs) &&
    typeof entry.routingReason === "string"
  );
}

function isCloudTouched(entry: RequestAuditEntry): boolean {
  return entry.destination === "cloud" || entry.destination === "hybrid";
}

function getTotalTokens(entry: RequestAuditEntry): number {
  return entry.promptTokens + entry.completionTokens;
}

function floorToTwoDecimals(value: number): number {
  return Math.floor(value * 100) / 100;
}

function getUtcDayKey(timestamp: string): string | null {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function getDayKeyMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`);
}

function getConsecutiveLocalDays(entries: RequestAuditEntry[], nowMs = Date.now()): number {
  const dayHasCloud = new Map<string, boolean>();

  for (const entry of entries) {
    const dayKey = getUtcDayKey(entry.timestamp);
    if (!dayKey) {
      continue;
    }

    const existing = dayHasCloud.get(dayKey) ?? false;
    dayHasCloud.set(dayKey, existing || isCloudTouched(entry));
  }

  if (dayHasCloud.size === 0) {
    return 0;
  }

  const earliestDay = [...dayHasCloud.keys()].toSorted()[0];
  const earliestDayMs = getDayKeyMs(earliestDay);
  if (!Number.isFinite(earliestDayMs)) {
    return 0;
  }

  const now = new Date(nowMs);
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let streak = 0;

  for (let dayMs = todayStartMs; dayMs >= earliestDayMs; dayMs -= DAY_MS) {
    const dayKey = new Date(dayMs).toISOString().slice(0, 10);
    if (dayHasCloud.get(dayKey)) {
      break;
    }
    streak += 1;
  }

  return streak;
}

function sortByTimestamp(
  entries: RequestAuditEntry[],
  direction: "asc" | "desc",
): RequestAuditEntry[] {
  return entries.toSorted((left, right) => {
    const leftMs = Date.parse(left.timestamp);
    const rightMs = Date.parse(right.timestamp);
    const leftTs = Number.isFinite(leftMs) ? leftMs : 0;
    const rightTs = Number.isFinite(rightMs) ? rightMs : 0;
    return direction === "asc" ? leftTs - rightTs : rightTs - leftTs;
  });
}

function calculateStats(entries: RequestAuditEntry[]): PrivacyStats {
  if (entries.length === 0) {
    return createDefaultStats();
  }

  const totalRequests = entries.length;
  const localEntries = entries.filter((entry) => entry.destination === "local");
  const cloudEntries = entries.filter((entry) => isCloudTouched(entry));

  const localRequests = localEntries.length;
  const cloudRequests = cloudEntries.length;
  const localPercent = floorToTwoDecimals((localRequests / totalRequests) * 100);
  const tokensProcessedLocally = localEntries.reduce(
    (sum, entry) => sum + getTotalTokens(entry),
    0,
  );
  const tokensProcessedCloud = cloudEntries.reduce((sum, entry) => sum + getTotalTokens(entry), 0);

  const lastCloudRequest = cloudEntries
    .map((entry) => ({
      entry,
      timestampMs: Date.parse(entry.timestamp),
    }))
    .filter((item) => Number.isFinite(item.timestampMs))
    .toSorted((left, right) => right.timestampMs - left.timestampMs)[0]?.entry.timestamp;

  const consecutiveLocalDays = getConsecutiveLocalDays(entries);

  return {
    totalRequests,
    localRequests,
    cloudRequests,
    localPercent,
    daysFullyLocal: consecutiveLocalDays,
    currentStreak: consecutiveLocalDays,
    tokensProcessedLocally,
    tokensProcessedCloud,
    lastCloudRequest: lastCloudRequest ?? null,
  };
}

async function readAuditEntries(): Promise<RequestAuditEntry[]> {
  try {
    const content = await fs.readFile(getAuditPath(), "utf8");
    const entries: RequestAuditEntry[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRequestAuditEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        continue;
      }
    }

    return entries;
  } catch {
    return [];
  }
}

async function readStatsCache(): Promise<PrivacyStats | null> {
  try {
    const raw = await fs.readFile(getStatsPath(), "utf8");
    return normalizeStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeStats(stats: PrivacyStats): Promise<void> {
  await fs.writeFile(getStatsPath(), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
}

function escapeCsvCell(value: string | number): string {
  const stringValue = String(value);
  if (stringValue.includes(",") || stringValue.includes("\n") || stringValue.includes('"')) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

export async function initPrivacy(): Promise<void> {
  await fs.mkdir(getPrivacyDir(), { recursive: true });

  const existingStats = await readStatsCache();
  if (existingStats === null) {
    await writeStats(createDefaultStats());
  }
}

export async function recordRequest(
  entry: Omit<RequestAuditEntry, "id" | "timestamp">,
): Promise<RequestAuditEntry> {
  await fs.mkdir(getPrivacyDir(), { recursive: true });

  const completeEntry: RequestAuditEntry = {
    id: randomUUID(),
    timestamp: new Date(Date.now()).toISOString(),
    ...entry,
  };

  await fs.appendFile(getAuditPath(), `${JSON.stringify(completeEntry)}\n`, "utf8");
  await rebuildStats();

  return completeEntry;
}

export async function rebuildStats(): Promise<PrivacyStats> {
  try {
    await fs.mkdir(getPrivacyDir(), { recursive: true });
    const entries = await readAuditEntries();
    const stats = calculateStats(entries);
    await writeStats(stats);
    return stats;
  } catch {
    return createDefaultStats();
  }
}

export async function getPrivacyStats(): Promise<PrivacyStats> {
  try {
    const cachedStats = await readStatsCache();
    if (cachedStats !== null) {
      return cachedStats;
    }

    return await rebuildStats();
  } catch {
    return createDefaultStats();
  }
}

export function getPrivacyStatus(stats: PrivacyStats): PrivacyStatus {
  if (stats.totalRequests === 0 || stats.localPercent === 100) {
    return {
      level: "full",
      label: "🟢 All data processed locally",
      color: "green",
    };
  }

  if (stats.localPercent >= 70) {
    return {
      level: "hybrid",
      label: "🟡 Hybrid mode — some cloud usage",
      color: "yellow",
    };
  }

  return {
    level: "cloud-heavy",
    label: "🔴 Cloud-heavy — consider local model",
    color: "red",
  };
}

export async function getAuditLog(options?: {
  limit?: number;
  offset?: number;
  destination?: DataDestination;
}): Promise<RequestAuditEntry[]> {
  try {
    const limit = Math.max(0, options?.limit ?? 50);
    const offset = Math.max(0, options?.offset ?? 0);

    const entries = await readAuditEntries();
    const filteredEntries = options?.destination
      ? entries.filter((entry) => entry.destination === options.destination)
      : entries;

    const sortedEntries = sortByTimestamp(filteredEntries, "desc");
    return sortedEntries.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export async function exportAuditCSV(): Promise<string> {
  const headers =
    "timestamp,taskType,promptPreview,destination,localModel,cloudProvider,cloudModel,promptTokens,completionTokens,durationMs,routingReason";

  try {
    const entries = sortByTimestamp(await readAuditEntries(), "asc");
    const rows = entries.map((entry) =>
      [
        entry.timestamp,
        entry.taskType,
        entry.promptPreview,
        entry.destination,
        entry.localModel ?? "",
        entry.cloudProvider ?? "",
        entry.cloudModel ?? "",
        entry.promptTokens,
        entry.completionTokens,
        entry.durationMs,
        entry.routingReason,
      ]
        .map((value) => escapeCsvCell(value))
        .join(","),
    );

    return [headers, ...rows].join("\n");
  } catch {
    return headers;
  }
}

export async function clearPrivacyData(): Promise<void> {
  await Promise.all([
    fs.rm(getAuditPath(), { force: true }),
    fs.rm(getStatsPath(), { force: true }),
  ]);
}
