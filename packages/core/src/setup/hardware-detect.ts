import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const COMMAND_TIMEOUT_MS = 10_000;
const BYTES_PER_GB = 1024 ** 3;
const KIB_PER_GB = 1024 ** 2;
const execFileAsync = promisify(execFile);

export type ChipVendor = "apple" | "nvidia" | "amd" | "intel" | "unknown";
export type OSType = "macos" | "linux" | "windows" | "unknown";

export interface GPUInfo {
  vendor: ChipVendor;
  name: string;
  vramGB: number;
  isAppleSilicon: boolean;
}

export interface HardwareProfile {
  os: OSType;
  arch: "arm64" | "x64" | "unknown";
  totalRAMGB: number;
  unifiedMemoryGB: number;
  gpuVRAMGB: number;
  gpu: GPUInfo;
  cpuCores: number;
  cpuModel: string;
  isAppleSilicon: boolean;
  availableForModelGB: number;
  ollamaInstalled: boolean;
  ollamaVersion: string | null;
  prowlDataDir: string;
}

function logWarning(step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[hardware-detect] ${step} failed: ${message}`);
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeOS(platform: NodeJS.Platform): OSType {
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "unknown";
}

function normalizeArch(arch: string): HardwareProfile["arch"] {
  if (arch === "arm64") {
    return "arm64";
  }
  if (arch === "x64") {
    return "x64";
  }
  return "unknown";
}

function parseMemoryGB(text: string): number {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return 0;
  }
  return roundToTwo(Number.parseFloat(match[1]));
}

function parseFirstNumber(text: string): number {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return 0;
  }
  return Number.parseFloat(match[1]);
}

function detectVendorFromName(name: string): ChipVendor {
  if (/apple/i.test(name)) {
    return "apple";
  }
  if (/nvidia/i.test(name)) {
    return "nvidia";
  }
  if (/(amd|radeon)/i.test(name)) {
    return "amd";
  }
  if (/intel/i.test(name)) {
    return "intel";
  }
  return "unknown";
}

function parseOllamaVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?/);
  if (match) {
    return match[0];
  }
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatGB(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return roundToTwo(value).toString();
}

function toOsLabel(osType: OSType): string {
  if (osType === "macos") {
    return "macOS";
  }
  if (osType === "linux") {
    return "Linux";
  }
  if (osType === "windows") {
    return "Windows";
  }
  return "Unknown OS";
}

async function runCommand(step: string, command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    logWarning(step, error);
    return null;
  }
}

function getProwlDataDir(osType: OSType): string {
  if (osType === "windows") {
    return path.join(process.env.APPDATA || os.homedir(), "Prowl", "models");
  }
  return path.join(os.homedir(), ".prowl", "models");
}

function calculateAvailableForModel(profile: HardwareProfile): number {
  if (profile.isAppleSilicon) {
    return Math.max(0, roundToTwo(profile.unifiedMemoryGB - 6));
  }

  if ((profile.gpu.vendor === "nvidia" || profile.gpu.vendor === "amd") && profile.gpuVRAMGB > 0) {
    return Math.max(0, roundToTwo(profile.gpuVRAMGB));
  }

  return Math.max(0, roundToTwo(profile.totalRAMGB - 8));
}

function parseRocmVramGB(output: string): number {
  const bytesMatch = output.match(/Total\s+Memory\s*\(B\)\s*:\s*(\d+)/i);
  if (bytesMatch) {
    return roundToTwo(Number.parseInt(bytesMatch[1], 10) / BYTES_PER_GB);
  }

  const mibMatch = output.match(/Total\s+Memory\s*\(MiB\)\s*:\s*(\d+)/i);
  if (mibMatch) {
    return roundToTwo(Number.parseInt(mibMatch[1], 10) / 1024);
  }

  const firstValue = parseFirstNumber(output);
  if (firstValue <= 0) {
    return 0;
  }

  if (firstValue > 1_000_000) {
    return roundToTwo(firstValue / BYTES_PER_GB);
  }

  return roundToTwo(firstValue / 1024);
}

function parseWindowsGpuLine(
  line: string,
  adapterFirst: boolean,
): { name: string; vramGB: number } | null {
  if (adapterFirst) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    const vramGB = roundToTwo(Number.parseInt(match[1], 10) / BYTES_PER_GB);
    return { name: match[2].trim(), vramGB: Number.isFinite(vramGB) ? vramGB : 0 };
  }

  const match = line.match(/^(.+?)\s+(\d+)$/);
  if (!match) {
    return null;
  }
  const vramGB = roundToTwo(Number.parseInt(match[2], 10) / BYTES_PER_GB);
  return { name: match[1].trim(), vramGB: Number.isFinite(vramGB) ? vramGB : 0 };
}

async function detectMacOS(profile: HardwareProfile): Promise<void> {
  const output = await runCommand("macOS hardware detection", "system_profiler", [
    "SPHardwareDataType",
    "-json",
  ]);
  if (!output) {
    return;
  }

  try {
    const parsed = JSON.parse(output) as {
      SPHardwareDataType?: Array<{
        chip_type?: string;
        physical_memory?: string;
        cpu_type?: string;
      }>;
    };
    const hardware = parsed.SPHardwareDataType?.[0];
    if (!hardware) {
      return;
    }

    const chipType = hardware.chip_type || hardware.cpu_type || "unknown";
    const vendor = detectVendorFromName(chipType);
    const unifiedMemoryGB = parseMemoryGB(hardware.physical_memory ?? "");

    profile.cpuModel = chipType;
    profile.gpu = {
      vendor,
      name: chipType,
      vramGB: 0,
      isAppleSilicon: /apple/i.test(chipType),
    };
    profile.isAppleSilicon = profile.gpu.isAppleSilicon;

    if (profile.isAppleSilicon) {
      profile.unifiedMemoryGB = unifiedMemoryGB;
      profile.totalRAMGB = unifiedMemoryGB;
    } else if (unifiedMemoryGB > 0) {
      profile.totalRAMGB = unifiedMemoryGB;
    }
  } catch (error) {
    logWarning("macOS hardware parsing", error);
  }
}

async function detectLinux(profile: HardwareProfile): Promise<void> {
  const meminfo = await runCommand("linux meminfo", "cat", ["/proc/meminfo"]);
  if (meminfo) {
    const memTotalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/im);
    if (memTotalMatch) {
      profile.totalRAMGB = roundToTwo(Number.parseInt(memTotalMatch[1], 10) / KIB_PER_GB);
    }
  }

  const cpuinfo = await runCommand("linux cpuinfo", "cat", ["/proc/cpuinfo"]);
  if (cpuinfo) {
    const cpuModelMatch = cpuinfo.match(/^model name\s*:\s*(.+)$/im);
    if (cpuModelMatch?.[1]) {
      profile.cpuModel = cpuModelMatch[1].trim();
    }
  }

  const nvidiaOutput = await runCommand("linux NVIDIA GPU detection", "nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);

  if (nvidiaOutput) {
    const firstLine = nvidiaOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (firstLine) {
      const [namePart, memoryPart] = firstLine.split(",").map((part) => part.trim());
      const memoryMB = Number.parseFloat(memoryPart);
      if (namePart && Number.isFinite(memoryMB)) {
        const vramGB = roundToTwo(memoryMB / 1024);
        profile.gpu = {
          vendor: "nvidia",
          name: namePart,
          vramGB,
          isAppleSilicon: false,
        };
        profile.gpuVRAMGB = vramGB;
        return;
      }
    }
    logWarning("linux NVIDIA GPU parsing", new Error("Unable to parse nvidia-smi output"));
  }

  const rocmOutput = await runCommand("linux AMD GPU detection", "rocm-smi", [
    "--showmeminfo",
    "vram",
  ]);

  if (rocmOutput) {
    const vramGB = parseRocmVramGB(rocmOutput);
    profile.gpu = {
      vendor: "amd",
      name: "AMD GPU",
      vramGB,
      isAppleSilicon: false,
    };
    profile.gpuVRAMGB = vramGB;
  }
}

function parseWmicValue(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return "";
  }

  return lines[1];
}

async function detectWindows(profile: HardwareProfile): Promise<void> {
  const memoryOutput = await runCommand("windows memory detection", "wmic", [
    "ComputerSystem",
    "get",
    "TotalPhysicalMemory",
  ]);
  if (memoryOutput) {
    const memoryValue = parseFirstNumber(memoryOutput);
    if (memoryValue > 0) {
      profile.totalRAMGB = roundToTwo(memoryValue / BYTES_PER_GB);
    }
  }

  const cpuOutput = await runCommand("windows cpu detection", "wmic", ["cpu", "get", "Name"]);
  if (cpuOutput) {
    const cpuModel = parseWmicValue(cpuOutput);
    if (cpuModel) {
      profile.cpuModel = cpuModel;
    }
  }

  const gpuOutput = await runCommand("windows gpu detection", "wmic", [
    "path",
    "win32_VideoController",
    "get",
    "Name,AdapterRAM",
  ]);

  if (gpuOutput) {
    const lines = gpuOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length > 1) {
      const header = lines[0].toLowerCase();
      const adapterFirst = header.startsWith("adapterram");

      for (const line of lines.slice(1)) {
        const parsed = parseWindowsGpuLine(line, adapterFirst);
        if (!parsed) {
          continue;
        }

        profile.gpu = {
          vendor: detectVendorFromName(parsed.name),
          name: parsed.name,
          vramGB: parsed.vramGB,
          isAppleSilicon: false,
        };
        profile.gpuVRAMGB = parsed.vramGB;
        break;
      }
    }
  }
}

async function detectOllama(profile: HardwareProfile): Promise<void> {
  const output = await runCommand("ollama version detection", "ollama", ["--version"]);
  if (!output) {
    profile.ollamaInstalled = false;
    profile.ollamaVersion = null;
    return;
  }

  profile.ollamaInstalled = true;
  profile.ollamaVersion = parseOllamaVersion(output);
}

export async function detectHardware(): Promise<HardwareProfile> {
  let cpuModel = "unknown";
  let cpuCores = 0;

  try {
    const cpus = os.cpus();
    cpuModel = cpus[0]?.model || "unknown";
    cpuCores = cpus.length;
  } catch (error) {
    logWarning("cpu detection", error);
  }

  const osType = normalizeOS(process.platform);

  const profile: HardwareProfile = {
    os: osType,
    arch: normalizeArch(process.arch),
    totalRAMGB: 0,
    unifiedMemoryGB: 0,
    gpuVRAMGB: 0,
    gpu: {
      vendor: "unknown",
      name: "Unknown GPU",
      vramGB: 0,
      isAppleSilicon: false,
    },
    cpuCores,
    cpuModel,
    isAppleSilicon: false,
    availableForModelGB: 0,
    ollamaInstalled: false,
    ollamaVersion: null,
    prowlDataDir: getProwlDataDir(osType),
  };

  try {
    if (osType === "macos") {
      await detectMacOS(profile);
    } else if (osType === "linux") {
      await detectLinux(profile);
    } else if (osType === "windows") {
      await detectWindows(profile);
    }
  } catch (error) {
    logWarning("platform hardware detection", error);
  }

  await detectOllama(profile);

  profile.isAppleSilicon = profile.gpu.isAppleSilicon;
  if (profile.isAppleSilicon && profile.unifiedMemoryGB <= 0 && profile.totalRAMGB > 0) {
    profile.unifiedMemoryGB = profile.totalRAMGB;
  }

  profile.availableForModelGB = calculateAvailableForModel(profile);

  return profile;
}

export async function getHardwareProfile(): Promise<HardwareProfile> {
  return detectHardware();
}

export function getAvailableRAM(profile: HardwareProfile): number {
  return profile.availableForModelGB;
}

export function formatProfile(profile: HardwareProfile): string {
  const hardwareName = profile.gpu.name !== "Unknown GPU" ? profile.gpu.name : profile.cpuModel;

  const memoryParts: string[] = [];
  if (profile.isAppleSilicon) {
    memoryParts.push(`${formatGB(profile.unifiedMemoryGB)}GB unified`);
  } else if (profile.gpuVRAMGB > 0) {
    memoryParts.push(`${formatGB(profile.gpuVRAMGB)}GB VRAM`);
    memoryParts.push(`${formatGB(profile.totalRAMGB)}GB RAM`);
  } else {
    memoryParts.push(`${formatGB(profile.totalRAMGB)}GB RAM`);
  }

  const ollamaText =
    profile.ollamaInstalled && profile.ollamaVersion
      ? `Ollama ${profile.ollamaVersion}`
      : "Ollama not installed";

  return [hardwareName, ...memoryParts, profile.arch, toOsLabel(profile.os), ollamaText].join(
    " · ",
  );
}
