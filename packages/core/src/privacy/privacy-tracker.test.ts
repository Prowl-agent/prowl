import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fileState, randomUUIDMock } = vi.hoisted(() => {
  const files = new Map<string, string>();

  const createEnoentError = (filePath: string): Error => {
    const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    return error;
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
  });

  const appendFile = vi.fn(async (filePath: string, contents: string) => {
    const existing = files.get(filePath) ?? "";
    files.set(filePath, `${existing}${contents}`);
  });

  const mkdir = vi.fn(async () => undefined);

  const rm = vi.fn(async (filePath: string) => {
    files.delete(filePath);
  });

  const randomUUID = vi.fn(() => "privacy-uuid-123");

  return {
    fileState: {
      files,
      readFile,
      writeFile,
      appendFile,
      mkdir,
      rm,
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

import {
  clearPrivacyData,
  exportAuditCSV,
  getAuditLog,
  getPrivacyStats,
  getPrivacyStatus,
  recordRequest,
} from "./privacy-tracker.js";

const privacyDir = path.join("/home/tester", ".prowl", "privacy");
const auditPath = path.join(privacyDir, "audit.jsonl");
const statsPath = path.join(privacyDir, "stats.json");
const fixedNowIso = "2026-02-14T12:00:00.000Z";
const fixedNowMs = Date.parse(fixedNowIso);

type EntryOverride = Partial<
  Omit<Awaited<ReturnType<typeof getAuditLog>>[number], "id" | "timestamp">
> & {
  id?: string;
  timestamp?: string;
};

function makeEntry(overrides: EntryOverride = {}): Awaited<ReturnType<typeof getAuditLog>>[number] {
  return {
    id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
    timestamp: overrides.timestamp ?? fixedNowIso,
    taskType: overrides.taskType ?? "chat",
    promptPreview: overrides.promptPreview ?? "summarize this prompt",
    destination: overrides.destination ?? "local",
    localModel: overrides.localModel,
    cloudProvider: overrides.cloudProvider,
    cloudModel: overrides.cloudModel,
    promptTokens: overrides.promptTokens ?? 10,
    completionTokens: overrides.completionTokens ?? 5,
    durationMs: overrides.durationMs ?? 100,
    routingReason: overrides.routingReason ?? "local-only policy",
  };
}

function seedAudit(entries: Array<Awaited<ReturnType<typeof getAuditLog>>[number]>): void {
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  fileState.files.set(auditPath, lines ? `${lines}\n` : "");
}

describe("privacy-tracker", () => {
  beforeEach(() => {
    fileState.files.clear();
    fileState.readFile.mockClear();
    fileState.writeFile.mockClear();
    fileState.appendFile.mockClear();
    fileState.mkdir.mockClear();
    fileState.rm.mockClear();
    randomUUIDMock.mockReset();
    randomUUIDMock.mockReturnValue("privacy-uuid-123");
    vi.spyOn(Date, "now").mockReturnValue(fixedNowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordRequest generates id + timestamp and appends audit entry", async () => {
    const entry = await recordRequest({
      taskType: "chat",
      promptPreview: "Write a poem about local inference",
      destination: "local",
      localModel: "qwen3:8b",
      promptTokens: 120,
      completionTokens: 80,
      durationMs: 800,
      routingReason: "Local model meets latency threshold",
    });

    expect(entry.id).toBe("privacy-uuid-123");
    expect(entry.timestamp).toBe(fixedNowIso);

    const fileContent = fileState.files.get(auditPath);
    expect(fileContent).toContain('"id":"privacy-uuid-123"');
    expect(fileContent).toContain('"destination":"local"');
  });

  it("recordRequest updates stats for total/local/cloud requests", async () => {
    await recordRequest({
      taskType: "chat",
      promptPreview: "local request",
      destination: "local",
      localModel: "qwen3:8b",
      promptTokens: 100,
      completionTokens: 50,
      durationMs: 400,
      routingReason: "local",
    });

    await recordRequest({
      taskType: "code",
      promptPreview: "cloud request",
      destination: "cloud",
      cloudProvider: "openai",
      cloudModel: "gpt-4o",
      promptTokens: 200,
      completionTokens: 30,
      durationMs: 500,
      routingReason: "fallback",
    });

    const stats = JSON.parse(fileState.files.get(statsPath) ?? "{}") as {
      totalRequests: number;
      localRequests: number;
      cloudRequests: number;
    };

    expect(stats.totalRequests).toBe(2);
    expect(stats.localRequests).toBe(1);
    expect(stats.cloudRequests).toBe(1);
  });

  it("getPrivacyStats returns zeroed stats when no data exists", async () => {
    const stats = await getPrivacyStats();

    expect(stats).toEqual({
      totalRequests: 0,
      localRequests: 0,
      cloudRequests: 0,
      localPercent: 0,
      daysFullyLocal: 0,
      currentStreak: 0,
      tokensProcessedLocally: 0,
      tokensProcessedCloud: 0,
      lastCloudRequest: null,
    });
  });

  it("getPrivacyStats uses stats.json fast path when present", async () => {
    fileState.files.set(
      statsPath,
      JSON.stringify({
        totalRequests: 12,
        localRequests: 9,
        cloudRequests: 3,
        localPercent: 75,
        daysFullyLocal: 4,
        currentStreak: 4,
        tokensProcessedLocally: 9_000,
        tokensProcessedCloud: 1_000,
        lastCloudRequest: "2026-02-13T09:00:00.000Z",
      }),
    );

    seedAudit([
      makeEntry({ id: "a", destination: "cloud", timestamp: "2026-02-14T11:00:00.000Z" }),
    ]);

    const stats = await getPrivacyStats();

    expect(stats.totalRequests).toBe(12);
    expect(stats.localPercent).toBe(75);
    expect(fileState.readFile).toHaveBeenCalledWith(statsPath, "utf8");
    expect(fileState.readFile).not.toHaveBeenCalledWith(auditPath, "utf8");
  });

  it("getPrivacyStats rebuilds from audit jsonl when stats cache is missing", async () => {
    seedAudit([
      makeEntry({
        id: "one",
        destination: "local",
        timestamp: "2026-02-14T11:00:00.000Z",
        promptTokens: 100,
        completionTokens: 50,
      }),
      makeEntry({
        id: "two",
        destination: "hybrid",
        timestamp: "2026-02-14T11:30:00.000Z",
        promptTokens: 200,
        completionTokens: 70,
      }),
    ]);

    const stats = await getPrivacyStats();

    expect(stats.totalRequests).toBe(2);
    expect(stats.localRequests).toBe(1);
    expect(stats.cloudRequests).toBe(1);
    expect(stats.tokensProcessedLocally).toBe(150);
    expect(stats.tokensProcessedCloud).toBe(270);
    expect(fileState.files.has(statsPath)).toBe(true);
  });

  it("getPrivacyStatus returns full/hybrid/cloud-heavy at the expected thresholds", () => {
    expect(
      getPrivacyStatus({
        totalRequests: 10,
        localRequests: 10,
        cloudRequests: 0,
        localPercent: 100,
        daysFullyLocal: 3,
        currentStreak: 3,
        tokensProcessedLocally: 100,
        tokensProcessedCloud: 0,
        lastCloudRequest: null,
      }),
    ).toEqual({
      level: "full",
      label: "🟢 All data processed locally",
      color: "green",
    });

    expect(
      getPrivacyStatus({
        totalRequests: 10,
        localRequests: 7,
        cloudRequests: 3,
        localPercent: 70,
        daysFullyLocal: 0,
        currentStreak: 0,
        tokensProcessedLocally: 70,
        tokensProcessedCloud: 30,
        lastCloudRequest: fixedNowIso,
      }),
    ).toEqual({
      level: "hybrid",
      label: "🟡 Hybrid mode — some cloud usage",
      color: "yellow",
    });

    expect(
      getPrivacyStatus({
        totalRequests: 10,
        localRequests: 6,
        cloudRequests: 4,
        localPercent: 69.99,
        daysFullyLocal: 0,
        currentStreak: 0,
        tokensProcessedLocally: 60,
        tokensProcessedCloud: 40,
        lastCloudRequest: fixedNowIso,
      }),
    ).toEqual({
      level: "cloud-heavy",
      label: "🔴 Cloud-heavy — consider local model",
      color: "red",
    });
  });

  it("getPrivacyStatus returns full status when totalRequests is zero", () => {
    const status = getPrivacyStatus({
      totalRequests: 0,
      localRequests: 0,
      cloudRequests: 0,
      localPercent: 0,
      daysFullyLocal: 0,
      currentStreak: 0,
      tokensProcessedLocally: 0,
      tokensProcessedCloud: 0,
      lastCloudRequest: null,
    });

    expect(status).toEqual({
      level: "full",
      label: "🟢 All data processed locally",
      color: "green",
    });
  });

  it("getAuditLog returns newest-first entries by default", async () => {
    seedAudit([
      makeEntry({ id: "old", timestamp: "2026-02-12T10:00:00.000Z" }),
      makeEntry({ id: "mid", timestamp: "2026-02-13T10:00:00.000Z" }),
      makeEntry({ id: "new", timestamp: "2026-02-14T10:00:00.000Z" }),
    ]);

    const entries = await getAuditLog();

    expect(entries.map((entry) => entry.id)).toEqual(["new", "mid", "old"]);
  });

  it("getAuditLog filters by destination", async () => {
    seedAudit([
      makeEntry({ id: "local-1", destination: "local" }),
      makeEntry({ id: "cloud-1", destination: "cloud" }),
      makeEntry({ id: "hybrid-1", destination: "hybrid" }),
    ]);

    const cloudEntries = await getAuditLog({ destination: "cloud" });

    expect(cloudEntries).toHaveLength(1);
    expect(cloudEntries[0]?.id).toBe("cloud-1");
  });

  it("getAuditLog applies limit and offset", async () => {
    seedAudit([
      makeEntry({ id: "a", timestamp: "2026-02-10T10:00:00.000Z" }),
      makeEntry({ id: "b", timestamp: "2026-02-11T10:00:00.000Z" }),
      makeEntry({ id: "c", timestamp: "2026-02-12T10:00:00.000Z" }),
      makeEntry({ id: "d", timestamp: "2026-02-13T10:00:00.000Z" }),
    ]);

    const entries = await getAuditLog({ offset: 1, limit: 2 });

    expect(entries.map((entry) => entry.id)).toEqual(["c", "b"]);
  });

  it("exportAuditCSV returns expected headers and rows", async () => {
    seedAudit([
      makeEntry({
        id: "one",
        timestamp: "2026-02-13T10:00:00.000Z",
        promptPreview: "hello, world",
        destination: "cloud",
        cloudProvider: "openai",
        cloudModel: "gpt-4o",
        routingReason: "cloud fallback",
      }),
    ]);

    const csv = await exportAuditCSV();
    const lines = csv.split("\n");

    expect(lines[0]).toBe(
      "timestamp,taskType,promptPreview,destination,localModel,cloudProvider,cloudModel,promptTokens,completionTokens,durationMs,routingReason",
    );
    expect(lines[1]).toContain("2026-02-13T10:00:00.000Z");
    expect(lines[1]).toContain('"hello, world"');
    expect(lines[1]).toContain("openai");
  });

  it("exportAuditCSV sorts rows oldest-first", async () => {
    seedAudit([
      makeEntry({ id: "late", timestamp: "2026-02-14T09:00:00.000Z" }),
      makeEntry({ id: "early", timestamp: "2026-02-12T09:00:00.000Z" }),
      makeEntry({ id: "middle", timestamp: "2026-02-13T09:00:00.000Z" }),
    ]);

    const csv = await exportAuditCSV();
    const rows = csv.split("\n").slice(1);

    expect(rows[0]).toContain("2026-02-12T09:00:00.000Z");
    expect(rows[1]).toContain("2026-02-13T09:00:00.000Z");
    expect(rows[2]).toContain("2026-02-14T09:00:00.000Z");
  });

  it("daysFullyLocal counts consecutive local-only days correctly", async () => {
    seedAudit([
      makeEntry({ id: "d1", timestamp: "2026-02-11T08:00:00.000Z", destination: "cloud" }),
      makeEntry({ id: "d2", timestamp: "2026-02-12T08:00:00.000Z", destination: "local" }),
      makeEntry({ id: "d3", timestamp: "2026-02-13T08:00:00.000Z", destination: "local" }),
      makeEntry({ id: "d4", timestamp: "2026-02-14T08:00:00.000Z", destination: "local" }),
    ]);

    const stats = await getPrivacyStats();

    expect(stats.daysFullyLocal).toBe(3);
    expect(stats.currentStreak).toBe(3);
  });

  it("currentStreak resets when a cloud request appears", async () => {
    seedAudit([
      makeEntry({ id: "older", timestamp: "2026-02-13T08:00:00.000Z", destination: "local" }),
      makeEntry({ id: "today-cloud", timestamp: "2026-02-14T09:00:00.000Z", destination: "cloud" }),
    ]);

    const stats = await getPrivacyStats();

    expect(stats.currentStreak).toBe(0);
    expect(stats.daysFullyLocal).toBe(0);
  });

  it("clearPrivacyData deletes audit and stats files", async () => {
    fileState.files.set(auditPath, '{"id":"x"}\n');
    fileState.files.set(statsPath, '{"totalRequests":1}\n');

    await clearPrivacyData();

    expect(fileState.files.has(auditPath)).toBe(false);
    expect(fileState.files.has(statsPath)).toBe(false);
  });
});
