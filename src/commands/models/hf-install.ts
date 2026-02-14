import os from "node:os";
import type { RuntimeEnv } from "../../runtime.js";
import {
  type DownloadProgress,
  installFromHuggingFace,
} from "../../../packages/core/src/models/hf-bridge.js";

type ModelsHfInstallOptions = {
  ram?: string;
  json?: boolean;
};

const BYTES_PER_MB = 1024 ** 2;

function formatMb(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function parseAvailableRamGb(raw: string | undefined): number {
  if (raw === undefined) {
    return Number((os.freemem() / 1024 ** 3).toFixed(2));
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--ram must be a positive number in GB.");
  }
  return parsed;
}

function formatProgressLine(progress: DownloadProgress): string {
  const percent = `${progress.percentComplete.toFixed(1)}%`;
  const transferred = `${formatMb(progress.bytesDownloaded)}/${formatMb(progress.totalBytes)}`;
  const speed = `${progress.speedMBps.toFixed(2)} MB/s`;
  const eta = progress.etaSeconds > 0 ? `${Math.ceil(progress.etaSeconds)}s` : "-";
  return `[hf-install] ${progress.phase} ${percent} ${transferred} ${speed} eta ${eta} ${progress.message}`;
}

function validateRepoId(repoId: string): string {
  const trimmed = repoId.trim();
  if (!trimmed) {
    throw new Error("Repository id is required.");
  }
  if (!trimmed.includes("/")) {
    throw new Error("Repository id must look like <owner>/<repo>.");
  }
  return trimmed;
}

export async function modelsHfInstallCommand(
  repoIdRaw: string,
  opts: ModelsHfInstallOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const repoId = validateRepoId(repoIdRaw);
  const availableRamGb = parseAvailableRamGb(opts.ram);

  const json = opts.json === true;
  let lastLogAt = 0;
  let lastPhase: DownloadProgress["phase"] | null = null;

  const onProgress = (progress: DownloadProgress) => {
    if (json) {
      runtime.log(JSON.stringify({ type: "progress", ...progress }));
      return;
    }

    const now = Date.now();
    const isTerminalPhase = progress.phase === "complete" || progress.phase === "error";
    const shouldLog =
      isTerminalPhase ||
      progress.phase !== lastPhase ||
      progress.phase !== "downloading" ||
      now - lastLogAt >= 1_000;

    if (!shouldLog) {
      return;
    }

    runtime.log(formatProgressLine(progress));
    lastLogAt = now;
    lastPhase = progress.phase;
  };

  if (!json) {
    runtime.log(
      `[hf-install] Installing ${repoId} using ${availableRamGb.toFixed(2)} GB available RAM...`,
    );
  }

  const result = await installFromHuggingFace(repoId, availableRamGb, onProgress);

  if (json) {
    runtime.log(JSON.stringify({ type: "result", ...result }));
  }

  if (!result.success) {
    throw new Error(result.error ?? "HuggingFace install failed.");
  }

  if (!json) {
    runtime.log(`[hf-install] Installed as ${result.ollamaModelName}`);
    runtime.log(`[hf-install] Model path: ${result.modelPath}`);
    if (result.benchmarkResult) {
      runtime.log(
        `[hf-install] Benchmark: ${result.benchmarkResult.tokensPerSecond.toFixed(2)} tok/s, first token ${result.benchmarkResult.firstTokenMs.toFixed(2)}ms, passed=${String(result.benchmarkResult.passed)}`,
      );
    }
  }
}
