/**
 * Prowl Router Integration
 *
 * Connects the routeTask() function to the agent message pipeline.
 * Every incoming message can pass through here to get a routing decision
 * BEFORE any LLM call is made.
 *
 * Flow:
 *   Message → routeMessage() → routeTask() → RoutingDecision
 *   → local inference (default) OR cloud API (Pro tier, future)
 */

import {
  routeTask,
  createDefaultConfig,
  type RouterConfig,
  type RoutingDecision,
  type TaskContext,
} from "./task-router.js";

// ── Singleton config ────────────────────────────────────────────────────────

let routerConfig: RouterConfig | null = null;

/**
 * Initialize the router. Call once at startup (e.g. from prowl-shim.ts).
 */
export function initRouter(localModel: string, config?: Partial<RouterConfig>): void {
  routerConfig = {
    ...createDefaultConfig(localModel),
    ...config,
  };
}

/**
 * Reset the router (for testing).
 */
export function resetRouter(): void {
  routerConfig = null;
}

// ── Task type detection ─────────────────────────────────────────────────────

const CODE_PATTERNS =
  /\b(code|function|class|debug|implement|refactor|typescript|python|javascript|compile|build)\b/;
const AGENT_PATTERNS =
  /\b(search for|find and|create (?:a )?file|run this|step by step|first do|then do|automate)\b/;
const INTERNET_PATTERNS = /\b(search|google|look up|find online|latest|current|today|news)\b/;

export function detectTaskType(prompt: string, tools?: unknown[]): TaskContext["taskType"] {
  if (tools && tools.length > 0) {
    return "tool";
  }
  const lower = prompt.toLowerCase();
  if (CODE_PATTERNS.test(lower)) {
    return "code";
  }
  if (AGENT_PATTERNS.test(lower)) {
    return "agent";
  }
  return "chat";
}

export function detectInternetNeed(prompt: string): boolean {
  return INTERNET_PATTERNS.test(prompt.toLowerCase());
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get routing decision for an incoming message.
 * Returns the decision without executing — the caller decides what to do.
 *
 * Safe to call even if the router hasn't been initialized (returns local fallback).
 */
export async function routeMessage(
  prompt: string,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>,
  tools?: unknown[],
): Promise<RoutingDecision> {
  if (!routerConfig) {
    // Router not initialized — default to local (safe fallback)
    return {
      route: "local",
      complexity: "simple",
      localModel: process.env.PROWL_DEFAULT_CHAT_MODEL || "qwen3:8b",
      reasoning: "Router not initialized, defaulting to local",
      warnings: [],
    };
  }

  const taskContext: TaskContext = {
    prompt,
    taskType: detectTaskType(prompt, tools),
    conversationHistory,
    requiresInternetAccess: detectInternetNeed(prompt),
    requiresLongContext: (conversationHistory?.length || 0) > 20,
  };

  return routeTask(taskContext, routerConfig);
}

/**
 * Check if a routing decision suggests cloud and requires user confirmation.
 */
export function needsCloudConfirmation(decision: RoutingDecision): boolean {
  return decision.route === "cloud" && routerConfig?.cloudFallbackMode === "manual";
}

/**
 * Get the current router config (for dashboard display).
 */
export function getRouterStatus(): {
  mode: string;
  localModel: string;
  cloudEnabled: boolean;
  cloudProvider?: string;
} {
  return {
    mode: routerConfig?.cloudFallbackMode || "disabled",
    localModel: routerConfig?.localModel || "qwen3:8b",
    cloudEnabled:
      routerConfig?.cloudFallbackMode !== "disabled" &&
      routerConfig?.cloudFallbackMode !== undefined,
    cloudProvider: routerConfig?.cloudProvider,
  };
}
