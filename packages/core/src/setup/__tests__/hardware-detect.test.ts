import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { getHardwareProfile } from "../hardware-detect.js";

describe("getHardwareProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses macOS hardware profile from sysctl and system_profiler", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "freemem").mockReturnValue(16 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 ** 3);
    vi.spyOn(os, "cpus").mockReturnValue(
      new Array(8).fill({ model: "fallback-cpu", speed: 0, times: {} as never }),
    );

    vi.mocked(execSync).mockImplementation((command: unknown) => {
      const cmd = String(command);
      if (cmd === "sysctl -n hw.memsize") {
        return "68719476736";
      }
      if (cmd === "system_profiler SPHardwareDataType") {
        return "Hardware:\n    Chip: Apple M4";
      }
      if (cmd === "sysctl -n hw.ncpu") {
        return "12";
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const profile = await getHardwareProfile();

    expect(profile).toEqual({
      os: "macos",
      chip: "Apple M4",
      totalRAM: 64,
      availableRAM: 16,
      gpuName: null,
      gpuVRAM: null,
      unifiedMemory: 64,
      cpuCores: 12,
    });
  });

  it("parses linux profile and NVIDIA GPU when nvidia-smi is available", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "freemem").mockReturnValue(4 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(8 * 1024 ** 3);
    vi.spyOn(os, "cpus").mockReturnValue(
      new Array(2).fill({ model: "fallback-cpu", speed: 0, times: {} as never }),
    );

    vi.mocked(execSync).mockImplementation((command: unknown) => {
      const cmd = String(command);
      if (cmd === "cat /proc/meminfo") {
        return ["MemTotal:       33554432 kB", "MemAvailable:   16777216 kB"].join("\n");
      }
      if (cmd === "cat /proc/cpuinfo") {
        return [
          "processor\t: 0",
          "model name\t: Intel(R) Core(TM) i7-13700K",
          "processor\t: 1",
          "model name\t: Intel(R) Core(TM) i7-13700K",
        ].join("\n");
      }
      if (cmd === "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits") {
        return "16376, NVIDIA GeForce RTX 4080";
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const profile = await getHardwareProfile();

    expect(profile).toEqual({
      os: "linux",
      chip: "Intel(R) Core(TM) i7-13700K",
      totalRAM: 32,
      availableRAM: 16,
      gpuName: "NVIDIA GeForce RTX 4080",
      gpuVRAM: 15.99,
      unifiedMemory: null,
      cpuCores: 2,
    });
  });

  it("returns null GPU fields when nvidia-smi is unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "freemem").mockReturnValue(2 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
    vi.spyOn(os, "cpus").mockReturnValue(
      new Array(2).fill({ model: "fallback-cpu", speed: 0, times: {} as never }),
    );

    vi.mocked(execSync).mockImplementation((command: unknown) => {
      const cmd = String(command);
      if (cmd === "cat /proc/meminfo") {
        return "MemTotal:       4194304 kB";
      }
      if (cmd === "cat /proc/cpuinfo") {
        return "processor\t: 0\nmodel name\t: Intel CPU";
      }
      if (cmd === "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits") {
        throw new Error("nvidia-smi missing");
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const profile = await getHardwareProfile();

    expect(profile.gpuName).toBeNull();
    expect(profile.gpuVRAM).toBeNull();
    expect(profile.os).toBe("linux");
  });

  it("parses windows profile from wmic and nvidia-smi", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "freemem").mockReturnValue(8 * 1024 ** 3);
    vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 ** 3);
    vi.spyOn(os, "cpus").mockReturnValue(
      new Array(4).fill({ model: "fallback-cpu", speed: 0, times: {} as never }),
    );

    vi.mocked(execSync).mockImplementation((command: unknown) => {
      const cmd = String(command);
      if (cmd === "wmic memorychip get capacity") {
        return ["Capacity", "34359738368", "34359738368"].join("\n");
      }
      if (cmd === "wmic cpu get name") {
        return ["Name", "Intel(R) Core(TM) i9-14900K"].join("\n");
      }
      if (cmd === "wmic cpu get NumberOfCores") {
        return ["NumberOfCores", "24"].join("\n");
      }
      if (cmd === "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits") {
        return "24564, NVIDIA GeForce RTX 4090";
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const profile = await getHardwareProfile();

    expect(profile).toEqual({
      os: "windows",
      chip: "Intel(R) Core(TM) i9-14900K",
      totalRAM: 64,
      availableRAM: 8,
      gpuName: "NVIDIA GeForce RTX 4090",
      gpuVRAM: 23.99,
      unifiedMemory: null,
      cpuCores: 24,
    });
  });
});
