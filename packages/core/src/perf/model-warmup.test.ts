import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WarmPingService,
  buildKeepAliveParam,
  readWarmupConfig,
  startKeepAlive,
  warmModel,
} from "./model-warmup.js";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockClear();
  vi.stubGlobal("fetch", mockFetch);
  vi.useFakeTimers();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readWarmupConfig", () => {
  it("returns defaults when no env vars set", () => {
    delete process.env.PROWL_MODEL_KEEPALIVE;
    delete process.env.PROWL_WARM_ON_BOOT;
    delete process.env.PROWL_KEEPALIVE_SECONDS;

    const config = readWarmupConfig();
    expect(config.keepAlive).toBe(true);
    expect(config.warmOnBoot).toBe(true);
    expect(config.keepAliveSeconds).toBe(300);
  });

  it("respects env overrides", () => {
    process.env.PROWL_MODEL_KEEPALIVE = "false";
    process.env.PROWL_WARM_ON_BOOT = "0";
    process.env.PROWL_KEEPALIVE_SECONDS = "600";

    const config = readWarmupConfig();
    expect(config.keepAlive).toBe(false);
    expect(config.warmOnBoot).toBe(false);
    expect(config.keepAliveSeconds).toBe(600);

    delete process.env.PROWL_MODEL_KEEPALIVE;
    delete process.env.PROWL_WARM_ON_BOOT;
    delete process.env.PROWL_KEEPALIVE_SECONDS;
  });
});

describe("buildKeepAliveParam", () => {
  it("returns seconds string when enabled", () => {
    expect(buildKeepAliveParam({ keepAlive: true, warmOnBoot: true, keepAliveSeconds: 300 })).toBe(
      "300s",
    );
  });

  it("returns undefined when disabled", () => {
    expect(
      buildKeepAliveParam({ keepAlive: false, warmOnBoot: true, keepAliveSeconds: 300 }),
    ).toBeUndefined();
  });
});

describe("warmModel", () => {
  it("sends request to /api/generate and returns elapsed time", async () => {
    const elapsed = await warmModel("qwen3:8b", "http://localhost:11434");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/generate");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen3:8b");
    expect(body.keep_alive).toBe("5m");
    expect(body.options.num_predict).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("returns -1 on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));
    const elapsed = await warmModel("qwen3:8b");
    expect(elapsed).toBe(-1);
  });

  it("returns -1 on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const elapsed = await warmModel("qwen3:8b");
    expect(elapsed).toBe(-1);
  });
});

describe("startKeepAlive", () => {
  it("returns a stop function", () => {
    const stop = startKeepAlive("qwen3:8b");
    expect(typeof stop).toBe("function");
    stop();
  });

  it("sends periodic pings", async () => {
    const stop = startKeepAlive("qwen3:8b", "http://localhost:11434", 1000);

    // First ping happens after interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second ping
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops pinging after stop() is called", async () => {
    const stop = startKeepAlive("qwen3:8b", "http://localhost:11434", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledOnce();

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    // No more pings after stop
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));
    const stop = startKeepAlive("qwen3:8b", "http://localhost:11434", 1000);

    // Should not throw
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledOnce();

    stop();
  });

  it("sends keep_alive in ping body", async () => {
    const stop = startKeepAlive("qwen3:8b", "http://localhost:11434", 1000);
    await vi.advanceTimersByTimeAsync(1000);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/generate");
    const body = JSON.parse(init.body);
    expect(body.keep_alive).toBe("5m");
    expect(body.model).toBe("qwen3:8b");
    expect(body.prompt).toBe("");
    expect(body.options.num_predict).toBe(0);

    stop();
  });
});

describe("WarmPingService", () => {
  it("isRunning is false before start", () => {
    const service = new WarmPingService("qwen3:8b");
    expect(service.isRunning).toBe(false);
  });

  it("start() sets isRunning to true", () => {
    const service = new WarmPingService("qwen3:8b");
    service.start(1000);
    expect(service.isRunning).toBe(true);
    service.stop();
  });

  it("stop() sets isRunning to false", () => {
    const service = new WarmPingService("qwen3:8b");
    service.start(1000);
    service.stop();
    expect(service.isRunning).toBe(false);
  });

  it("start() triggers immediate warm-up", async () => {
    const service = new WarmPingService("qwen3:8b", "http://localhost:11434");
    service.start(60_000);

    // warmModel is called immediately (async, fires and forgets)
    // Give microtasks a chance to settle
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalled();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/generate");

    service.stop();
  });

  it("double start() is a no-op", () => {
    const service = new WarmPingService("qwen3:8b");
    service.start(1000);
    service.start(1000); // Should not create a second interval
    expect(service.isRunning).toBe(true);
    service.stop();
    expect(service.isRunning).toBe(false);
  });

  it("stop() when not running is a no-op", () => {
    const service = new WarmPingService("qwen3:8b");
    expect(() => service.stop()).not.toThrow();
  });
});
