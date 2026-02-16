/**
 * Memory Guard
 *
 * Checks whether a model will fit in available RAM/VRAM without causing
 * paging or thrash. Uses the HardwareProfile from hardware-detect.ts.
 */

import type { HardwareProfile } from "../setup/hardware-detect.js";

export interface MemoryCheckResult {
  fits: boolean;
  warnings: string[];
  /** Suggested alternative model, if the requested one doesn't fit. */
  suggestion?: string;
  availableGB: number;
  requiredGB: number;
}

export interface MemoryGuardConfig {
  enabled: boolean;
  forceLoadLargeModel: boolean;
}

/** Known model sizes for quick estimation when Ollama metadata isn't available. */
const MODEL_SIZE_ESTIMATES: Record<string, number> = {
  "qwen3:4b": 2.9,
  "qwen3:8b": 4.8,
  "qwen2.5-coder:14b": 8.8,
  "qwen3:32b": 19.8,
};

/** Ordered from smallest to largest for downgrade suggestions. */
const MODEL_SIZE_ORDER = ["qwen3:4b", "qwen3:8b", "qwen2.5-coder:14b", "qwen3:32b"];

/**
 * Read memory guard config from env vars.
 */
export function readMemoryGuardConfig(): MemoryGuardConfig {
  return {
    enabled: envBool("PROWL_MEMORY_GUARD", true),
    forceLoadLargeModel: envBool("PROWL_FORCE_LOAD_LARGE_MODEL", false),
  };
}

/**
 * Estimate the RAM/VRAM required to run a model (in GB).
 * Uses known sizes when available, otherwise estimates from the tag name.
 */
export function estimateModelSize(modelTag: string): number {
  // Check known sizes first.
  const known = MODEL_SIZE_ESTIMATES[modelTag];
  if (known !== undefined) {
    return known;
  }

  // Try to extract parameter count from tag (e.g. "qwen3:14b" → 14).
  const match = modelTag.match(/(\d+(?:\.\d+)?)b/i);
  if (match) {
    const params = Number.parseFloat(match[1]);
    // Q4_K_M is roughly 0.6 GB per billion parameters.
    return Math.round(params * 0.6 * 10) / 10;
  }

  // Default: assume medium model.
  return 5;
}

/**
 * Check if a model will fit in available memory without causing thrash.
 */
export function checkModelFit(modelTag: string, profile: HardwareProfile): MemoryCheckResult {
  const availableGB = profile.availableForModelGB;
  const requiredGB = estimateModelSize(modelTag);
  const warnings: string[] = [];

  if (requiredGB <= availableGB) {
    return { fits: true, warnings, availableGB, requiredGB };
  }

  warnings.push(
    `${modelTag} requires ~${requiredGB}GB but only ${availableGB}GB is available for models.`,
  );

  // Find the largest model that fits.
  let suggestion: string | undefined;
  for (const candidate of MODEL_SIZE_ORDER) {
    const candidateSize = MODEL_SIZE_ESTIMATES[candidate];
    if (candidateSize !== undefined && candidateSize <= availableGB) {
      suggestion = candidate;
    }
  }

  if (suggestion) {
    warnings.push(`Consider using ${suggestion} (~${MODEL_SIZE_ESTIMATES[suggestion]}GB) instead.`);
  }

  return { fits: false, warnings, suggestion, availableGB, requiredGB };
}

/**
 * Log memory guard warnings. Returns true if model should proceed loading.
 */
export function enforceMemoryGuard(
  modelTag: string,
  profile: HardwareProfile,
  config: MemoryGuardConfig,
): { allow: boolean; check: MemoryCheckResult } {
  const check = checkModelFit(modelTag, profile);

  if (check.fits) {
    return { allow: true, check };
  }

  if (!config.enabled) {
    return { allow: true, check };
  }

  for (const warning of check.warnings) {
    console.warn(`[memory-guard] ${warning}`);
  }

  if (config.forceLoadLargeModel) {
    console.warn("[memory-guard] Force loading despite memory constraints.");
    return { allow: true, check };
  }

  console.warn("[memory-guard] Blocked. Set PROWL_FORCE_LOAD_LARGE_MODEL=true to override.");
  return { allow: false, check };
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}
