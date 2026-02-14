import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HUGGING_FACE_BASE_URL = "https://huggingface.co";
const HUGGING_FACE_MODELS_API_URL = `${HUGGING_FACE_BASE_URL}/api/models`;
const OLLAMA_API_URL = "http://localhost:11434";
const BYTES_PER_GB = 1024 ** 3;
const PROGRESS_DEBOUNCE_MS = 250;
const SPEED_WINDOW_MS = 3_000;
const BENCHMARK_TIMEOUT_MS = 30_000;

const QUANTIZATION_REGEX = /Q\d+_K_[MS]|Q\d+_K|Q\d+_\d+/i;

const QUANTIZATION_SCORES: Record<string, number> = {
  Q8_0: 5,
  Q6_K: 4,
  Q5_K_M: 3,
  Q5_K_S: 3,
  Q4_K_M: 2,
  Q4_K_S: 2,
  Q3_K_M: 1,
  Q3_K_S: 1,
};

const DEFAULT_PROGRESS: Omit<
  DownloadProgress,
  "phase" | "message" | "bytesDownloaded" | "totalBytes" | "percentComplete"
> = {
  speedMBps: 0,
  etaSeconds: 0,
};

interface HFApiSearchEntry {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
}

interface HFApiSibling {
  rfilename?: string;
  size?: number;
  lfs?: {
    size?: number;
  };
}

interface HFApiModelDetails {
  id?: string;
  modelId?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  siblings?: HFApiSibling[];
}

interface DownloadWindowSample {
  timestamp: number;
  bytes: number;
}

export interface HFSearchResult {
  repoId: string;
  modelName: string;
  downloads: number;
  likes: number;
  lastModified: string;
  files: HFGGUFFile[];
}

export interface HFGGUFFile {
  filename: string;
  sizeBytes: number;
  quantization: string;
  downloadUrl: string;
}

export interface DownloadProgress {
  phase:
    | "fetching-metadata"
    | "downloading"
    | "registering"
    | "benchmarking"
    | "complete"
    | "error";
  bytesDownloaded: number;
  totalBytes: number;
  percentComplete: number;
  speedMBps: number;
  etaSeconds: number;
  message: string;
}

export interface InstallResult {
  success: boolean;
  ollamaModelName: string;
  modelPath: string;
  benchmarkResult?: BenchmarkResult;
  error?: string;
}

export interface BenchmarkResult {
  tokensPerSecond: number;
  firstTokenMs: number;
  passed: boolean;
}

export class HuggingFaceError extends Error {
  readonly code: string;
  readonly suggestion: string;

  constructor(message: string, code: string, suggestion: string) {
    super(message);
    this.name = "HuggingFaceError";
    this.code = code;
    this.suggestion = suggestion;
  }
}

