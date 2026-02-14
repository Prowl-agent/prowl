import fs from "node:fs/promises";
import path from "node:path";

const BYTES_PER_GB = 1024 ** 3;

const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  deepseek: "DeepSeek",
};

interface StoredConfig {
  model?: unknown;
  [key: string]: unknown;
}

interface OllamaModelDetails {
  family?: unknown;
  parameter_size?: unknown;
  quantization_level?: unknown;
}

interface OllamaModelTag {
  name?: unknown;
  size?: unknown;
  modified_at?: unknown;
  details?: OllamaModelDetails;
}

interface OllamaTagsResponse {
  models?: OllamaModelTag[];
}

interface OllamaPullLine {
  status?: unknown;
  completed?: unknown;
  total?: unknown;
  error?: unknown;
}

export interface InstalledModel {
  name: string;
  displayName: string;
  sizeGB: number;
  modifiedAt: string;
  isActive: boolean;
  details: {
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
}

export interface PullProgress {
  status: "pulling" | "verifying" | "complete" | "error";
  model: string;
  bytesDownloaded: number;
  totalBytes: number;
  percentComplete: number;
  message: string;
}

export interface ModelManagerConfig {
  ollamaUrl: string;
  prowlConfigPath: string;
}

function normalizeOllamaUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function toClampedPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

async function readStoredConfig(configPath: string): Promise<StoredConfig | null> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as StoredConfig;
  } catch {
    return null;
  }
}

async function readActiveModel(configPath: string): Promise<string | null> {
  const config = await readStoredConfig(configPath);
  if (!config || typeof config.model !== "string" || config.model.trim().length === 0) {
    return null;
  }
  return config.model;
}

