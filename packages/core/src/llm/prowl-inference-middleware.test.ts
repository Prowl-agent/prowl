import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProwlInferenceMiddleware,
  createProwlInferenceConfig,
  detectTaskType,
  type ProwlInferenceConfig,
} from "./prowl-inference-middleware.js";

const mockFetch = vi.fn();

function withEnvUnset<T>(keys: string[], run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("detectTaskType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "qwen3:8b", size: 5_936_648_224, size_vram: 5_936_648_224 }],
      }),
    });
  });

  it("returns 'tool' when tools are provided", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "bash", description: "Run a command", parameters: {} },
      },
    ];
    expect(detectTaskType("What is the weather?", tools)).toBe("tool");
  });

  it("returns 'code' for coding-related prompts", () => {
    expect(detectTaskType("Write a TypeScript function to sort an array")).toBe("code");
    expect(detectTaskType("debug this error: TypeError")).toBe("code");
    expect(detectTaskType("refactor the login module")).toBe("code");
  });

  it("returns 'agent' for multi-step task prompts", () => {
    expect(detectTaskType("search for all TODO comments and fix them")).toBe("agent");
    expect(detectTaskType("step by step, create a new project")).toBe("agent");
  });

  it("returns 'chat' for general conversation", () => {
    expect(detectTaskType("Hello, how are you?")).toBe("chat");
    expect(detectTaskType("What is the meaning of life?")).toBe("chat");
  });
});

describe("createProwlInferenceConfig", () => {
  it("uses provided model name", () => {
    const config = createProwlInferenceConfig("llama3:8b");
    expect(config.model).toBe("llama3:8b");
  });

  it("defaults to qwen3:8b when no model specified", () => {
    withEnvUnset(["PROWL_DEFAULT_CHAT_MODEL"], () => {
      const config = createProwlInferenceConfig();
      expect(config.model).toBe("qwen3:8b");
      expect(config.ollamaUrl).toBe("http://127.0.0.1:11434");
    });
  });

  it("enables optimizer and cost tracking by default", () => {
    withEnvUnset(["PROWL_DISABLE_OPTIMIZER", "PROWL_DISABLE_COST_TRACKING"], () => {
      const config = createProwlInferenceConfig();
      expect(config.enableOptimizer).toBe(true);
      expect(config.enableCostTracking).toBe(true);
    });
  });
});

describe("ProwlInferenceMiddleware", () => {
  const config: ProwlInferenceConfig = {
    model: "qwen3:8b",
    ollamaUrl: "http://localhost:11434",
    enableOptimizer: true,
    enableCostTracking: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: "qwen3:8b",
            size: 5_936_648_224,
            size_vram: 5_936_648_224,
            details: { family: "qwen3", parameter_size: "8B" },
          },
          {
            name: "qwen3:1.7b",
            size: 2_355_771_424,
            size_vram: 2_355_771_424,
            details: { family: "qwen3", parameter_size: "1.7B" },
          },
        ],
      }),
    });
  });

  it("returns passthrough messages when optimizer is disabled", async () => {
    const disabledConfig = { ...config, enableOptimizer: false };
    const middleware = new ProwlInferenceMiddleware(disabledConfig);
    const messages = [
      { role: "system" as const, content: "You are helpful." },
      { role: "user" as const, content: "Hello" },
    ];
    const result = await middleware.optimizeRequest("qwen3:8b", messages);
    expect(result.messages).toEqual(messages);
    expect(result.selectedModel).toBe("qwen3:1.7b");
  });

  it("optimizes messages with system prompt tuning", async () => {
    const middleware = new ProwlInferenceMiddleware(config);
    const messages = [
      {
        role: "system" as const,
        content:
          "You are a helpful AI assistant with access to many tools and resources. " +
          "You have the ability to read files, run commands, and much more.",
      },
      { role: "user" as const, content: "Hello, how are you?" },
    ];

    const result = await middleware.optimizeRequest("qwen3:8b", messages);

    // System prompt should be replaced by tier-aware template
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBeTruthy();
    // Options should have sampling params set
    expect(result.options.temperature).toBeDefined();
    expect(result.options.temperature).toBeLessThanOrEqual(1.0);
    expect(result.options.top_p).toBeDefined();
    expect(result.options.num_predict).toBeGreaterThan(0);
    expect(result.options.num_ctx).toBeGreaterThan(0);
  });

  it("detects code tasks and lowers temperature", async () => {
    const middleware = new ProwlInferenceMiddleware(config);
    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Write a TypeScript function to sort an array" },
    ];

    const result = await middleware.optimizeRequest("qwen3:8b", messages);

    expect(result.taskType).toBe("code");
    // Code tasks should have low temperature
    expect(result.options.temperature).toBeLessThanOrEqual(0.2);
  });

  it("detects tool tasks and sets precision params", async () => {
    const middleware = new ProwlInferenceMiddleware(config);
    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "What is the weather?" },
    ];
    const tools = [
      {
        type: "function" as const,
        function: { name: "weather", description: "Get weather", parameters: {} },
      },
    ];

    const result = await middleware.optimizeRequest("qwen3:8b", messages, tools);

    expect(result.taskType).toBe("tool");
    expect(result.options.temperature).toBeLessThanOrEqual(0.1);
  });

  it("preserves tool messages from original input", async () => {
    const middleware = new ProwlInferenceMiddleware(config);
    const messages = [
      { role: "system" as const, content: "You are helpful." },
      { role: "user" as const, content: "Run ls" },
      {
        role: "assistant" as const,
        content: "Running the command.",
      },
      { role: "tool" as const, content: "file1.txt\nfile2.txt", tool_name: "bash" },
      { role: "user" as const, content: "Now what?" },
    ];

    const result = await middleware.optimizeRequest("qwen3:8b", messages);

    // Tool messages should be preserved
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toBe("file1.txt\nfile2.txt");
  });

  it("tracks request count", async () => {
    const middleware = new ProwlInferenceMiddleware(config);
    expect(middleware.stats.requestCount).toBe(0);

    await middleware.optimizeRequest("qwen3:8b", [{ role: "user" as const, content: "hi" }]);
    expect(middleware.stats.requestCount).toBe(1);

    await middleware.optimizeRequest("qwen3:8b", [{ role: "user" as const, content: "hello" }]);
    expect(middleware.stats.requestCount).toBe(2);
  });

  it("reports model tier in stats", () => {
    const middleware = new ProwlInferenceMiddleware(config);
    expect(middleware.stats.model).toBe("qwen3:8b");
    expect(middleware.stats.tier).toBe("small");
  });

  it("does not throw when recording completion with cost tracking disabled", async () => {
    const disabledConfig = { ...config, enableCostTracking: false };
    const middleware = new ProwlInferenceMiddleware(disabledConfig);
    // Should silently no-op
    await expect(middleware.recordCompletion(100, 50, 1000, 50, "chat")).resolves.toBeUndefined();
  });
});
