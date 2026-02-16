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
  env.OPENCLAW_DEFAULT_MODEL ??= "qwen3:8b";
}

// Auto-run on first import so env vars are set before any other module loads.
syncProwlEnv();