function createHfHeaders(): Headers {
  return new Headers({
    Accept: "application/json",
    "User-Agent": "Prowl/1.0",
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function toOllamaConnectionError(error: unknown): HuggingFaceError {
  if (error instanceof HuggingFaceError) {
    return error;
  }

  const message = getErrorMessage(error);
  if (
    /ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|127\.0\.0\.1:11434|localhost:11434/i.test(
      message,
    )
  ) {
    return new HuggingFaceError(
      "Ollama is not running or is unreachable at http://localhost:11434.",
      "OLLAMA_NOT_RUNNING",
      "Start Ollama and retry.",
    );
  }

  return new HuggingFaceError(
    `Failed to contact Ollama: ${message}`,
    "OLLAMA_REQUEST_FAILED",
    "Check your Ollama installation and local network settings.",
  );
}

function parseModelName(repoId: string): string {
  const slug = repoId.split("/").at(-1) ?? repoId;
  return slug
    .replace(/[-_]?GGUF$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function sanitizeRepoId(repoId: string): string {
  return repoId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveModelsRoot(): string {
  return path.join(os.homedir(), ".prowl", "models");
}

function resolveDownloadPath(repoId: string, filename: string): string {
  const targetDir = path.join(resolveModelsRoot(), sanitizeRepoId(repoId));
  const safeFilename = path.basename(filename);
  return path.join(targetDir, safeFilename);
}

function encodeRepoFilePath(filename: string): string {
  return filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function extractQuantization(filename: string): string {
  const match = filename.match(QUANTIZATION_REGEX);
  return match ? match[0].toUpperCase() : "UNKNOWN";
}

function parseSiblingSizeBytes(sibling: HFApiSibling): number {
  if (typeof sibling.size === "number" && Number.isFinite(sibling.size) && sibling.size > 0) {
    return sibling.size;
  }
  if (
    typeof sibling.lfs?.size === "number" &&
    Number.isFinite(sibling.lfs.size) &&
    sibling.lfs.size > 0
  ) {
    return sibling.lfs.size;
  }
  return 0;
}

function toHfGgufFiles(repoId: string, siblings: HFApiSibling[] | undefined): HFGGUFFile[] {
  if (!siblings) {
    return [];
  }

  const files: HFGGUFFile[] = [];
  for (const sibling of siblings) {
    const filename = sibling.rfilename?.trim();
    if (!filename || !filename.toLowerCase().endsWith(".gguf")) {
      continue;
    }

    files.push({
      filename: path.basename(filename),
      sizeBytes: parseSiblingSizeBytes(sibling),
      quantization: extractQuantization(filename),
      downloadUrl: `${HUGGING_FACE_BASE_URL}/${repoId}/resolve/main/${encodeRepoFilePath(filename)}`,
    });
  }

  return files;
}

function toResult(
  repoId: string,
  details: HFApiModelDetails,
  fallback?: HFApiSearchEntry,
): HFSearchResult {
  return {
    repoId,
    modelName: parseModelName(repoId),
    downloads: details.downloads ?? fallback?.downloads ?? 0,
    likes: details.likes ?? fallback?.likes ?? 0,
    lastModified: details.lastModified ?? fallback?.lastModified ?? "",
    files: toHfGgufFiles(repoId, details.siblings),
  };
}

function normalizeQuantization(quantization: string): string {
  return quantization.toUpperCase().replace(/[^A-Z0-9_]/g, "");
}

function quantizationScore(quantization: string): number {
  return QUANTIZATION_SCORES[normalizeQuantization(quantization)] ?? 0;
}

function parseContentRangeTotalBytes(contentRange: string | null): number {
  if (!contentRange) {
    return 0;
  }
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    return 0;
  }
  const total = Number.parseInt(match[1], 10);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function parseTotalBytes(
  response: Response,
  fallbackTotalBytes: number,
  startOffset: number,
): number {
  const fromRange = parseContentRangeTotalBytes(response.headers.get("Content-Range"));
  if (fromRange > 0) {
    return fromRange;
  }

  const contentLengthHeader = response.headers.get("Content-Length");
  if (!contentLengthHeader) {
    return fallbackTotalBytes;
  }
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return fallbackTotalBytes;
  }

  return response.status === 206 ? contentLength + startOffset : contentLength;
}

function pruneDownloadWindow(windowSamples: DownloadWindowSample[], now: number): void {
  while (windowSamples.length > 0 && now - windowSamples[0].timestamp > SPEED_WINDOW_MS) {
    windowSamples.shift();
  }
}

function sumWindowBytes(windowSamples: DownloadWindowSample[]): number {
  let total = 0;
  for (const sample of windowSamples) {
    total += sample.bytes;
  }
  return total;
}

function buildProgressPayload(params: {
  phase: DownloadProgress["phase"];
  message: string;
  bytesDownloaded: number;
  totalBytes: number;
  speedBytesPerSecond: number;
}): DownloadProgress {
  const remainingBytes = Math.max(params.totalBytes - params.bytesDownloaded, 0);
  const percentComplete =
    params.totalBytes > 0 ? Math.min(100, (params.bytesDownloaded / params.totalBytes) * 100) : 0;
  const etaSeconds =
    params.speedBytesPerSecond > 0 ? remainingBytes / params.speedBytesPerSecond : 0;

  return {
    phase: params.phase,
    bytesDownloaded: params.bytesDownloaded,
    totalBytes: params.totalBytes,
    percentComplete,
    speedMBps: params.speedBytesPerSecond / 1024 ** 2,
    etaSeconds,
    message: params.message,
  };
}

async function readResponseTextSafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function fetchHfJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: createHfHeaders(),
    });
  } catch (error) {
    throw new HuggingFaceError(
      `Network request failed for HuggingFace API: ${url}`,
      "NETWORK_ERROR",
      `Check internet connectivity and retry. Root cause: ${getErrorMessage(error)}`,
    );
  }

  if (!response.ok) {
    const body = await readResponseTextSafe(response);
    throw new HuggingFaceError(
      `HuggingFace API request failed (${response.status}) for ${url}.`,
      "NETWORK_ERROR",
      body ? `API response: ${body.slice(0, 240)}` : "Retry in a few moments.",
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new HuggingFaceError(
      `Failed to parse HuggingFace API response from ${url}.`,
      "NETWORK_ERROR",
      `Retry request; malformed JSON received. Root cause: ${getErrorMessage(error)}`,
    );
  }
}

async function fetchRepoDetails(repoId: string): Promise<HFSearchResult> {
  const details = await fetchHfJson<HFApiModelDetails>(
    `${HUGGING_FACE_MODELS_API_URL}/${encodeURIComponent(repoId)}`,
  );
  return toResult(repoId, details);
}

function ensureValidGgufFiles(result: HFSearchResult, repoId: string): HFGGUFFile[] {
  const files = result.files.filter((file) => file.sizeBytes > 0);
  if (files.length === 0) {
    throw new HuggingFaceError(
      `No downloadable GGUF files found in ${repoId}.`,
      "NO_GGUF_FILES",
      "Choose another repository that publishes GGUF artifacts with valid file sizes.",
    );
  }
  return files;
}

async function ensureDiskSpace(targetDir: string, requiredBytes: number): Promise<void> {
  if (requiredBytes <= 0) {
    return;
  }

  let stats: Awaited<ReturnType<typeof fs.statfs>>;
  try {
    stats = await fs.statfs(targetDir);
  } catch (error) {
    throw new HuggingFaceError(
      `Unable to check free disk space for ${targetDir}.`,
      "DISK_CHECK_FAILED",
      `Verify filesystem permissions. Root cause: ${getErrorMessage(error)}`,
    );
  }

  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new HuggingFaceError(
      `Insufficient disk space. Required ${(requiredBytes / BYTES_PER_GB).toFixed(2)} GB.`,
      "INSUFFICIENT_DISK_SPACE",
      `Free at least ${(requiredBytes / BYTES_PER_GB).toFixed(2)} GB and retry.`,
    );
  }
}

function sanitizeTagPart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "model";
}

function quantizationToTagPart(quantization: string): string {
  return quantization.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildOllamaTag(modelName: string, modelPath: string): string {
  const baseName = (modelName.split("/").at(-1) ?? modelName).replace(/-gguf$/i, "");
  const baseTagPart = sanitizeTagPart(baseName);
  const quantization = extractQuantization(path.basename(modelPath));
  const quantTagPart = quantization === "UNKNOWN" ? "" : quantizationToTagPart(quantization);
  return quantTagPart ? `hf-${baseTagPart}-${quantTagPart}` : `hf-${baseTagPart}`;
}

function tryParseJsonLine(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function consumeJsonLineStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        const parsed = tryParseJsonLine(line);
        if (parsed) {
          await onLine(parsed);
        }
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine) {
      const parsed = tryParseJsonLine(finalLine);
      if (parsed) {
        await onLine(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function buildDefaultProgress(
  phase: DownloadProgress["phase"],
  message: string,
  totalBytes = 0,
): DownloadProgress {
  return {
    phase,
    message,
    bytesDownloaded: 0,
    totalBytes,
    percentComplete: 0,
    ...DEFAULT_PROGRESS,
  };
}

function approximateTokenCount(text: string): number {
  const matches = text.match(/\S+/g);
  return matches?.length ?? 0;
}

export async function searchHuggingFace(
  query: string,
  options?: { limit?: number; filterGGUF?: boolean },
): Promise<HFSearchResult[]> {
  const limit = Math.max(1, options?.limit ?? 10);
  const filterGGUF = options?.filterGGUF ?? true;

  const searchUrl = new URL(HUGGING_FACE_MODELS_API_URL);
  searchUrl.searchParams.set("search", query);
  searchUrl.searchParams.set("sort", "downloads");
  searchUrl.searchParams.set("limit", String(limit));
  if (filterGGUF) {
    searchUrl.searchParams.set("filter", "gguf");
  }

  const searchResults = await fetchHfJson<HFApiSearchEntry[]>(searchUrl.toString());
  const detailedResults = await Promise.all(
    searchResults.map(async (entry) => {
      const repoId = entry.id ?? entry.modelId;
      if (!repoId) {
        return null;
      }

      const details = await fetchHfJson<HFApiModelDetails>(
        `${HUGGING_FACE_MODELS_API_URL}/${encodeURIComponent(repoId)}`,
      );
      return toResult(repoId, details, entry);
    }),
  );

  const cleanedResults = detailedResults.filter((result): result is HFSearchResult =>
    Boolean(result),
  );
  return filterGGUF ? cleanedResults.filter((result) => result.files.length > 0) : cleanedResults;
}

export function selectBestQuant(files: HFGGUFFile[], availableRAMGB: number): HFGGUFFile {
  if (files.length === 0) {
    throw new Error("No GGUF files were provided.");
  }

  const maxUsableGB = availableRAMGB * 0.85;
  const fittingFiles = files.filter((file) => file.sizeBytes / BYTES_PER_GB <= maxUsableGB);

  if (fittingFiles.length === 0) {
    const smallestFileGB = Math.min(...files.map((file) => file.sizeBytes / BYTES_PER_GB));
    const minimumRamGB = smallestFileGB / 0.85;
    throw new Error(
      `No quantization fits ${availableRAMGB.toFixed(2)} GB RAM. Minimum RAM needed is ${minimumRamGB.toFixed(2)} GB (15% headroom included).`,
    );
  }

  return fittingFiles
    .toSorted((a, b) => {
      const scoreDiff = quantizationScore(b.quantization) - quantizationScore(a.quantization);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return b.sizeBytes - a.sizeBytes;
    })
    .at(0)!;
}

export async function downloadModel(
  file: HFGGUFFile,
  repoId: string,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const modelPath = resolveDownloadPath(repoId, file.filename);
  const modelDir = path.dirname(modelPath);
  await fs.mkdir(modelDir, { recursive: true });

  let bytesDownloaded = 0;
  let totalBytes = file.sizeBytes > 0 ? file.sizeBytes : 0;
  let lastEmitAt = 0;
  let shouldCleanupPartial = false;
  const windowSamples: DownloadWindowSample[] = [];

  const emitProgress = (phase: DownloadProgress["phase"], message: string, force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_DEBOUNCE_MS) {
      return;
    }

    pruneDownloadWindow(windowSamples, now);
    const speedBytesPerSecond = sumWindowBytes(windowSamples) / 3;
    onProgress(
      buildProgressPayload({
        phase,
        message,
        bytesDownloaded,
        totalBytes,
        speedBytesPerSecond,
      }),
    );
    lastEmitAt = now;
  };

  emitProgress("fetching-metadata", `Fetching metadata for ${file.filename}.`, true);

  try {
    const existingStats = await fs.stat(modelPath).catch(() => null);
    let existingBytes = existingStats?.isFile() ? existingStats.size : 0;

    if (existingBytes > 0 && totalBytes > 0 && existingBytes >= totalBytes) {
      bytesDownloaded = existingBytes;
      emitProgress("downloading", `Model already exists at ${modelPath}.`, true);
      return modelPath;
    }

    const headers = new Headers({
      "User-Agent": "Prowl/1.0",
    });
    if (existingBytes > 0) {
      headers.set("Range", `bytes=${existingBytes}-`);
    }

    let response: Response;
    try {
      response = await fetch(file.downloadUrl, { headers });
    } catch (error) {
      throw new HuggingFaceError(
        `Failed to download ${file.filename}: ${getErrorMessage(error)}`,
        "DOWNLOAD_FAILED",
        "Check internet connectivity and retry.",
      );
    }

    if (![200, 206, 416].includes(response.status)) {
      const body = await readResponseTextSafe(response);
      throw new HuggingFaceError(
        `Download failed for ${file.filename} (HTTP ${response.status}).`,
        "DOWNLOAD_FAILED",
        body ? `Remote error: ${body.slice(0, 240)}` : "Retry the download.",
      );
    }

    if (response.status === 416) {
      bytesDownloaded = existingBytes;
      totalBytes = Math.max(totalBytes, existingBytes);
      emitProgress("downloading", `Model already fully downloaded at ${modelPath}.`, true);
      return modelPath;
    }

    const isPartialResponse = response.status === 206;
    let startOffset = isPartialResponse ? existingBytes : 0;

    if (!isPartialResponse && existingBytes > 0) {
      await fs.rm(modelPath, { force: true });
      existingBytes = 0;
      startOffset = 0;
    }

    totalBytes = parseTotalBytes(response, totalBytes, startOffset);
    bytesDownloaded = startOffset;
    if (totalBytes > 0 && bytesDownloaded >= totalBytes) {
      emitProgress("downloading", `Model already fully downloaded at ${modelPath}.`, true);
      return modelPath;
    }

    const remainingBytes = totalBytes > 0 ? Math.max(totalBytes - bytesDownloaded, 0) : 0;
    await ensureDiskSpace(modelDir, remainingBytes);

    if (!response.body) {
      throw new HuggingFaceError(
        `Download stream for ${file.filename} was empty.`,
        "DOWNLOAD_FAILED",
        "Retry the download.",
      );
    }

    shouldCleanupPartial = true;
    const fileHandle = await fs.open(modelPath, isPartialResponse ? "a" : "w");
    try {
      emitProgress("downloading", `Downloading ${file.filename}.`, true);

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value || value.byteLength === 0) {
            continue;
          }

          await fileHandle.write(value);
          bytesDownloaded += value.byteLength;
          const now = Date.now();
          windowSamples.push({ timestamp: now, bytes: value.byteLength });
          emitProgress("downloading", `Downloading ${file.filename}.`);
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      await fileHandle.close();
    }

    shouldCleanupPartial = false;
    emitProgress("downloading", `Download complete for ${file.filename}.`, true);
    return modelPath;
  } catch (error) {
    if (shouldCleanupPartial) {
      await fs.rm(modelPath, { force: true }).catch(() => undefined);
    }

    const normalizedError =
      error instanceof HuggingFaceError
        ? error
        : new HuggingFaceError(
            `Failed to download ${file.filename}: ${getErrorMessage(error)}`,
            "DOWNLOAD_FAILED",
            "Retry the download.",
          );

    onProgress({
      phase: "error",
      bytesDownloaded,
      totalBytes,
      percentComplete: totalBytes > 0 ? (bytesDownloaded / totalBytes) * 100 : 0,
      ...DEFAULT_PROGRESS,
      message: `${normalizedError.message} (${normalizedError.code})`,
    });
    throw normalizedError;
  }
}

export async function registerWithOllama(modelPath: string, modelName: string): Promise<string> {
  const ollamaTag = buildOllamaTag(modelName, modelPath);
  const modelfileContent = [
    `FROM ${path.resolve(modelPath)}`,
    "PARAMETER num_ctx 4096",
    "PARAMETER temperature 0.7",
  ].join("\n");

  const modelfileDir = path.join(resolveModelsRoot(), "modelfiles");
  await fs.mkdir(modelfileDir, { recursive: true });
  const modelfilePath = path.join(modelfileDir, `${ollamaTag}.Modelfile`);
  await fs.writeFile(modelfilePath, `${modelfileContent}\n`, "utf8");

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_API_URL}/api/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: ollamaTag,
        modelfile: modelfileContent,
      }),
    });
  } catch (error) {
    throw toOllamaConnectionError(error);
  }

  if (!response.ok) {
    const body = await readResponseTextSafe(response);
    throw new HuggingFaceError(
      `Ollama model import failed (HTTP ${response.status}).`,
      "OLLAMA_CREATE_FAILED",
      body ? `Ollama error: ${body.slice(0, 240)}` : "Check Ollama logs and retry.",
    );
  }

  if (response.body) {
    await consumeJsonLineStream(response.body, (line) => {
      if (typeof line.error === "string" && line.error.trim().length > 0) {
        throw new HuggingFaceError(
          `Ollama model import failed: ${line.error}`,
          "OLLAMA_CREATE_FAILED",
          "Check Ollama logs and retry.",
        );
      }
    });
  }

  return ollamaTag;
}