function titleCaseSegment(segment: string): string {
  const lowerSegment = segment.toLowerCase();
  const override = DISPLAY_NAME_OVERRIDES[lowerSegment];
  if (override) {
    return override;
  }
  if (segment.length === 0) {
    return segment;
  }
  return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`;
}

function formatModelName(name: string): string {
  return name
    .split("-")
    .map((segment) => titleCaseSegment(segment))
    .join("-");
}

function formatTagName(tag: string): string {
  if (/^\d+b$/i.test(tag)) {
    return tag.toUpperCase();
  }
  return tag
    .split("-")
    .map((segment) => titleCaseSegment(segment))
    .join("-");
}

export function parseDisplayName(modelTag: string): string {
  const trimmed = modelTag.trim();
  if (!trimmed) {
    return "";
  }

  const colonIndex = trimmed.indexOf(":");
  const name = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
  const tag = colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : "";

  const formattedName = formatModelName(name);
  const formattedTag = formatTagName(tag);

  return [formattedName, formattedTag].filter(Boolean).join(" ");
}

export async function listInstalledModels(config: ModelManagerConfig): Promise<InstalledModel[]> {
  try {
    const response = await fetch(`${normalizeOllamaUrl(config.ollamaUrl)}/api/tags`);
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const models = Array.isArray(payload.models) ? payload.models : [];
    const activeModel = await readActiveModel(config.prowlConfigPath);

    const installed = models
      .filter((model): model is Required<Pick<OllamaModelTag, "name">> & OllamaModelTag => {
        return typeof model.name === "string" && model.name.trim().length > 0;
      })
      .map((model) => {
        const modelName = model.name as string;
        const details = model.details ?? {};
        return {
          name: modelName,
          displayName: parseDisplayName(modelName),
          sizeGB: toNumber(model.size) / BYTES_PER_GB,
          modifiedAt: typeof model.modified_at === "string" ? model.modified_at : "",
          isActive: activeModel === modelName,
          details: {
            family: typeof details.family === "string" ? details.family : "",
            parameterSize: typeof details.parameter_size === "string" ? details.parameter_size : "",
            quantizationLevel:
              typeof details.quantization_level === "string" ? details.quantization_level : "",
          },
        } satisfies InstalledModel;
      });

    installed.sort((a, b) => {
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1;
      }
      return b.sizeGB - a.sizeGB;
    });

    return installed;
  } catch {
    return [];
  }
}

export async function pullModel(
  modelTag: string,
  config: ModelManagerConfig,
  onProgress: (progress: PullProgress) => void,
): Promise<void> {
  const normalizedTag = modelTag.trim();
  if (!normalizedTag) {
    throw new Error("Model tag cannot be empty");
  }

  const response = await fetch(`${normalizeOllamaUrl(config.ollamaUrl)}/api/pull`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: normalizedTag,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama pull request failed with HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Ollama pull did not return a response stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEmittedPercent = -1;
  let lastBytesDownloaded = 0;
  let lastTotalBytes = 0;

  const emitProgress = (
    status: PullProgress["status"],
    percentComplete: number,
    message: string,
    bytesDownloaded: number,
    totalBytes: number,
  ): void => {
    const roundedPercent = toClampedPercent(percentComplete);
    if (status !== "error" && Math.abs(roundedPercent - lastEmittedPercent) < 1) {
      return;
    }
    lastEmittedPercent = roundedPercent;
    onProgress({
      status,
      model: normalizedTag,
      bytesDownloaded,
      totalBytes,
      percentComplete: roundedPercent,
      message,
    });
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    let parsed: OllamaPullLine;
    try {
      parsed = JSON.parse(line) as OllamaPullLine;
    } catch {
      return;
    }

    const errorMessage = typeof parsed.error === "string" ? parsed.error : "";
    if (errorMessage) {
      emitProgress("error", lastEmittedPercent < 0 ? 0 : lastEmittedPercent, errorMessage, 0, 0);
      throw new Error(errorMessage);
    }

    const statusText = typeof parsed.status === "string" ? parsed.status : "";
    const statusLower = statusText.toLowerCase();
    const completed = toNumber(parsed.completed);
    const total = toNumber(parsed.total);

    if (completed > 0 || total > 0) {
      lastBytesDownloaded = completed;
      lastTotalBytes = total;
    }

    if (statusLower === "success") {
      const completeBytes = lastTotalBytes > 0 ? lastTotalBytes : lastBytesDownloaded;
      emitProgress("complete", 100, "Download complete", completeBytes, completeBytes);
      return;
    }

    if (statusLower.includes("verifying")) {
      emitProgress(
        "verifying",
        99,
        statusText || "Verifying model files",
        lastBytesDownloaded,
        lastTotalBytes,
      );
      return;
    }

    if (statusLower.includes("pulling manifest") || statusLower.includes("pulling")) {
      const percent =
        total > 0 ? toClampedPercent((completed / total) * 100) : Math.max(lastEmittedPercent, 0);
      emitProgress("pulling", percent, statusText || "Pulling model", completed, total);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        handleLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      handleLine(buffer);
    }
  } catch (error) {
    const message = getErrorMessage(error);
    if (/ECONNREFUSED|fetch failed|127\.0\.0\.1:11434|localhost:11434/i.test(message)) {
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

export async function deleteModel(modelTag: string, config: ModelManagerConfig): Promise<void> {
  const normalizedTag = modelTag.trim();
  const activeModel = await readActiveModel(config.prowlConfigPath);
  if (activeModel === normalizedTag) {
    throw new Error("Cannot delete the active model. Switch to another model first.");
  }

  const response = await fetch(`${normalizeOllamaUrl(config.ollamaUrl)}/api/delete`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: normalizedTag }),
  });

  if (response.status === 404) {
    throw new Error(`Model "${normalizedTag}" not found`);
  }

  if (!response.ok) {
    throw new Error(`Failed to delete model "${normalizedTag}"`);
  }
}

export async function switchActiveModel(
  modelTag: string,
  config: ModelManagerConfig,
): Promise<void> {
  const normalizedTag = modelTag.trim();
  const installedModels = await listInstalledModels(config);
  const exists = installedModels.some((model) => model.name === normalizedTag);
  if (!exists) {
    throw new Error(`Model "${normalizedTag}" is not installed`);
  }

  const existingConfig = (await readStoredConfig(config.prowlConfigPath)) ?? {};
  const nextConfig: StoredConfig = {
    ...existingConfig,
    model: normalizedTag,
  };

  await fs.mkdir(path.dirname(config.prowlConfigPath), { recursive: true });
  await fs.writeFile(config.prowlConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

export async function isModelInstalled(
  modelTag: string,
  config: ModelManagerConfig,
): Promise<boolean> {
  const normalizedTag = modelTag.trim();
  if (!normalizedTag) {
    return false;
  }
  const installed = await listInstalledModels(config);
  return installed.some((model) => model.name === normalizedTag);
}
