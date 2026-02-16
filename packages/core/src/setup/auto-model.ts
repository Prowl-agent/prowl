/**
 * Auto Model Selection
 *
 * Resolves the best Ollama model for the current hardware.
 *
 * - `resolveAutoModelSync()` — synchronous fast-path: reads ~/.prowl/config.json.
 *   Falls back to "qwen3:8b" if no config exists. Safe for use in the boot shim.
 *
 * - `resolveAutoModel()` — async full-path: detects hardware, recommends a model,
 *   ensures Ollama is running, pulls the model if needed, and saves config.json.
 *   Used on first run or when explicitly invoked via `prowl setup --auto-model`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectHardware, formatProfile, type HardwareProfile } from "./hardware-detect.js";
import {
  isOllamaRunning,
  listInstalledModels,
  readProwlConfig,
  startOllamaService,
  type ProwlConfig,
} from "./installer.js";
import { recommendModel, type ModelRecommendation } from "./model-recommend.js";

const DEFAULT_FALLBACK_MODEL = "qwen3:8b";
const DEFAULT_PROVIDER = "ollama";
const PULL_TIMEOUT_MS = 0; // Unlimited — model downloads can be large.
const COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

export interface AutoModelResult {
  provider: string;
  model: string;
  recommendation: ModelRecommendation | null;
  profile: HardwareProfile | null;
  source: "config" | "auto-detected";
  modelPulled: boolean;
}

export interface AutoModelOptions {
  /** If set, skip the pull step (useful for dry-run / testing). */
  skipPull?: boolean;
  /** Progress callback for long-running operations. */
  onProgress?: (message: string) => void;
}

/**
 * Synchronous fast-path: reads saved config from ~/.prowl/config.json.
 * Returns the saved model or falls back to the default.
 *
 * This is safe to call from the boot shim (synchronous context).
 */
export function resolveAutoModelSync(): { provider: string; model: string } {
  const config = readProwlConfig();
  if (config?.model) {
    return { provider: DEFAULT_PROVIDER, model: config.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_FALLBACK_MODEL };
}

/**
 * Full async auto-detection flow:
 * 1. Check for saved config (fast return if exists)
 * 2. Detect hardware
 * 3. Recommend best model
 * 4. Ensure Ollama is running
 * 5. Pull model if not already installed
 * 6. Save config for next startup
 */
export async function resolveAutoModel(options?: AutoModelOptions): Promise<AutoModelResult> {
  const log = options?.onProgress ?? (() => {});

  // Fast path: config already exists from a previous run.
  const existing = readProwlConfig();
  if (existing?.model) {
    log(`Using previously configured model: ${existing.model}`);
    return {
      provider: DEFAULT_PROVIDER,
      model: existing.model,
      recommendation: null,
      profile: null,
      source: "config",
      modelPulled: false,
    };
  }

  // Full detection path.
  log("Detecting hardware...");
  const profile = await detectHardware();
  const profileSummary = formatProfile(profile);
  log(`Hardware: ${profileSummary}`);

  if (profile.availableForModelGB < 4) {
    log(
      `Only ${profile.availableForModelGB}GB available for models. Using fallback: ${DEFAULT_FALLBACK_MODEL}`,
    );
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_FALLBACK_MODEL,
      recommendation: null,
      profile,
      source: "auto-detected",
      modelPulled: false,
    };
  }

  let recommendation: ModelRecommendation;
  try {
    recommendation = recommendModel(profile);
  } catch {
    log(`Model recommendation failed. Using fallback: ${DEFAULT_FALLBACK_MODEL}`);
    return {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_FALLBACK_MODEL,
      recommendation: null,
      profile,
      source: "auto-detected",
      modelPulled: false,
    };
  }

  const modelTag = recommendation.ollamaTag || recommendation.model;
  log(
    `Recommended: ${recommendation.displayName} (${recommendation.quality} quality, ~${recommendation.estimatedSpeed})`,
  );

  let modelPulled = false;

  if (!options?.skipPull) {
    // Ensure Ollama is running.
    const running = await isOllamaRunning();
    if (!running && profile.ollamaInstalled) {
      log("Starting Ollama service...");
      try {
        await startOllamaService();
      } catch {
        log("Could not start Ollama. Model will be pulled on next startup.");
        return {
          provider: DEFAULT_PROVIDER,
          model: modelTag,
          recommendation,
          profile,
          source: "auto-detected",
          modelPulled: false,
        };
      }
    } else if (!running) {
      log("Ollama is not installed. Install it from https://ollama.com");
      return {
        provider: DEFAULT_PROVIDER,
        model: modelTag,
        recommendation,
        profile,
        source: "auto-detected",
        modelPulled: false,
      };
    }

    // Check if model is already installed.
    const installed = await listInstalledModels();
    const alreadyInstalled = installed.some(
      (name) => name === modelTag || name.startsWith(`${modelTag}:`),
    );

    if (alreadyInstalled) {
      log(`${modelTag} is already installed.`);
    } else {
      log(`Pulling ${modelTag}... This may take a few minutes.`);
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        await execFileAsync("ollama", ["pull", modelTag], {
          timeout: PULL_TIMEOUT_MS,
          maxBuffer: COMMAND_MAX_BUFFER,
        });
        modelPulled = true;
        log(`${modelTag} downloaded successfully.`);
      } catch {
        log(`Failed to pull ${modelTag}. It will be pulled on next startup.`);
      }
    }
  }

  // Save config for future fast-path resolution.
  await saveAutoModelConfig(modelTag, profileSummary);
  log(`Saved model selection to ~/.prowl/config.json`);

  return {
    provider: DEFAULT_PROVIDER,
    model: modelTag,
    recommendation,
    profile,
    source: "auto-detected",
    modelPulled,
  };
}

async function saveAutoModelConfig(model: string, hardwareProfile: string): Promise<void> {
  const configPath = path.join(os.homedir(), ".prowl", "config.json");
  const configDir = path.dirname(configPath);

  let version = "unknown";
  try {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string") {
      version = parsed.version;
    }
  } catch {
    // version remains "unknown"
  }

  const config: ProwlConfig = {
    model,
    ollamaUrl: "http://localhost:11434",
    installedAt: new Date().toISOString(),
    hardwareProfile,
    prowlVersion: version,
  };

  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort save — startup will still work, just won't cache the selection.
  }
}
