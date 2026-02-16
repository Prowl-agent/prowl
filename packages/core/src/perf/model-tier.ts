/**
 * Model Tier Routing
 *
 * Maps task complexity to fast (small, quick) or heavy (large, capable) models.
 * Controlled by env vars; disabled by default to preserve backward compatibility.
 */

export interface ModelTierConfig {
  /** Fast model for simple chat/tool routing (default: env or auto-detected small model). */
  chatModel: string;
  /** Heavy model for complex reasoning/code generation. */
  heavyModel: string;
  /** Whether to automatically route tasks based on complexity. */
  autoRoute: boolean;
}

/**
 * Read model tier config from env vars.
 */
export function readModelTierConfig(defaultModel: string): ModelTierConfig {
  return {
    chatModel: process.env.PROWL_DEFAULT_CHAT_MODEL?.trim() || defaultModel,
    heavyModel: process.env.PROWL_HEAVY_MODEL?.trim() || defaultModel,
    autoRoute: envBool("PROWL_AUTO_ROUTE", false),
  };
}

export type TaskComplexityLevel = "simple" | "moderate" | "complex" | "very-complex";

/**
 * Resolve which model to use based on task complexity.
 *
 * - Simple/moderate → chatModel (fast)
 * - Complex/very-complex → heavyModel (capable)
 *
 * Returns the same model for both if auto-routing is disabled or models are the same.
 */
export function resolveModelForComplexity(
  complexity: TaskComplexityLevel,
  config: ModelTierConfig,
): { model: string; tier: "fast" | "heavy"; reason: string } {
  if (!config.autoRoute || config.chatModel === config.heavyModel) {
    return {
      model: config.chatModel,
      tier: "fast",
      reason: "auto-routing disabled or same model for both tiers",
    };
  }

  const isHeavy = complexity === "complex" || complexity === "very-complex";

  if (isHeavy) {
    return {
      model: config.heavyModel,
      tier: "heavy",
      reason: `${complexity} task routed to heavy model`,
    };
  }

  return {
    model: config.chatModel,
    tier: "fast",
    reason: `${complexity} task routed to fast model`,
  };
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}
