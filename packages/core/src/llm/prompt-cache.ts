/**
 * Prompt Cache
 *
 * Caches the system prompt + tool schemas between turns so we don't
 * rebuild 5,000–10,000 token system prompts on every request.
 * Only rebuilds when tools change or model switches.
 *
 * On small models with 8K context, repeated serialization is costly.
 * Caching means we serialize once, reuse until something changes.
 */

export interface CachedPrompt {
  systemPrompt: string;
  toolSchemas: string;
  hash: string;
  createdAt: number;
  model: string;
}

export interface PromptCacheResult {
  systemPrompt: string;
  toolSchemas: string;
  wasCached: boolean;
}

export class PromptCache {
  private cache: CachedPrompt | null = null;

  /**
   * Get cached system prompt or rebuild if stale.
   */
  getOrBuild(model: string, buildSystemPrompt: () => string, tools?: unknown[]): PromptCacheResult {
    const toolsJson = tools ? JSON.stringify(tools) : "";
    const hash = quickHash(model + toolsJson);

    if (this.cache && this.cache.hash === hash) {
      return {
        systemPrompt: this.cache.systemPrompt,
        toolSchemas: this.cache.toolSchemas,
        wasCached: true,
      };
    }

    // Rebuild
    const systemPrompt = buildSystemPrompt();
    this.cache = {
      systemPrompt,
      toolSchemas: toolsJson,
      hash,
      createdAt: Date.now(),
      model,
    };

    return { systemPrompt, toolSchemas: toolsJson, wasCached: false };
  }

  invalidate(): void {
    this.cache = null;
  }

  get current(): CachedPrompt | null {
    return this.cache;
  }
}

/**
 * Fast non-crypto hash for cache key comparison.
 * Uses djb2-like algorithm — fast and sufficient for equality checks.
 */
export function quickHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
