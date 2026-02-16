/**
 * Prowl-local HTTP route handlers.
 *
 * Extracted from src/gateway/server-http.ts to keep the core gateway untouched.
 * Registered via api.registerHttpRoute() in the plugin register() function.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSavingsReport } from "../../../packages/core/src/analytics/cost-tracker.js";
import {
  deleteModel,
  listInstalledModels,
  pullModel,
  switchActiveModel,
  type ModelManagerConfig,
  type PullProgress,
} from "../../../packages/core/src/models/model-manager.js";
import {
  exportAuditCSV,
  getAuditLog,
  getPrivacyStats,
} from "../../../packages/core/src/privacy/privacy-tracker.js";
import { detectHardware, formatProfile } from "../../../packages/core/src/setup/hardware-detect.js";
import { recommendModel } from "../../../packages/core/src/setup/model-recommend.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProwlHttpConfig {
  ollamaUrl: string;
  prowlConfigPath: string;
}

const MAX_BODY_BYTES = 64 * 1024;

export function defaultProwlHttpConfig(): ProwlHttpConfig {
  return {
    ollamaUrl: "http://localhost:11434",
    prowlConfigPath: path.join(os.homedir(), ".prowl", "config.json"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        resolve({ ok: false, error: "Request body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: true, value: {} });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch {
        resolve({ ok: false, error: "Invalid JSON" });
      }
    });

    req.on("error", () => {
      resolve({ ok: false, error: "Request read error" });
    });
  });
}

function getTagFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const maybeTag = (body as { tag?: unknown }).tag;
  if (typeof maybeTag !== "string") {
    return "";
  }
  return maybeTag.trim();
}

function getTagFromPathname(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  const encodedTag = pathname.slice(prefix.length).trim();
  if (!encodedTag) {
    return "";
  }
  try {
    return decodeURIComponent(encodedTag).trim();
  } catch {
    return "";
  }
}

function isSavingsPeriod(value: string): value is "day" | "month" | "all-time" {
  return value === "day" || value === "month" || value === "all-time";
}

function getPrivacyLogLimit(rawLimit: string | null): number {
  if (!rawLimit) {
    return 10;
  }
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.min(50, Math.max(1, parsed));
}

async function isOllamaRunning(ollamaUrl: string): Promise<boolean> {
  const normalized = ollamaUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${normalized}/api/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createZeroPrivacyStats() {
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

type ConfigModelSnapshot = { model?: unknown };

type SetupRecommendationPayload = {
  model: string;
  displayName: string;
  quality: "basic" | "good" | "great" | "excellent";
  reason: string;
  sizeGB: number;
};

async function readActiveModel(configPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ConfigModelSnapshot;
    if (typeof parsed.model !== "string") {
      return "";
    }
    return parsed.model.trim();
  } catch {
    return "";
  }
}

async function resolveSetupStatus(configPath: string): Promise<{
  isFirstRun: boolean;
  hardwareProfile: string;
  recommendation: SetupRecommendationPayload;
}> {
  const [model, profile] = await Promise.all([readActiveModel(configPath), detectHardware()]);
  const hardwareProfile = formatProfile(profile);
  const isFirstRun = model.length === 0;

  try {
    const recommendation = recommendModel(profile);
    return {
      isFirstRun,
      hardwareProfile,
      recommendation: {
        model: recommendation.model,
        displayName: recommendation.displayName,
        quality: recommendation.quality,
        reason: recommendation.reason,
        sizeGB: recommendation.sizeGB,
      },
    };
  } catch (error) {
    return {
      isFirstRun,
      hardwareProfile,
      recommendation: {
        model: "qwen3:4b",
        displayName: "Qwen3 4B",
        quality: "basic",
        reason: getErrorMessage(error),
        sizeGB: 5,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Route handler factories
// ---------------------------------------------------------------------------

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export function createModelsActiveHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (_req, res) => {
    const model = await readActiveModel(cfg.prowlConfigPath);
    sendJson(res, 200, { model });
  };
}

export function createModelsInstalledHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (_req, res) => {
    const managerCfg: ModelManagerConfig = {
      ollamaUrl: cfg.ollamaUrl,
      prowlConfigPath: cfg.prowlConfigPath,
    };
    const [models, ollamaRunning] = await Promise.all([
      listInstalledModels(managerCfg),
      isOllamaRunning(cfg.ollamaUrl),
    ]);
    sendJson(res, 200, { models, ollamaRunning });
  };
}

export function createModelsSwitchHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const tag = getTagFromBody(body.value);
    if (!tag) {
      sendJson(res, 400, { error: "Model tag is required" });
      return;
    }
    const managerCfg: ModelManagerConfig = {
      ollamaUrl: cfg.ollamaUrl,
      prowlConfigPath: cfg.prowlConfigPath,
    };
    try {
      await switchActiveModel(tag, managerCfg);
      sendJson(res, 200, { success: true, activeModel: tag });
    } catch (error) {
      sendJson(res, 400, { error: getErrorMessage(error) });
    }
  };
}

export function createModelsPullHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const tag = getTagFromBody(body.value);
    if (!tag) {
      sendJson(res, 400, { error: "Model tag is required" });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    let terminalProgressSent = false;
    const writeProgress = (progress: PullProgress) => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      res.write(`${JSON.stringify(progress)}\n`);
      if (progress.status === "complete" || progress.status === "error") {
        terminalProgressSent = true;
      }
    };

    const managerCfg: ModelManagerConfig = {
      ollamaUrl: cfg.ollamaUrl,
      prowlConfigPath: cfg.prowlConfigPath,
    };

    try {
      await pullModel(tag, managerCfg, writeProgress);
      if (!terminalProgressSent) {
        writeProgress({
          status: "complete",
          model: tag,
          bytesDownloaded: 0,
          totalBytes: 0,
          percentComplete: 100,
          message: "Download complete",
        });
      }
    } catch (error) {
      if (!terminalProgressSent) {
        writeProgress({
          status: "error",
          model: tag,
          bytesDownloaded: 0,
          totalBytes: 0,
          percentComplete: 0,
          message: getErrorMessage(error),
        });
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

export function createModelsDeleteHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (req, res) => {
    if (req.method !== "DELETE") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const tag = getTagFromPathname(requestUrl.pathname, "/api/models/");
    if (!tag) {
      sendJson(res, 400, { error: "Model tag is required" });
      return;
    }
    const managerCfg: ModelManagerConfig = {
      ollamaUrl: cfg.ollamaUrl,
      prowlConfigPath: cfg.prowlConfigPath,
    };
    try {
      await deleteModel(tag, managerCfg);
      sendJson(res, 200, { success: true });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = /not found/i.test(message) ? 404 : 400;
      sendJson(res, status, { error: message });
    }
  };
}

export function createSetupStatusHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (_req, res) => {
    const status = await resolveSetupStatus(cfg.prowlConfigPath);
    sendJson(res, 200, status);
  };
}

export function createSavingsHandler(): RouteHandler {
  return async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const rawPeriod = requestUrl.searchParams.get("period") ?? "month";
    const period = isSavingsPeriod(rawPeriod) ? rawPeriod : "month";
    try {
      const report = await getSavingsReport(period);
      sendJson(res, 200, report);
    } catch {
      sendJson(res, 500, { error: "Failed to load savings data" });
    }
  };
}

export function createPrivacyStatsHandler(): RouteHandler {
  return async (_req, res) => {
    try {
      const stats = await getPrivacyStats();
      sendJson(res, 200, stats);
    } catch {
      sendJson(res, 200, createZeroPrivacyStats());
    }
  };
}

export function createPrivacyLogHandler(): RouteHandler {
  return async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const limit = getPrivacyLogLimit(requestUrl.searchParams.get("limit"));
    const entries = await getAuditLog({ limit });
    sendJson(res, 200, { entries });
  };
}

export function createPrivacyExportCsvHandler(): RouteHandler {
  return async (_req, res) => {
    let csv = "";
    try {
      csv = await exportAuditCSV();
    } catch {
      csv = "";
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="prowl-privacy-audit.csv"');
    res.end(csv);
  };
}

export function createHealthHandler(cfg: ProwlHttpConfig): RouteHandler {
  return async (_req, res) => {
    const ollamaRunning = await isOllamaRunning(cfg.ollamaUrl);
    sendJson(res, 200, { status: "ok", ollamaRunning });
  };
}
