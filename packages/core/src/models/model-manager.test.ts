import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleListModels,
  handleSwitchModel,
  type ApiRequest,
  type ApiResponse,
} from "./model-manager-api.js";
import {
  deleteModel,
  isModelInstalled,
  listInstalledModels,
  parseDisplayName,
  pullModel,
  switchActiveModel,
  type ModelManagerConfig,
  type PullProgress,
} from "./model-manager.js";

const { fsReadFileMock, fsWriteFileMock, fsMkdirMock } = vi.hoisted(() => ({
  fsReadFileMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  fsMkdirMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: fsReadFileMock,
    writeFile: fsWriteFileMock,
    mkdir: fsMkdirMock,
  },
}));

const TEST_CONFIG: ModelManagerConfig = {
  ollamaUrl: "http://localhost:11434",
  prowlConfigPath: "/tmp/.prowl/config.json",
};

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function makePullStreamResponse(lines: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
    },
  });
}

function createApiResponseHarness(): {
  response: ApiResponse;
  statusCode: number;
  jsonPayload: unknown;
  sendPayload: string;
} {
  let statusCode = 200;
  let jsonPayload: unknown = null;
  let sendPayload = "";

  const response: ApiResponse = {
    json: (data: unknown) => {
      jsonPayload = data;
    },
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    send: (data: string) => {
      sendPayload = data;
    },
  };

  return {
    response,
    get statusCode() {
      return statusCode;
    },
    get jsonPayload() {
      return jsonPayload;
    },
    get sendPayload() {
      return sendPayload;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fsReadFileMock.mockReset();
  fsWriteFileMock.mockReset();
  fsMkdirMock.mockReset();
  fsReadFileMock.mockRejectedValue(new Error("ENOENT"));
  fsWriteFileMock.mockResolvedValue(undefined);
  fsMkdirMock.mockResolvedValue(undefined);
});

describe("listInstalledModels", () => {
  it("parses Ollama response into InstalledModel entries", async () => {
    const fetchMock = vi.fn(async () =>
      makeJsonResponse(200, {
        models: [
          {
            name: "qwen3:8b",
            size: 8 * 1024 ** 3,
            modified_at: "2026-02-14T10:00:00.000Z",
            details: {
              family: "qwen3",
              parameter_size: "8B",
              quantization_level: "Q4_0",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listInstalledModels(TEST_CONFIG);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      name: "qwen3:8b",
      displayName: "Qwen3 8B",
      sizeGB: 8,
      modifiedAt: "2026-02-14T10:00:00.000Z",
      isActive: false,
      details: {
        family: "qwen3",
        parameterSize: "8B",
        quantizationLevel: "Q4_0",
      },
    });
  });

  it("sets isActive from prowl config model", async () => {
    fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ model: "qwen3:8b" }));
    const fetchMock = vi.fn(async () =>
      makeJsonResponse(200, {
        models: [
          { name: "qwen3:8b", size: 8 * 1024 ** 3, modified_at: "2026-02-14T10:00:00.000Z" },
          { name: "qwen3:4b", size: 4 * 1024 ** 3, modified_at: "2026-02-14T09:00:00.000Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listInstalledModels(TEST_CONFIG);
    const active = models.find((model) => model.name === "qwen3:8b");

    expect(active?.isActive).toBe(true);
  });

  it("returns [] when Ollama is not running", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listInstalledModels(TEST_CONFIG)).resolves.toEqual([]);
  });

  it("sorts active model first before size descending", async () => {
    fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ model: "qwen3:4b" }));
    const fetchMock = vi.fn(async () =>
      makeJsonResponse(200, {
        models: [
          { name: "qwen3:8b", size: 8 * 1024 ** 3, modified_at: "2026-02-14T10:00:00.000Z" },
          { name: "qwen3:4b", size: 4 * 1024 ** 3, modified_at: "2026-02-14T09:00:00.000Z" },
          { name: "qwen3:2b", size: 2 * 1024 ** 3, modified_at: "2026-02-14T08:00:00.000Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await listInstalledModels(TEST_CONFIG);

    expect(models.map((model) => model.name)).toEqual(["qwen3:4b", "qwen3:8b", "qwen3:2b"]);
  });
});

describe("parseDisplayName", () => {
  it("handles all examples from spec", () => {
    expect(parseDisplayName("qwen3:8b")).toBe("Qwen3 8B");
    expect(parseDisplayName("qwen2.5-coder:14b")).toBe("Qwen2.5-Coder 14B");
    expect(parseDisplayName("deepseek-r1:7b")).toBe("DeepSeek-R1 7B");
    expect(parseDisplayName("llama3.2:3b")).toBe("Llama3.2 3B");
    expect(parseDisplayName("phi4:latest")).toBe("Phi4 Latest");
  });

  it("handles a model tag without a colon", () => {
    expect(parseDisplayName("nomodel")).toBe("Nomodel");
  });
});

describe("pullModel", () => {
  it("emits debounced progress updates by phase", async () => {
    const fetchMock = vi.fn(async () =>
      makePullStreamResponse([
        { status: "pulling manifest", completed: 10, total: 100 },
        { status: "pulling layer", completed: 11, total: 100 },
        { status: "verifying sha256 digest" },
        { status: "success" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: PullProgress[] = [];
    await pullModel("qwen3:8b", TEST_CONFIG, (progress) => {
      events.push(progress);
    });

    expect(events.map((event) => event.status)).toEqual([
      "pulling",
      "pulling",
      "verifying",
      "complete",
    ]);
    expect(events.map((event) => event.percentComplete)).toEqual([10, 11, 99, 100]);
  });

  it("throws when model tag is empty", async () => {
    await expect(pullModel("   ", TEST_CONFIG, () => undefined)).rejects.toThrow(
      "Model tag cannot be empty",
    );
  });

  it("throws when Ollama is not reachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pullModel("qwen3:8b", TEST_CONFIG, () => undefined)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});

describe("deleteModel", () => {
  it("throws when deleting the active model", async () => {
    fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ model: "qwen3:8b" }));

    await expect(deleteModel("qwen3:8b", TEST_CONFIG)).rejects.toThrow(
      "Cannot delete the active model. Switch to another model first.",
    );
  });

  it("throws a 404-friendly error when model does not exist", async () => {
    fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ model: "qwen3:4b" }));
    const fetchMock = vi.fn(async () => makeJsonResponse(404, { error: "not found" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteModel("qwen3:8b", TEST_CONFIG)).rejects.toThrow(
      'Model "qwen3:8b" not found',
    );
  });
});

describe("switchActiveModel", () => {
  it("updates the config model field", async () => {
    const fetchMock = vi.fn(async () =>
      makeJsonResponse(200, {
        models: [
          { name: "qwen3:8b", size: 8 * 1024 ** 3, modified_at: "2026-02-14T10:00:00.000Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fsReadFileMock.mockResolvedValue(JSON.stringify({ model: "qwen3:4b", foo: "bar" }));

    await switchActiveModel("qwen3:8b", TEST_CONFIG);

    expect(fsMkdirMock).toHaveBeenCalledWith("/tmp/.prowl", { recursive: true });
    expect(fsWriteFileMock).toHaveBeenCalledTimes(1);
    const writeCall = fsWriteFileMock.mock.calls[0];
    expect(writeCall?.[0]).toBe(TEST_CONFIG.prowlConfigPath);
    const writtenConfig = JSON.parse(String(writeCall?.[1])) as { model?: string; foo?: string };
    expect(writtenConfig.model).toBe("qwen3:8b");
    expect(writtenConfig.foo).toBe("bar");
  });

  it("throws when model is not installed", async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(200, { models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(switchActiveModel("qwen3:8b", TEST_CONFIG)).rejects.toThrow(
      'Model "qwen3:8b" is not installed',
    );
  });
});

describe("isModelInstalled", () => {
  it("returns true/false based on installed tags", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(200, { models: [{ name: "qwen3:8b" }] }))
      .mockResolvedValueOnce(makeJsonResponse(200, { models: [{ name: "qwen3:4b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(isModelInstalled("qwen3:8b", TEST_CONFIG)).resolves.toBe(true);
    await expect(isModelInstalled("qwen3:8b", TEST_CONFIG)).resolves.toBe(false);
  });
});

describe("model manager API handlers", () => {
  it("handleListModels returns { models: InstalledModel[] }", async () => {
    const fetchMock = vi.fn(async () =>
      makeJsonResponse(200, {
        models: [
          { name: "qwen3:8b", size: 8 * 1024 ** 3, modified_at: "2026-02-14T10:00:00.000Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = createApiResponseHarness();

    await handleListModels(
      { params: {}, body: {}, query: {} } as ApiRequest,
      harness.response,
      TEST_CONFIG,
    );

    expect(harness.statusCode).toBe(200);
    expect(harness.jsonPayload).toEqual({
      models: [
        {
          name: "qwen3:8b",
          displayName: "Qwen3 8B",
          sizeGB: 8,
          modifiedAt: "2026-02-14T10:00:00.000Z",
          isActive: false,
          details: {
            family: "",
            parameterSize: "",
            quantizationLevel: "",
          },
        },
      ],
    });
  });

  it("handleSwitchModel validates empty tag", async () => {
    const harness = createApiResponseHarness();

    await handleSwitchModel(
      { params: {}, body: { tag: "   " }, query: {} } as ApiRequest,
      harness.response,
      TEST_CONFIG,
    );

    expect(harness.statusCode).toBe(400);
    expect(harness.jsonPayload).toEqual({ error: "Model tag is required" });
  });
});
