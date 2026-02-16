/**
 * Prowl boot shim — must be imported before any other local module in entry.ts.
 *
 * Responsibilities:
 * 1. Sync PROWL_* env vars → OPENCLAW_* so upstream code reads them.
 * 2. Default OPENCLAW_STATE_DIR to ~/.prowl when no explicit override is set.
 * 3. Set Prowl-specific defaults (provider=ollama, model=qwen3:8b).
 *
 * Re-export syncProwlEnv() so run-main.ts can re-invoke after .env loading.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROWL_PREFIX = "PROWL_";
const OPENCLAW_PREFIX = "OPENCLAW_";

/**
 * Copy every PROWL_<SUFFIX> env var to OPENCLAW_<SUFFIX> (PROWL_ wins).
 * Also back-fills PROWL_ from OPENCLAW_ for any suffix not already set.
 */
export function syncProwlEnv(env: NodeJS.ProcessEnv = process.env): void {
  const suffixes = new Set<string>();

  for (const key of Object.keys(env)) {
    if (key.startsWith(PROWL_PREFIX)) {
      suffixes.add(key.slice(PROWL_PREFIX.length));
    } else if (key.startsWith(OPENCLAW_PREFIX)) {
      suffixes.add(key.slice(OPENCLAW_PREFIX.length));
    }
  }

  for (const suffix of suffixes) {
    const prowlKey = `${PROWL_PREFIX}${suffix}`;
    const openclawKey = `${OPENCLAW_PREFIX}${suffix}`;
    const prowlVal = env[prowlKey];
    const openclawVal = env[openclawKey];

    if (prowlVal !== undefined) {
      // PROWL_ always wins → copy to OPENCLAW_
      env[openclawKey] = prowlVal;
    } else if (openclawVal !== undefined) {
      // Back-fill PROWL_ from OPENCLAW_ for consistency
      env[prowlKey] = openclawVal;
    }
  }

  // Default state dir to ~/.prowl when no explicit override is set.
  // Note: PROWL_STATE_DIR → OPENCLAW_STATE_DIR (controls data/state directory).
  // PROWL_HOME → OPENCLAW_HOME (controls home directory for path resolution).
  // These are NOT the same — use PROWL_STATE_DIR to change where Prowl stores data.
  if (!env.OPENCLAW_STATE_DIR && !env.PROWL_STATE_DIR) {
    const prowlDir = path.join(os.homedir(), ".prowl");
    env.OPENCLAW_STATE_DIR = prowlDir;
    env.PROWL_STATE_DIR = prowlDir;
  }

  // Prowl defaults: local-first with Ollama.
  env.OPENCLAW_DEFAULT_PROVIDER ??= "ollama";

  // Read saved model from ~/.prowl/config.json (written by auto-model detection).
  // Falls back to qwen3:8b if no config exists yet.
  if (!env.OPENCLAW_DEFAULT_MODEL) {
    let savedModel: string | undefined;
    try {
      const configPath = path.join(os.homedir(), ".prowl", "config.json");
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as { model?: string };
      if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
        savedModel = parsed.model;
      }
    } catch {
      // No config yet — first run or deleted config.
    }
    env.OPENCLAW_DEFAULT_MODEL = savedModel ?? "qwen3:1.7b";
  }

  // Enable model tier routing: use small model for chat, auto-escalate for complex tasks.
  // PROWL_DEFAULT_CHAT_MODEL: fast model for simple chat (default: qwen3:1.7b)
  // PROWL_HEAVY_MODEL: capable model for complex reasoning/code (default: qwen3:8b)
  // PROWL_AUTO_ROUTE: enable automatic routing (default: true)
  env.PROWL_DEFAULT_CHAT_MODEL ??= env.OPENCLAW_DEFAULT_MODEL ?? "qwen3:1.7b";
  env.PROWL_HEAVY_MODEL ??= "qwen3:8b";
  env.PROWL_AUTO_ROUTE ??= "true";
}

// Auto-run on first import so env vars are set before any other module loads.
syncProwlEnv();

// Initialize the task router after env vars are resolved.
import { initRouter } from "../packages/core/src/router/prowl-router-integration.js";

initRouter(process.env.PROWL_DEFAULT_CHAT_MODEL || "qwen3:1.7b", {
  cloudFallbackMode:
    (process.env.PROWL_CLOUD_FALLBACK as "disabled" | "manual" | "auto") || "disabled",
});
