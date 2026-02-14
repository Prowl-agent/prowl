import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import {
  detectHardware,
  formatProfile,
  getAvailableRAM,
  type HardwareProfile,
} from "./hardware-detect.js";

type ExecFileMockResult = { stdout: string; stderr: string };
type ExecFileMockCallback = (
  error: Error | null,
  stdout: ExecFileMockResult | string,
  stderr: string,
) => void;

function resolveExecFileCallback(
  argsOrCallback: string[] | ExecFileMockCallback | undefined,
  optionsOrCallback: unknown,
  maybeCallback: unknown,
): ExecFileMockCallback {
  if (typeof argsOrCallback === "function") {
    return argsOrCallback;
  }
  if (typeof optionsOrCallback === "function") {
    return optionsOrCallback as ExecFileMockCallback;
  }
  if (typeof maybeCallback === "function") {
    return maybeCallback as ExecFileMockCallback;
  }
  throw new Error("missing execFile callback");
}

function cpuInfo(model: string): os.CpuInfo {
  return {
    model,
    speed: 0,
    times: {
      user: 0,
      nice: 0,
      sys: 0,
      idle: 0,
      irq: 0,
    },
  };
}

function mockPlatform(platform: NodeJS.Platform, arch: string): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.spyOn(process, "arch", "get").mockReturnValue(arch);
}

function mockCommands(outputs: Record<string, string | Error>): void {
  vi.mocked(execFile).mockImplementation(((
    command,
    argsOrCallback,
    optionsOrCallback,
    maybeCallback,
  ) => {
    const args = Array.isArray(argsOrCallback) ? argsOrCallback : [];
    const callback = resolveExecFileCallback(argsOrCallback, optionsOrCallback, maybeCallback);
    const key = [command, ...args].join(" ");
    const output = outputs[key];

    if (output === undefined) {
      callback(new Error(`unexpected command: ${key}`), "", "");
      return undefined as never;
    }

    if (output instanceof Error) {
      callback(output, "", "");
      return undefined as never;
    }

    callback(null, { stdout: output, stderr: "" }, "");
    return undefined as never;
  }) as typeof execFile);
}

