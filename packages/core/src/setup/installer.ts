import { execa } from "execa";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHardware, formatProfile, type HardwareProfile } from "./hardware-detect.js";
import { recommendModel, type ModelRecommendation } from "./model-recommend.js";

const OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;
const OLLAMA_PING_TIMEOUT_MS = 2_000;
const VERIFICATION_TIMEOUT_MS = 45_000;
const OLLAMA_START_TIMEOUT_MS = 10_000;
const OLLAMA_START_POLL_INTERVAL_MS = 500;

const FALLBACK_MODEL = "qwen3:4b";

export type InstallerPhase =
  | "detecting-hardware"
  | "checking-ollama"
  | "installing-ollama"
  | "selecting-model"
  | "pulling-model"
  | "verifying"
  | "complete"
  | "error";

export interface InstallerProgress {
  phase: InstallerPhase;
  message: string;
  percentComplete: number;
  detail?: string;
  error?: string;
}

export interface InstallerResult {
  success: boolean;
  profile: HardwareProfile;
  recommendation: ModelRecommendation;
  ollamaWasInstalled: boolean;
  modelWasAlreadyPresent: boolean;
  totalTimeMs: number;
  error?: string;
}

export interface InstallerOptions {
  skipOllamaInstall?: boolean;
  skipModelPull?: boolean;
  forceModel?: string;
  onProgress?: (progress: InstallerProgress) => void;
}

export interface ProwlConfig {
  model: string;
  ollamaUrl: string;
  installedAt: string;
  hardwareProfile: string;
  prowlVersion: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function getExecaErrorMessage(error: unknown): string {
  const data = error as {
    stderr?: string;
    stdout?: string;
    shortMessage?: string;
    message?: string;
  };

  const stderr = data.stderr?.trim();
  if (stderr) {
    return stderr;
  }

  const stdout = data.stdout?.trim();
  if (stdout) {
    return stdout;
  }

  const shortMessage = data.shortMessage?.trim();
  if (shortMessage) {
    return shortMessage;
  }

  return getErrorMessage(error);
}

function isCommandNotFound(error: unknown, command: string): boolean {
  const maybeCode = (error as { code?: string }).code;
  if (maybeCode === "ENOENT") {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes(`spawn ${command.toLowerCase()} enoent`) ||
    message.includes(`${command.toLowerCase()}: command not found`)
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function createForcedRecommendation(modelTag: string): ModelRecommendation {
  const normalized = modelTag.trim();
  const displayName = normalized.replace(/[:_-]+/g, " ").trim() || normalized;

  return {
    model: normalized,
    displayName,
    quality: "good",
    estimatedSpeed: "unknown speed",
    sizeGB: 0,
    reason: "Using a model explicitly requested by installer options.",
    source: "ollama",
    ollamaTag: normalized,
  };
}

function createFallbackRecommendation(forceModel?: string): ModelRecommendation {
  return createForcedRecommendation(forceModel?.trim() || FALLBACK_MODEL);
}

function createEmptyProfile(): HardwareProfile {
  return {
    os: "unknown",
    arch: "unknown",
    totalRAMGB: 0,
    unifiedMemoryGB: 0,
    gpuVRAMGB: 0,
    gpu: {
      vendor: "unknown",
      name: "Unknown GPU",
      vramGB: 0,
      isAppleSilicon: false,
    },
    cpuCores: 0,
    cpuModel: "unknown",
    isAppleSilicon: false,
    availableForModelGB: 0,
    ollamaInstalled: false,
    ollamaVersion: null,
    prowlDataDir: path.join(os.homedir(), ".prowl", "models"),
  };
}

function parsePullPercent(line: string): number | null {
  if (!line.toLowerCase().includes("pulling")) {
    return null;
  }
  const match = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
}

function getInstallerConfigPath(): string {
  return path.join(os.homedir(), ".prowl", "config.json");
}

function emitProgress(options: InstallerOptions | undefined, progress: InstallerProgress): void {
  if (!options?.onProgress) {
    return;
  }

  try {
    options.onProgress(progress);
  } catch {
    // Installer progress callbacks are best-effort.
  }
}

async function installViaCurlScript(): Promise<void> {
  const installerPath = "/tmp/ollama-install.sh";
  await execa("curl", ["-fsSL", "https://ollama.com/install.sh", "-o", installerPath]);
  await execa("sh", [installerPath]);
}

async function pullModelWithProgress(
  modelTag: string,
  options: InstallerOptions | undefined,
): Promise<void> {
  const pullResult = await execa("ollama", ["pull", modelTag], {
    all: true,
  });

  const output = [pullResult.all, pullResult.stdout].filter(Boolean).join("\n");
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const pullPercent = parsePullPercent(line);
    if (pullPercent === null) {
      continue;
    }

    const installerPercent = normalizePercent(50 + pullPercent * 0.4);
    emitProgress(options, {
      phase: "pulling-model",
      message: `Pulling ${modelTag}...`,
      percentComplete: installerPercent,
      detail: line.trim(),
    });
  }
}

async function readProwlVersion(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../../package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version;
      }
    } catch {
      // keep searching
    }
  }

  return "unknown";
}

