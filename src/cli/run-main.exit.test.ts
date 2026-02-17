import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());
const resolveAutoModelMock = vi.hoisted(() =>
  vi.fn(async () => ({ model: "qwen3:8b", provider: "ollama" })),
);
const readWarmupConfigMock = vi.hoisted(() =>
  vi.fn(() => ({ keepAlive: false, warmOnBoot: false, keepAliveSeconds: 300 })),
);
const warmModelMock = vi.hoisted(() => vi.fn(async () => -1));
const startKeepAliveMock = vi.hoisted(() => vi.fn());

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("../infra/dotenv.js", () => ({
  loadDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

vi.mock("../../packages/core/src/setup/auto-model.js", () => ({
  resolveAutoModel: resolveAutoModelMock,
}));

vi.mock("../../packages/core/src/perf/model-warmup.js", () => ({
  readWarmupConfig: readWarmupConfigMock,
  warmModel: warmModelMock,
  startKeepAlive: startKeepAliveMock,
}));

const { runCli } = await import("./run-main.js");

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
