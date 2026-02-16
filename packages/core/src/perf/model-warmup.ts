/**
 * Model Warm-up and Keep-Alive
 *
 * Prevents cold-start latency by pre-loading the model on boot and
 * keeping it resident with periodic pings or Ollama's native keep_alive.
 */

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const WARMUP_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 5_000;

export interface WarmupConfig {
  /** Whether to keep the model alive (prevents Ollama from unloading it). */
  keepAlive: boolean;
  /** Whether to warm the model on boot. */
  warmOnBoot: boolean;
  /** How many seconds to tell Ollama to keep the model loaded after each request. */
  keepAliveSeconds: number;
}

/**
 * Read warmup config from env vars with sane defaults.
 */
export function readWarmupConfig(): WarmupConfig {
  return {
    keepAlive: envBool("PROWL_MODEL_KEEPALIVE", true),
    warmOnBoot: envBool("PROWL_WARM_ON_BOOT", true),
    keepAliveSeconds: envInt("PROWL_KEEPALIVE_SECONDS", 300),
  };
}

/**
 * Send a minimal prompt to pre-load the model into GPU/RAM.
 * Returns the load time in ms, or -1 if the warm-up failed.
 */
export async function warmModel(
  model: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
): Promise<number> {
  const startedAt = Date.now();
  const apiUrl = `${ollamaUrl.replace(/\/+$/, "")}/api/generate`;

  try {
    const response = await fetchWithTimeout(
      apiUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "hi",
          stream: false,
          keep_alive: "5m",
          options: { num_predict: 1, num_ctx: 512 },
        }),
      },
      WARMUP_TIMEOUT_MS,
    );

    if (!response.ok) {
      console.warn(`[model-warmup] Warm-up failed: HTTP ${response.status}`);
      return -1;
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[model-warmup] ${model} loaded in ${elapsed}ms`);
    return elapsed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[model-warmup] Warm-up failed: ${msg}`);
    return -1;
  }
}

/**
 * Periodic keep-alive ping. Sends a minimal request to prevent Ollama
 * from unloading the model after its default timeout.
 *
 * Returns an abort function to stop the keep-alive loop.
 */
export function startKeepAlive(
  model: string,
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
  intervalMs: number = 240_000, // 4 min (below Ollama's 5 min default)
): () => void {
  const apiUrl = `${ollamaUrl.replace(/\/+$/, "")}/api/generate`;
  let stopped = false;

  const ping = async () => {
    if (stopped) {
      return;
    }
    try {
      await fetchWithTimeout(
        apiUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: "",
            stream: false,
            keep_alive: "5m",
            options: { num_predict: 0, num_ctx: 128 },
          }),
        },
        PING_TIMEOUT_MS,
      );
    } catch {
      // Keep-alive is best-effort.
    }
  };

  const timer = setInterval(() => void ping(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Build the `keep_alive` value for an Ollama request body.
 * Returns the value as a string (e.g. "300s") or undefined if keep-alive is disabled.
 */
export function buildKeepAliveParam(config: WarmupConfig): string | undefined {
  if (!config.keepAlive) {
    return undefined;
  }
  return `${config.keepAliveSeconds}s`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