describe("detectHardware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    vi.spyOn(os, "cpus").mockReturnValue(new Array(8).fill(cpuInfo("Fallback CPU")));
    delete process.env.APPDATA;
    vi.mocked(execFile).mockReset();
  });

  it("detects Apple Silicon on macOS via system_profiler", async () => {
    mockPlatform("darwin", "arm64");
    vi.spyOn(os, "cpus").mockReturnValue(new Array(12).fill(cpuInfo("Fallback CPU")));

    mockCommands({
      "system_profiler SPHardwareDataType -json": JSON.stringify({
        SPHardwareDataType: [{ chip_type: "Apple M4 Pro", physical_memory: "24 GB" }],
      }),
      "ollama --version": "ollama version is 0.9.1",
    });

    const profile = await detectHardware();

    expect(profile).toMatchObject({
      os: "macos",
      arch: "arm64",
      totalRAMGB: 24,
      unifiedMemoryGB: 24,
      gpuVRAMGB: 0,
      cpuCores: 12,
      cpuModel: "Apple M4 Pro",
      isAppleSilicon: true,
      availableForModelGB: 18,
      ollamaInstalled: true,
      ollamaVersion: "0.9.1",
      prowlDataDir: "/home/tester/.prowl/models",
    });
    expect(profile.gpu).toEqual({
      vendor: "apple",
      name: "Apple M4 Pro",
      vramGB: 0,
      isAppleSilicon: true,
    });

    expect(formatProfile(profile)).toBe(
      "Apple M4 Pro · 24GB unified · arm64 · macOS · Ollama 0.9.1",
    );
    expect(getAvailableRAM(profile)).toBe(18);
  });

  it("detects Linux with NVIDIA GPU and uses VRAM for available model memory", async () => {
    mockPlatform("linux", "x64");
    vi.spyOn(os, "cpus").mockReturnValue(new Array(16).fill(cpuInfo("Fallback CPU")));

    mockCommands({
      "cat /proc/meminfo": "MemTotal:       67108864 kB",
      "cat /proc/cpuinfo": "model name\t: AMD Ryzen 9 9950X",
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits":
        "NVIDIA RTX 4080, 16384",
      "ollama --version": new Error("not installed"),
    });

    const profile = await detectHardware();

    expect(profile).toMatchObject({
      os: "linux",
      arch: "x64",
      totalRAMGB: 64,
      unifiedMemoryGB: 0,
      gpuVRAMGB: 16,
      cpuModel: "AMD Ryzen 9 9950X",
      cpuCores: 16,
      isAppleSilicon: false,
      availableForModelGB: 16,
      ollamaInstalled: false,
      ollamaVersion: null,
    });
    expect(profile.gpu).toEqual({
      vendor: "nvidia",
      name: "NVIDIA RTX 4080",
      vramGB: 16,
      isAppleSilicon: false,
    });

    expect(formatProfile(profile)).toBe(
      "NVIDIA RTX 4080 · 16GB VRAM · 64GB RAM · x64 · Linux · Ollama not installed",
    );
  });

  it("detects Linux CPU-only machines when GPU tools are missing", async () => {
    mockPlatform("linux", "x64");

    mockCommands({
      "cat /proc/meminfo": "MemTotal:       16777216 kB",
      "cat /proc/cpuinfo": "model name\t: Intel(R) Xeon(R)",
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits": new Error(
        "nvidia-smi not found",
      ),
      "rocm-smi --showmeminfo vram": new Error("rocm-smi not found"),
      "ollama --version": new Error("not installed"),
    });

    const profile = await detectHardware();

    expect(profile.gpu.vendor).toBe("unknown");
    expect(profile.gpu.name).toBe("Unknown GPU");
    expect(profile.gpuVRAMGB).toBe(0);
    expect(profile.totalRAMGB).toBe(16);
    expect(profile.availableForModelGB).toBe(8);
  });

  it("detects Windows RAM, CPU and GPU via wmic", async () => {
    mockPlatform("win32", "x64");
    process.env.APPDATA = "C:\\Users\\tester\\AppData\\Roaming";

    mockCommands({
      "wmic ComputerSystem get TotalPhysicalMemory": "TotalPhysicalMemory\n34359738368",
      "wmic cpu get Name": "Name\nIntel(R) Core(TM) i9-14900K",
      "wmic path win32_VideoController get Name,AdapterRAM":
        "Name                                    AdapterRAM\nNVIDIA RTX 4090                         17179869184",
      "ollama --version": "ollama version 0.9.2",
    });

    const profile = await detectHardware();

    expect(profile).toMatchObject({
      os: "windows",
      arch: "x64",
      totalRAMGB: 32,
      gpuVRAMGB: 16,
      cpuModel: "Intel(R) Core(TM) i9-14900K",
      availableForModelGB: 16,
      ollamaInstalled: true,
      ollamaVersion: "0.9.2",
      prowlDataDir: path.join("C:\\Users\\tester\\AppData\\Roaming", "Prowl", "models"),
    });
    expect(profile.gpu.vendor).toBe("nvidia");
    expect(profile.gpu.name).toBe("NVIDIA RTX 4090");
  });

  it("never throws and returns defaults when commands fail", async () => {
    mockPlatform("linux", "x64");
    vi.spyOn(os, "cpus").mockImplementation(() => {
      throw new Error("cpu unavailable");
    });

    vi.mocked(execFile).mockImplementation(((
      command,
      argsOrCallback,
      optionsOrCallback,
      maybeCallback,
    ) => {
      const callback = resolveExecFileCallback(argsOrCallback, optionsOrCallback, maybeCallback);
      callback(new Error("command failed"), "", "");
      return undefined as never;
    }) as typeof execFile);

    await expect(detectHardware()).resolves.toEqual({
      os: "linux",
      arch: "x64",
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
      prowlDataDir: "/home/tester/.prowl/models",
    } satisfies HardwareProfile);
  });
});