export async function benchmarkModel(ollamaTag: string): Promise<BenchmarkResult> {
  const prompt = "Reply with exactly: PROWL_OK";
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), BENCHMARK_TIMEOUT_MS);

  const start = performance.now();
  let firstTokenMs = 0;
  let combinedResponse = "";
  let streamedTokenCount = 0;
  let evalCount = 0;

  try {
    let response: Response;
    try {
      response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ollamaTag,
          prompt,
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw toOllamaConnectionError(error);
    }

    if (!response.ok) {
      const body = await readResponseTextSafe(response);
      throw new HuggingFaceError(
        `Ollama benchmark request failed (HTTP ${response.status}).`,
        "OLLAMA_BENCHMARK_FAILED",
        body ? `Ollama error: ${body.slice(0, 240)}` : "Check Ollama logs and retry.",
      );
    }

    if (!response.body) {
      throw new HuggingFaceError(
        "Ollama benchmark returned an empty stream.",
        "OLLAMA_BENCHMARK_FAILED",
        "Ensure the model is loaded and retry.",
      );
    }

    await consumeJsonLineStream(response.body, (line) => {
      if (typeof line.error === "string" && line.error.trim().length > 0) {
        throw new HuggingFaceError(
          `Ollama benchmark failed: ${line.error}`,
          "OLLAMA_BENCHMARK_FAILED",
          "Retry with a smaller quantization or check Ollama logs.",
        );
      }

      const tokenText = typeof line.response === "string" ? line.response : "";
      if (tokenText.length > 0) {
        if (firstTokenMs === 0) {
          firstTokenMs = performance.now() - start;
        }
        combinedResponse += tokenText;
        streamedTokenCount += approximateTokenCount(tokenText);
      }

      const maybeEvalCount = line.eval_count;
      if (
        typeof maybeEvalCount === "number" &&
        Number.isFinite(maybeEvalCount) &&
        maybeEvalCount > 0
      ) {
        evalCount = maybeEvalCount;
      }
    });

    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    const finalTokenCount = evalCount > 0 ? evalCount : streamedTokenCount;

    return {
      tokensPerSecond: Number((finalTokenCount / elapsedSeconds).toFixed(2)),
      firstTokenMs: Number(firstTokenMs.toFixed(2)),
      passed: /PROWL_OK/i.test(combinedResponse),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HuggingFaceError(
        "Benchmark timed out after 30 seconds.",
        "BENCHMARK_TIMEOUT",
        "Try a smaller quantization or ensure enough system memory is available.",
      );
    }
    if (error instanceof HuggingFaceError) {
      throw error;
    }
    throw new HuggingFaceError(
      `Benchmark failed: ${getErrorMessage(error)}`,
      "BENCHMARK_FAILED",
      "Retry after confirming Ollama is responsive.",
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function installFromHuggingFace(
  repoId: string,
  availableRAMGB: number,
  onProgress: (progress: DownloadProgress) => void,
): Promise<InstallResult> {
  let selectedFile: HFGGUFFile | undefined;
  let modelPath = "";
  let ollamaModelName = "";

  try {
    onProgress(buildDefaultProgress("fetching-metadata", `Loading metadata for ${repoId}.`));

    const repoDetails = await fetchRepoDetails(repoId);
    const downloadableFiles = ensureValidGgufFiles(repoDetails, repoId);
    selectedFile = selectBestQuant(downloadableFiles, availableRAMGB);
    modelPath = resolveDownloadPath(repoId, selectedFile.filename);

    if (await fileExists(modelPath)) {
      onProgress({
        phase: "downloading",
        bytesDownloaded: selectedFile.sizeBytes,
        totalBytes: selectedFile.sizeBytes,
        percentComplete: 100,
        ...DEFAULT_PROGRESS,
        message: `Model already exists at ${modelPath}. Skipping download.`,
      });
    } else {
      modelPath = await downloadModel(selectedFile, repoId, onProgress);
    }

    onProgress(
      buildDefaultProgress(
        "registering",
        `Registering ${path.basename(modelPath)} with Ollama.`,
        selectedFile.sizeBytes,
      ),
    );
    ollamaModelName = await registerWithOllama(modelPath, repoId);

    onProgress(
      buildDefaultProgress(
        "benchmarking",
        `Benchmarking model ${ollamaModelName}.`,
        selectedFile.sizeBytes,
      ),
    );
    const benchmarkResult = await benchmarkModel(ollamaModelName);

    onProgress({
      phase: "complete",
      bytesDownloaded: selectedFile.sizeBytes,
      totalBytes: selectedFile.sizeBytes,
      percentComplete: 100,
      ...DEFAULT_PROGRESS,
      message: `Install complete: ${ollamaModelName}`,
    });

    return {
      success: true,
      ollamaModelName,
      modelPath,
      benchmarkResult,
    };
  } catch (error) {
    const normalizedError =
      error instanceof HuggingFaceError
        ? error
        : new HuggingFaceError(
            getErrorMessage(error),
            "INSTALL_FAILED",
            "Retry installation and inspect logs for details.",
          );

    onProgress({
      phase: "error",
      bytesDownloaded: 0,
      totalBytes: selectedFile?.sizeBytes ?? 0,
      percentComplete: 0,
      ...DEFAULT_PROGRESS,
      message: `${normalizedError.message} (${normalizedError.code})`,
    });

    return {
      success: false,
      ollamaModelName,
      modelPath,
      error: `${normalizedError.message} [${normalizedError.code}] ${normalizedError.suggestion}`,
    };
  }
}
