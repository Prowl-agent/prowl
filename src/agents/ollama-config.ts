export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL_ID = "qwen3:8b";
export const OLLAMA_DEFAULT_TEMPERATURE = 0.3;
export const OLLAMA_NOT_DETECTED_MESSAGE =
  "Ollama not detected. Install it: brew install ollama (Mac) or curl https://ollama.com/install.sh | sh (Linux)";

const OLLAMA_DETECT_TIMEOUT_MS = 1200;
const OLLAMA_TEST_DETECT_ENV = "OPENCLAW_TEST_ENABLE_OLLAMA_DETECT";

/**
 * Derive the Ollama native API base URL from a configured base URL.
 *
 * Users typically configure `baseUrl` with a `/v1` suffix (e.g.
 * `http://localhost:11434/v1`) for the OpenAI-compatible endpoint.
 * The native Ollama API lives at the root (e.g. `/api/tags`), so we
 * strip the `/v1` suffix when present.
 */
export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export async function isOllamaDetected(configuredBaseUrl?: string): Promise<boolean> {
  const isTest = process.env.VITEST || process.env.NODE_ENV === "test";
  if (isTest && process.env[OLLAMA_TEST_DETECT_ENV] !== "1") {
    return false;
  }

  try {
    const apiBase = resolveOllamaApiBase(configuredBaseUrl);
    const response = await fetch(`${apiBase}/api/version`, {
      signal: AbortSignal.timeout(OLLAMA_DETECT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
