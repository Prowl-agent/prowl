import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress, HFGGUFFile } from "./hf-bridge.js";
import {
  benchmarkModel,
  downloadModel,
  installFromHuggingFace,
  registerWithOllama,
  searchHuggingFace,
  selectBestQuant,
} from "./hf-bridge.js";

const encoder = new TextEncoder();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function ndjsonResponse(lines: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "application/x-ndjson",
    },
  });
}

function binaryResponse(chunks: Uint8Array[], contentLength: number, delayMs = 0): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Length": String(contentLength),
      "Content-Type": "application/octet-stream",
    },
  });
}

let tempHome = "";

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "hf-bridge-"));
  vi.spyOn(os, "homedir").mockReturnValue(tempHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempHome) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

describe("searchHuggingFace", () => {
  it("returns parsed GGUF model results", async () => {
    const repoId = "bartowski/Qwen3-8B-GGUF";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://huggingface.co/api/models?")) {
        return jsonResponse([
          {
            id: repoId,
            downloads: 1500,
            likes: 320,
            lastModified: "2026-02-13T12:00:00.000Z",
          },
        ]);
      }
      if (url === `https://huggingface.co/api/models/${encodeURIComponent(repoId)}`) {
        return jsonResponse({
          id: repoId,
          downloads: 1600,
          likes: 400,
          lastModified: "2026-02-14T08:00:00.000Z",
          siblings: [
            { rfilename: "Qwen3-8B-Q4_K_M.gguf", size: 5 * 1024 ** 3 },
            { rfilename: "Qwen3-8B-Q8_0.gguf", size: 9 * 1024 ** 3 },
            { rfilename: "README.md", size: 42 },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const results = await searchHuggingFace("qwen3", { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      repoId,
      modelName: "Qwen3 8B",
      downloads: 1600,
      likes: 400,
      lastModified: "2026-02-14T08:00:00.000Z",
    });
    expect(results[0].files).toHaveLength(2);
    expect(results[0].files[0]).toMatchObject({
      filename: "Qwen3-8B-Q4_K_M.gguf",
      quantization: "Q4_K_M",
    });

    const searchHeaders = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(searchHeaders.get("User-Agent")).toBe("Prowl/1.0");
  });
});

describe("selectBestQuant", () => {
  const files: HFGGUFFile[] = [
    {
      filename: "model-Q8_0.gguf",
      sizeBytes: 9 * 1024 ** 3,
      quantization: "Q8_0",
      downloadUrl: "https://example.com/Q8_0.gguf",
    },
    {
      filename: "model-Q6_K.gguf",
      sizeBytes: 7 * 1024 ** 3,
      quantization: "Q6_K",
      downloadUrl: "https://example.com/Q6_K.gguf",
    },
    {
      filename: "model-Q5_K_M.gguf",
      sizeBytes: 6 * 1024 ** 3,
      quantization: "Q5_K_M",
      downloadUrl: "https://example.com/Q5_K_M.gguf",
    },
    {
      filename: "model-Q4_K_M.gguf",
      sizeBytes: 5 * 1024 ** 3,
      quantization: "Q4_K_M",
      downloadUrl: "https://example.com/Q4_K_M.gguf",
    },
  ];

  it("picks the highest scoring quantization that fits available RAM", () => {
    expect(selectBestQuant(files, 10).quantization).toBe("Q6_K");
    expect(selectBestQuant(files, 8).quantization).toBe("Q5_K_M");
  });

  it("throws when no file fits in memory", () => {
    expect(() => selectBestQuant(files, 3)).toThrowError(/Minimum RAM needed/i);
  });
});

describe("downloadModel", () => {
  it("downloads with progress updates", async () => {
    const file: HFGGUFFile = {
      filename: "Qwen3-8B-Q4_K_M.gguf",
      sizeBytes: 12,
      quantization: "Q4_K_M",
      downloadUrl: "https://huggingface.co/repo/model.gguf",
    };
    const fetchMock = vi.fn(async () =>
      binaryResponse(
        [
          new Uint8Array([1, 2, 3, 4]),
          new Uint8Array([5, 6, 7, 8]),
          new Uint8Array([9, 10, 11, 12]),
        ],
        12,
        120,
      ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const progressEvents: DownloadProgress[] = [];
    const modelPath = await downloadModel(file, "bartowski/Qwen3-8B-GGUF", (progress) => {
      progressEvents.push(progress);
    });

    const stats = await fs.stat(modelPath);
    expect(stats.size).toBe(12);
    expect(progressEvents.some((event) => event.phase === "fetching-metadata")).toBe(true);
    expect(progressEvents.some((event) => event.phase === "downloading")).toBe(true);

    const lastDownloadProgress = progressEvents
      .filter((event) => event.phase === "downloading")
      .at(-1);
    expect(lastDownloadProgress?.percentComplete).toBe(100);
  });
});

describe("registerWithOllama", () => {
  it("generates the expected Ollama tag and writes a Modelfile", async () => {
    const modelPath = path.join(tempHome, "models", "Qwen3-8B-Q4_K_M.gguf");
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, "dummy");

    const fetchMock = vi.fn(async () =>
      ndjsonResponse(['{"status":"pulling layers"}\n', '{"status":"success"}\n']),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const tag = await registerWithOllama(modelPath, "bartowski/Qwen3-8B-GGUF");

    expect(tag).toBe("hf-qwen3-8b-q4km");

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      name: string;
      modelfile: string;
    };
    expect(body.name).toBe("hf-qwen3-8b-q4km");
    expect(body.modelfile).toContain(`FROM ${path.resolve(modelPath)}`);

    const modelfilePath = path.join(
      tempHome,
      ".prowl",
      "models",
      "modelfiles",
      "hf-qwen3-8b-q4km.Modelfile",
    );
    const modelfileContent = await fs.readFile(modelfilePath, "utf8");
    expect(modelfileContent).toContain(`FROM ${path.resolve(modelPath)}`);
  });
});

describe("benchmarkModel", () => {
  it("passes when PROWL_OK is returned", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        '{"response":"PROWL_","done":false}\n',
        '{"response":"OK","done":false}\n',
        '{"done":true,"eval_count":2}\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await benchmarkModel("hf-qwen3-8b-q4km");
    expect(result.passed).toBe(true);
    expect(result.tokensPerSecond).toBeGreaterThan(0);
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("fails when PROWL_OK is not returned", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse(['{"response":"hello","done":false}\n', '{"done":true,"eval_count":1}\n']),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await benchmarkModel("hf-qwen3-8b-q4km");
    expect(result.passed).toBe(false);
  });
});

describe("installFromHuggingFace", () => {
  it("completes the happy path end-to-end", async () => {
    const repoId = "bartowski/Qwen3-8B-GGUF";
    const encodedRepoId = encodeURIComponent(repoId);
    const filename = "Qwen3-8B-Q4_K_M.gguf";
    const downloadUrl = `https://huggingface.co/${repoId}/resolve/main/${filename}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `https://huggingface.co/api/models/${encodedRepoId}`) {
        return jsonResponse({
          id: repoId,
          downloads: 3000,
          likes: 500,
          lastModified: "2026-02-14T00:00:00.000Z",
          siblings: [{ rfilename: filename, size: 12 }],
        });
      }
      if (url === downloadUrl) {
        return binaryResponse(
          [
            new Uint8Array([1, 2, 3, 4]),
            new Uint8Array([5, 6, 7, 8]),
            new Uint8Array([9, 10, 11, 12]),
          ],
          12,
        );
      }
      if (url === "http://localhost:11434/api/create") {
        return ndjsonResponse(['{"status":"creating"}\n', '{"status":"success"}\n']);
      }
      if (url === "http://localhost:11434/api/generate") {
        return ndjsonResponse([
          '{"response":"PROWL_OK","done":false}\n',
          '{"done":true,"eval_count":2}\n',
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const progressEvents: DownloadProgress[] = [];
    const result = await installFromHuggingFace(repoId, 16, (progress) => {
      progressEvents.push(progress);
    });

    expect(result.success).toBe(true);
    expect(result.ollamaModelName).toBe("hf-qwen3-8b-q4km");
    expect(result.modelPath).toContain(".prowl/models");
    expect(result.benchmarkResult?.passed).toBe(true);
    expect(progressEvents.some((event) => event.phase === "complete")).toBe(true);
  });

  it("returns a failure result when Ollama is not running", async () => {
    const repoId = "bartowski/Qwen3-8B-GGUF";
    const encodedRepoId = encodeURIComponent(repoId);
    const filename = "Qwen3-8B-Q4_K_M.gguf";
    const downloadUrl = `https://huggingface.co/${repoId}/resolve/main/${filename}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `https://huggingface.co/api/models/${encodedRepoId}`) {
        return jsonResponse({
          id: repoId,
          downloads: 3000,
          likes: 500,
          lastModified: "2026-02-14T00:00:00.000Z",
          siblings: [{ rfilename: filename, size: 8 }],
        });
      }
      if (url === downloadUrl) {
        return binaryResponse([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])], 8);
      }
      if (url === "http://localhost:11434/api/create") {
        throw new TypeError("fetch failed");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const progressEvents: DownloadProgress[] = [];
    const result = await installFromHuggingFace(repoId, 16, (progress) => {
      progressEvents.push(progress);
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("OLLAMA_NOT_RUNNING");
    expect(progressEvents.some((event) => event.phase === "error")).toBe(true);
  });
});
