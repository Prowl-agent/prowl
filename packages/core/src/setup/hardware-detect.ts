import { execSync } from "node:child_process";
import os from "node:os";

export interface HardwareProfile {
  os: "macos" | "linux" | "windows";
  chip: string;
  totalRAM: number;
  availableRAM: number;
  gpuName: string | null;
  gpuVRAM: number | null;
  unifiedMemory: number | null;
  cpuCores: number;
}

const BYTES_PER_GB = 1024 ** 3;

function toGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100;
}

function safeExec(command: string): string | null {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function parseFirstInt(text: string | null): number | null {
  if (!text) {
    return null;
  }
  const match = text.match(/-?\d+/);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? value : null;
}

function parseNvidiaSmiGpu(): { gpuName: string | null; gpuVRAM: number | null } {
  const output = safeExec("nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits");
  if (!output) {
    return { gpuName: null, gpuVRAM: null };
  }

  const firstRow = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstRow) {
    return { gpuName: null, gpuVRAM: null };
  }

  const parts = firstRow.split(",");
  if (parts.length < 2) {
    return { gpuName: null, gpuVRAM: null };
  }

  const memoryMb = Number.parseFloat(parts[0].trim());
  const gpuName = parts.slice(1).join(",").trim() || null;
  if (!Number.isFinite(memoryMb) || !gpuName) {
    return { gpuName: null, gpuVRAM: null };
  }

  return {
    gpuName,
    gpuVRAM: Math.round((memoryMb / 1024) * 100) / 100,
  };
}

function parseLinuxMeminfo(meminfo: string): {
  totalBytes: number | null;
  availableBytes: number | null;
} {
  const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/im);
  const availableMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/im);

  const totalKb = totalMatch ? Number.parseInt(totalMatch[1], 10) : Number.NaN;
  const availableKb = availableMatch ? Number.parseInt(availableMatch[1], 10) : Number.NaN;

  return {
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
    availableBytes: Number.isFinite(availableKb) ? availableKb * 1024 : null,
  };
}

function parseLinuxCpuModel(cpuinfo: string): string | null {
  const match = cpuinfo.match(/^model name\s*:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

function parseLinuxCpuCores(cpuinfo: string): number | null {
  const count = [...cpuinfo.matchAll(/^processor\s*:/gim)].length;
  return count > 0 ? count : null;
}

function parseWmicColumn(output: string | null): string | null {
  if (!output) {
    return null;
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 1 ? lines[1] : null;
}

function parseWmicCapacities(output: string | null): number | null {
  if (!output) {
    return null;
  }
  const totalBytes = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .reduce((sum, value) => sum + Number.parseInt(value, 10), 0);
  return totalBytes > 0 ? totalBytes : null;
}

function parseWmicCoreCount(output: string | null): number | null {
  if (!output) {
    return null;
  }
  const totalCores = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .reduce((sum, value) => sum + Number.parseInt(value, 10), 0);
  return totalCores > 0 ? totalCores : null;
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  const platform = process.platform;
  const osValue: HardwareProfile["os"] =
    platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

  let chip = os.cpus()[0]?.model ?? "Unknown CPU";
  let totalRamBytes = os.totalmem();
  let availableRamBytes = os.freemem();
  let cpuCores = os.cpus().length || 1;
  let gpuName: string | null = null;
  let gpuVRAM: number | null = null;
  let unifiedMemory: number | null = null;

  if (osValue === "macos") {
    const memsizeBytes = parseFirstInt(safeExec("sysctl -n hw.memsize"));
    if (memsizeBytes && memsizeBytes > 0) {
      totalRamBytes = memsizeBytes;
    }

    const profiler = safeExec("system_profiler SPHardwareDataType");
    if (profiler) {
      const chipMatch =
        profiler.match(/^\s*Chip:\s*(.+)$/im) ?? profiler.match(/^\s*Processor Name:\s*(.+)$/im);
      if (chipMatch?.[1]) {
        chip = chipMatch[1].trim();
      }
    }

    const coreCount = parseFirstInt(safeExec("sysctl -n hw.ncpu"));
    if (coreCount && coreCount > 0) {
      cpuCores = coreCount;
    }

    if (/^Apple\s+/i.test(chip)) {
      unifiedMemory = toGb(totalRamBytes);
    }
  } else if (osValue === "linux") {
    const meminfo = safeExec("cat /proc/meminfo");
    if (meminfo) {
      const parsed = parseLinuxMeminfo(meminfo);
      if (parsed.totalBytes && parsed.totalBytes > 0) {
        totalRamBytes = parsed.totalBytes;
      }
      if (parsed.availableBytes && parsed.availableBytes > 0) {
        availableRamBytes = parsed.availableBytes;
      }
    }

    const cpuinfo = safeExec("cat /proc/cpuinfo");
    if (cpuinfo) {
      const model = parseLinuxCpuModel(cpuinfo);
      if (model) {
        chip = model;
      }
      const cores = parseLinuxCpuCores(cpuinfo);
      if (cores) {
        cpuCores = cores;
      }
    }

    const gpu = parseNvidiaSmiGpu();
    gpuName = gpu.gpuName;
    gpuVRAM = gpu.gpuVRAM;
  } else {
    const capacityOutput = safeExec("wmic memorychip get capacity");
    const totalCapacityBytes = parseWmicCapacities(capacityOutput);
    if (totalCapacityBytes && totalCapacityBytes > 0) {
      totalRamBytes = totalCapacityBytes;
    }

    const cpuName = parseWmicColumn(safeExec("wmic cpu get name"));
    if (cpuName) {
      chip = cpuName;
    }

    const wmicCoreCount = parseWmicCoreCount(safeExec("wmic cpu get NumberOfCores"));
    if (wmicCoreCount && wmicCoreCount > 0) {
      cpuCores = wmicCoreCount;
    }

    const gpu = parseNvidiaSmiGpu();
    gpuName = gpu.gpuName;
    gpuVRAM = gpu.gpuVRAM;
  }

  return {
    os: osValue,
    chip,
    totalRAM: toGb(totalRamBytes),
    availableRAM: toGb(availableRamBytes),
    gpuName,
    gpuVRAM,
    unifiedMemory,
    cpuCores,
  };
}
