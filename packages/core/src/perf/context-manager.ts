/**
 * Context Manager
 *
 * Controls context window usage to prevent oversized allocations that slow
 * inference. Estimates token counts, caps context size, and trims old messages.
 */

export interface ContextConfig {
  /** Maximum context tokens to allocate (num_ctx sent to Ollama). */
  maxContextTokens: number;
  /** Number of tokens at which to trigger conversation summarization. */
  summaryTriggerTokens: number;
  /** Tool schema mode: "lazy" (only eligible tools) or "full" (all tools). */
  toolSchemaMode: "lazy" | "full";
}

/**
 * Read context config from env vars with sane defaults.
 */
export function readContextConfig(): ContextConfig {
  return {
    maxContextTokens: envInt("PROWL_MAX_CONTEXT_TOKENS", 8192),
    summaryTriggerTokens: envInt("PROWL_SUMMARY_TRIGGER_TOKENS", 6144),
    toolSchemaMode: envEnum("PROWL_TOOL_SCHEMA_MODE", ["lazy", "full"], "lazy") as "lazy" | "full",
  };
}

/**
 * Rough token count estimate. Uses chars/4 heuristic — standard for English
 * text with common tokenizers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the total token count of a message array.
 */
export function estimateMessageTokens(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt?: string,
): number {
  let total = 0;

  if (systemPrompt) {
    total += estimateTokens(systemPrompt);
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && "text" in part) {
          total += estimateTokens(String(part.text));
        }
      }
    }
    // Role token overhead.
    total += 4;
  }

  return total;
}

/**
 * Compute the optimal num_ctx to send to Ollama.
 *
 * Instead of blindly sending model.contextWindow (which can be 64K+),
 * this sizes the context to actual usage with a safety margin, capped
 * at the configured max.
 */
export function computeNumCtx(
  estimatedTokens: number,
  maxOutputTokens: number,
  config: ContextConfig,
  modelContextWindow?: number,
): number {
  // Actual need = input tokens + expected output + safety margin (20%).
  const needed = Math.ceil((estimatedTokens + maxOutputTokens) * 1.2);

  // Round up to the nearest power of 2 for allocation efficiency.
  const rounded = nextPowerOf2(Math.max(needed, 2048));

  // Cap at configured max and model's actual context window.
  const hardCap = Math.min(config.maxContextTokens, modelContextWindow ?? config.maxContextTokens);

  return Math.min(rounded, hardCap);
}

/**
 * Trim conversation history to fit within a token budget.
 * Keeps the system prompt and the most recent messages.
 */
export function trimConversationToFit<T extends { role: string; content: unknown }>(
  messages: T[],
  maxTokens: number,
): T[] {
  // Always keep at least the last message.
  if (messages.length <= 1) {
    return messages;
  }

  let totalTokens = 0;
  const result: T[] = [];

  // Walk backwards from most recent.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateMessageTokensForSingle(msg);

    if (totalTokens + msgTokens > maxTokens && result.length > 0) {
      break;
    }

    totalTokens += msgTokens;
    result.unshift(msg);
  }

  return result;
}

function estimateMessageTokensForSingle(msg: { role: string; content: unknown }): number {
  let tokens = 4;
  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "object" && part !== null && "text" in part) {
        tokens += estimateTokens(String(part.text));
      }
    }
  }
  return tokens;
}

function nextPowerOf2(n: number): number {
  let v = n - 1;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function envEnum(key: string, allowed: string[], defaultValue: string): string {
  const raw = process.env[key]?.toLowerCase();
  if (raw && allowed.includes(raw)) {
    return raw;
  }
  return defaultValue;
}
