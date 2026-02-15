export const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Normalize an OpenAI-compatible API base URL by trimming and removing trailing slashes.
 */
export function resolveOpenAiApiBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_OPENAI_API_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  try {
    new URL(normalized);
  } catch {
    throw new Error(`Invalid OpenAI base URL: ${raw}`);
  }
  return normalized;
}

function appendPath(base: URL, suffix: string): URL {
  const currentPath = base.pathname.replace(/\/+$/, "");
  base.pathname = currentPath ? `${currentPath}/${suffix}` : `/${suffix}`;
  base.search = "";
  base.hash = "";
  return base;
}

/**
 * Build the OpenAI-compatible audio speech endpoint URL.
 */
export function resolveOpenAiAudioSpeechUrl(baseUrl?: string): string {
  const url = new URL(resolveOpenAiApiBaseUrl(baseUrl));
  return appendPath(url, "audio/speech").toString();
}

/**
 * Build the OpenAI-compatible realtime WebSocket endpoint URL.
 */
export function resolveOpenAiRealtimeWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveOpenAiApiBaseUrl(baseUrl));
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(`Unsupported OpenAI base URL protocol: ${url.protocol}`);
  }

  appendPath(url, "realtime");
  url.searchParams.set("intent", "transcription");
  return url.toString();
}