function matchesInstalledModel(installedModels: string[], modelTag: string): boolean {
  return installedModels.some((name) => {
    if (name === modelTag) {
      return true;
    }
    return name.startsWith(`${modelTag}:`);
  });
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/`, {}, OLLAMA_PING_TIMEOUT_MS);
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function startOllamaService(): Promise<void> {
  const process = execa("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
  });
  process.unref?.();

  const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isOllamaRunning()) {
      return;
    }
    await sleep(OLLAMA_START_POLL_INTERVAL_MS);
  }

  throw new Error("Ollama failed to start within 10 seconds.");
}

export async function listInstalledModels(): Promise<string[]> {
  const running = await isOllamaRunning();
  if (!running) {
    return [];
  }

  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    if (!Array.isArray(data.models)) {
      return [];
    }

    return data.models
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  } catch {
    return [];
  }
}

export function readProwlConfig(): ProwlConfig | null {
  try {
    const raw = readFileSync(getInstallerConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProwlConfig>;
    if (
      typeof parsed.model !== "string" ||
      typeof parsed.ollamaUrl !== "string" ||
      typeof parsed.installedAt !== "string" ||
      typeof parsed.hardwareProfile !== "string" ||
      typeof parsed.prowlVersion !== "string"
    ) {
      return null;
    }

    return {
      model: parsed.model,
      ollamaUrl: parsed.ollamaUrl,
      installedAt: parsed.installedAt,
      hardwareProfile: parsed.hardwareProfile,
      prowlVersion: parsed.prowlVersion,
    };
  } catch {
    return null;
  }
}

export async function runInstaller(options?: InstallerOptions): Promise<InstallerResult> {
  const startedAt = Date.now();
  let profile = createEmptyProfile();
  let recommendation: ModelRecommendation = createFallbackRecommendation(options?.forceModel);
  let ollamaWasInstalled = false;
  let modelWasAlreadyPresent = false;
  let currentPhase: InstallerPhase = "detecting-hardware";

  const fail = (
    phase: InstallerPhase,
    error: string,
    message: string,
    detail?: string,
  ): InstallerResult => {
    emitProgress(options, {
      phase: "error",
      message,
      percentComplete: 100,
      detail,
      error,
    });
    return {
      success: false,
      profile,
      recommendation,
      ollamaWasInstalled,
      modelWasAlreadyPresent,
      totalTimeMs: Date.now() - startedAt,
      error,
    };
  };

  try {
    currentPhase = "detecting-hardware";
    emitProgress(options, {
      phase: currentPhase,
      message: "Detecting your hardware...",
      percentComplete: 0,
    });

    profile = await detectHardware();
    const profileSummary = formatProfile(profile);
    emitProgress(options, {
      phase: currentPhase,
      message: "Hardware detection complete.",
      percentComplete: 15,
      detail: profileSummary,
    });

    if (profile.availableForModelGB < 4) {
      return fail(
        currentPhase,
        `Only ${profile.availableForModelGB}GB is available for models. At least 4GB is required.`,
        "Your hardware does not have enough memory for local models.",
        profileSummary,
      );
    }

    currentPhase = "checking-ollama";
    emitProgress(options, {
      phase: currentPhase,
      message: "Checking Ollama installation...",
      percentComplete: 15,
    });

    if (profile.ollamaInstalled) {
      const versionText = profile.ollamaVersion ? ` ${profile.ollamaVersion}` : "";
      emitProgress(options, {
        phase: currentPhase,
        message: `Ollama${versionText} detected.`,
        percentComplete: 25,
      });

      const running = await isOllamaRunning();
      if (!running) {
        emitProgress(options, {
          phase: currentPhase,
          message: "Ollama is installed but not running. Starting service...",
          percentComplete: 25,
        });
        await startOllamaService();
      }
    } else if (options?.skipOllamaInstall) {
      emitProgress(options, {
        phase: currentPhase,
        message: "Ollama is not installed, continuing because install is skipped.",
        percentComplete: 25,
        detail: "Install Ollama manually from https://ollama.com if setup later fails.",
      });
    } else {
      currentPhase = "installing-ollama";
      emitProgress(options, {
        phase: currentPhase,
        message: "Installing Ollama...",
        percentComplete: 25,
      });

      if (profile.os === "windows") {
        return fail(
          currentPhase,
          "Please install Ollama manually from https://ollama.com",
          "Automatic Ollama install is not supported on Windows yet.",
        );
      }

      try {
        if (profile.os === "macos") {
          try {
            await execa("brew", ["install", "ollama"]);
          } catch (error) {
            if (!isCommandNotFound(error, "brew")) {
              throw error;
            }
            await installViaCurlScript();
          }
        } else if (profile.os === "linux") {
          await installViaCurlScript();
        } else {
          return fail(
            currentPhase,
            "Unsupported operating system for automatic Ollama setup.",
            "Could not automatically install Ollama on this operating system.",
          );
        }
      } catch (error) {
        return fail(
          currentPhase,
          `Failed to install Ollama: ${getExecaErrorMessage(error)}`,
          "Failed to install Ollama.",
        );
      }

      try {
        await startOllamaService();
      } catch (error) {
        return fail(
          currentPhase,
          `Ollama installed but failed to start: ${getErrorMessage(error)}`,
          "Ollama was installed but did not start correctly.",
        );
      }

      profile = await detectHardware();
      if (!profile.ollamaInstalled) {
        return fail(
          currentPhase,
          "Ollama install completed but was not detected afterward.",
          "Ollama install could not be verified.",
        );
      }

      ollamaWasInstalled = true;
      emitProgress(options, {
        phase: currentPhase,
        message: "Ollama installation complete.",
        percentComplete: 40,
        detail: profile.ollamaVersion
          ? `Detected Ollama ${profile.ollamaVersion}.`
          : "Detected Ollama installation.",
      });
    }

    currentPhase = "selecting-model";
    emitProgress(options, {
      phase: currentPhase,
      message: "Selecting a model for your hardware...",
      percentComplete: 40,
    });

    if (options?.forceModel && options.forceModel.trim().length > 0) {
      recommendation = createForcedRecommendation(options.forceModel);
    } else {
      recommendation = recommendModel(profile);
    }

    const selectedModelTag = recommendation.ollamaTag || recommendation.model;
    if (!selectedModelTag || selectedModelTag.trim().length === 0) {
      return fail(currentPhase, "No valid model tag was selected.", "Model selection failed.");
    }

    emitProgress(options, {
      phase: currentPhase,
      message: `Selected ${recommendation.displayName} — ${recommendation.reason}`,
      percentComplete: 50,
      detail: `${recommendation.sizeGB}GB · ${recommendation.estimatedSpeed} · ${recommendation.quality} quality`,
    });

    if (!options?.skipModelPull) {
      currentPhase = "pulling-model";
      emitProgress(options, {
        phase: currentPhase,
        message: `Checking if ${selectedModelTag} is already installed...`,
        percentComplete: 50,
      });

      const installedModels = await listInstalledModels();
      if (matchesInstalledModel(installedModels, selectedModelTag)) {
        modelWasAlreadyPresent = true;
        emitProgress(options, {
          phase: currentPhase,
          message: `${selectedModelTag} is already installed.`,
          percentComplete: 90,
        });
      } else {
        try {
          await pullModelWithProgress(selectedModelTag, options);
        } catch (error) {
          return fail(
            currentPhase,
            `Failed to pull model ${selectedModelTag}: ${getExecaErrorMessage(error)}`,
            "Model download failed.",
          );
        }

        emitProgress(options, {
          phase: currentPhase,
          message: `${selectedModelTag} downloaded successfully.`,
          percentComplete: 90,
        });
      }

      currentPhase = "verifying";
      emitProgress(options, {
        phase: currentPhase,
        message: "Verifying model response...",
        percentComplete: 90,
      });

      try {
        const response = await fetchWithTimeout(
          `${OLLAMA_BASE_URL}/api/generate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: selectedModelTag,
              prompt: "Reply with exactly: PROWL_READY",
              stream: false,
            }),
          },
          VERIFICATION_TIMEOUT_MS,
        );

        if (!response.ok) {
          emitProgress(options, {
            phase: currentPhase,
            message: "Verification warning: model may still work, but self-check failed.",
            percentComplete: 98,
            detail: `Ollama returned HTTP ${response.status}.`,
          });
        } else {
          const body = (await response.json()) as { response?: string };
          const responseText = typeof body.response === "string" ? body.response : "";
          if (/PROWL_READY/i.test(responseText)) {
            emitProgress(options, {
              phase: currentPhase,
              message: "Model verified and ready.",
              percentComplete: 98,
            });
          } else {
            emitProgress(options, {
              phase: currentPhase,
              message:
                "Verification warning: model may still work, but self-check was inconclusive.",
              percentComplete: 98,
              detail: "Expected PROWL_READY in the response.",
            });
          }
        }
      } catch (error) {
        emitProgress(options, {
          phase: currentPhase,
          message:
            "Verification warning: model may still work, but self-check timed out or failed.",
          percentComplete: 98,
          detail: getErrorMessage(error),
        });
      }
    }

    currentPhase = "complete";
    const finalProfileSummary = formatProfile(profile);
    const configPath = getInstallerConfigPath();
    const configDir = path.dirname(configPath);
    const prowlVersion = await readProwlVersion();
    const finalModelTag = recommendation.ollamaTag || recommendation.model;
    const config: ProwlConfig = {
      model: finalModelTag,
      ollamaUrl: OLLAMA_BASE_URL,
      installedAt: new Date().toISOString(),
      hardwareProfile: finalProfileSummary,
      prowlVersion,
    };

    try {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } catch (error) {
      return fail(
        currentPhase,
        `Failed to write installer config: ${getErrorMessage(error)}`,
        "Setup completed but saving config failed.",
      );
    }

    emitProgress(options, {
      phase: currentPhase,
      message: `Prowl is ready! Using ${recommendation.displayName} on ${finalProfileSummary}`,
      percentComplete: 100,
    });

    return {
      success: true,
      profile,
      recommendation,
      ollamaWasInstalled,
      modelWasAlreadyPresent,
      totalTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    return fail(
      currentPhase,
      `Installer failed: ${getErrorMessage(error)}`,
      "Setup failed unexpectedly.",
    );
  }
}
