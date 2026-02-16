#!/usr/bin/env node

/**
 * npx create-prowl
 *
 * One-command installer for Prowl — local AI agent framework.
 * Detects hardware, installs Ollama, pulls the right model, and sets up Prowl.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, totalmem, cpus, arch } from "node:os";
import { join, dirname } from "node:path";

// Dynamic imports for ESM-only deps
const chalk = (await import("chalk")).default;
const ora = (await import("ora")).default;
const cliProgress = await import("cli-progress");

const PROWL_VERSION = "0.1.0";
const PROWL_REPO = "https://github.com/prowl-agent/prowl";
const HOME = homedir();
const PROWL_DIR = join(HOME, ".prowl", "app");
const PROWL_CONFIG = join(HOME, ".prowl", "config.json");
const OLLAMA_URL = "http://localhost:11434";

// ── Banner ──────────────────────────────────────────────────────────

function printBanner() {
  console.log("");
  console.log(chalk.bold("  🐾 Prowl") + chalk.gray(` v${PROWL_VERSION}`));
  console.log(chalk.dim("     Your AI agent. Your hardware. Zero cost."));
  console.log("");
}

// ── Hardware detection ──────────────────────────────────────────────

function detectHardware() {
  const os = platform();
  const ramGB = Math.round(totalmem() / 1024 ** 3);
  const cpuModel = cpus()[0]?.model ?? "Unknown CPU";
  const archName = arch();
  const isAppleSilicon = os === "darwin" && archName === "arm64";

  let gpuName = "";
  try {
    if (os === "darwin") {
      const sp = execSync("system_profiler SPDisplaysDataType 2>/dev/null", { encoding: "utf8" });
      const match = sp.match(/Chip(?:set)? Model:\s*(.+)/i) || sp.match(/Chipset Model:\s*(.+)/i);
      gpuName = match?.[1]?.trim() ?? "";
    } else if (os === "win32") {
      gpuName =
        execSync("wmic path win32_videocontroller get name /value 2>nul", { encoding: "utf8" })
          .match(/Name=(.+)/)?.[1]
          ?.trim() ?? "";
    } else {
      gpuName = execSync("lspci 2>/dev/null | grep -i vga | head -1 | cut -d: -f3", {
        encoding: "utf8",
      }).trim();
    }
  } catch {
    /* ignore */
  }

  const chipLabel = isAppleSilicon
    ? cpuModel.replace(/Apple\s*/i, "").trim()
    : (gpuName || cpuModel).substring(0, 40);

  return { os, ramGB, cpuModel, archName, isAppleSilicon, gpuName, chipLabel };
}

// ── Model selection ─────────────────────────────────────────────────

function selectModel(ramGB, gpuName) {
  const avail = ramGB - 6;
  const hasNvidia = /nvidia|geforce|rtx|gtx/i.test(gpuName);

  if (avail >= 40) {
    return { tag: "qwen3:32b", name: "Qwen3 32B", size: "19GB", quality: "excellent" };
  }
  if (avail >= 14 || hasNvidia) {
    return { tag: "qwen2.5-coder:14b", name: "Qwen2.5-Coder 14B", size: "9GB", quality: "great" };
  }
  if (avail >= 8) {
    return { tag: "qwen3:8b", name: "Qwen3 8B", size: "4.9GB", quality: "good" };
  }
  if (avail >= 4) {
    return { tag: "qwen3:4b", name: "Qwen3 4B", size: "2.6GB", quality: "basic" };
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`${platform() === "win32" ? "where" : "command -v"} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ollamaIsRunning() {
  try {
    const res = await fetch(`${OLLAMA_URL}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(maxSeconds = 15) {
  for (let i = 0; i < maxSeconds; i++) {
    if (await ollamaIsRunning()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function askConfirm(question) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(!answer || /^[yY]/.test(answer));
    });
  });
}

// ── Steps ───────────────────────────────────────────────────────────

async function stepCheckNode(spinner) {
  spinner.text = "Checking Node.js...";
  const major = parseInt(process.version.replace("v", "").split(".")[0], 10);
  if (major >= 22) {
    spinner.succeed(chalk.green(`Node.js ${process.version}`));
    return;
  }
  spinner.warn(`Node.js ${process.version} found — v22+ recommended. Continuing anyway.`);
}

async function stepCheckOllama(spinner) {
  spinner.text = "Checking Ollama...";

  if (commandExists("ollama")) {
    let ver = "";
    try {
      ver = execSync("ollama --version 2>/dev/null", { encoding: "utf8" }).trim();
    } catch {
      /* */
    }
    spinner.succeed(chalk.green(`Ollama ${ver || "installed"}`));
  } else {
    spinner.text = "Installing Ollama...";
    try {
      if (platform() === "darwin") {
        if (commandExists("brew")) {
          execSync("brew install ollama", { stdio: "pipe" });
        } else {
          execSync("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "pipe", shell: true });
        }
      } else if (platform() === "win32") {
        execSync(
          "winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements",
          { stdio: "pipe" },
        );
      } else {
        execSync("curl -fsSL https://ollama.com/install.sh | sh", { stdio: "pipe", shell: true });
      }
      spinner.succeed(chalk.green("Ollama installed"));
    } catch {
      spinner.fail("Could not install Ollama automatically.");
      console.log(chalk.yellow("  Install manually from https://ollama.com and re-run."));
      process.exit(1);
    }
  }

  // Ensure running
  if (!(await ollamaIsRunning())) {
    const sub = ora("  Starting Ollama service...").start();
    try {
      const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
      child.unref();
    } catch {
      /* */
    }
    if (await waitForOllama()) {
      sub.succeed("Ollama running");
    } else {
      sub.fail("Could not start Ollama. Run 'ollama serve' in another terminal.");
      process.exit(1);
    }
  }
}

async function stepPullModel(model) {
  const bar = new cliProgress.SingleBar({
    format: `  ⬇️  ${model.name} (${model.size}) |` + chalk.cyan("{bar}") + "| {percentage}%",
    barCompleteChar: "█",
    barIncompleteChar: "░",
    hideCursor: true,
  });

  // Check if already installed
  try {
    const out = execSync("ollama list 2>/dev/null", { encoding: "utf8" });
    if (out.includes(model.tag)) {
      console.log(chalk.green(`  ✅ ${model.tag} already installed`));
      return;
    }
  } catch {
    /* */
  }

  bar.start(100, 0);

  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", model.tag], { stdio: ["ignore", "pipe", "pipe"] });
    let lastPct = 0;

    const handleData = (data) => {
      const line = data.toString();
      const match = line.match(/(\d{1,3})%/);
      if (match) {
        const pct = parseInt(match[1], 10);
        if (pct > lastPct) {
          lastPct = pct;
          bar.update(pct);
        }
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("close", (code) => {
      bar.update(100);
      bar.stop();
      if (code === 0) {
        console.log(chalk.green(`  ✅ ${model.name} ready`));
        resolve();
      } else {
        console.log(chalk.red(`  ❌ Model pull failed (exit ${code})`));
        reject(new Error(`ollama pull exited with ${code}`));
      }
    });

    child.on("error", (err) => {
      bar.stop();
      reject(err);
    });
  });
}

async function stepInstallProwl(spinner) {
  spinner.text = "Setting up Prowl...";

  if (existsSync(join(PROWL_DIR, ".git"))) {
    try {
      execSync("git pull --ff-only origin main", { cwd: PROWL_DIR, stdio: "pipe" });
    } catch {
      /* continue with existing */
    }
  } else {
    mkdirSync(dirname(PROWL_DIR), { recursive: true });
    execSync(`git clone --depth 1 ${PROWL_REPO} "${PROWL_DIR}"`, { stdio: "pipe", shell: true });
  }

  // Install deps
  if (commandExists("pnpm")) {
    try {
      execSync("pnpm install --frozen-lockfile", { cwd: PROWL_DIR, stdio: "pipe" });
    } catch {
      execSync("pnpm install", { cwd: PROWL_DIR, stdio: "pipe" });
    }
  } else {
    execSync("npm install", { cwd: PROWL_DIR, stdio: "pipe" });
  }

  spinner.succeed(chalk.green("Prowl installed"));
}

function writeConfig(model) {
  if (existsSync(PROWL_CONFIG)) {
    return;
  }
  mkdirSync(dirname(PROWL_CONFIG), { recursive: true });
  writeFileSync(
    PROWL_CONFIG,
    JSON.stringify(
      {
        model: model.tag,
        ollamaUrl: OLLAMA_URL,
        installedAt: new Date().toISOString(),
        prowlVersion: PROWL_VERSION,
      },
      null,
      2,
    ) + "\n",
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  // Detect hardware first
  const hw = detectHardware();
  const model = selectModel(hw.ramGB, hw.gpuName);

  if (!model) {
    console.log(
      chalk.red(`  ❌ Insufficient memory (${hw.ramGB}GB). Prowl requires at least 10GB RAM.`),
    );
    process.exit(1);
  }

  // Preview
  console.log(chalk.dim("  Hardware: ") + `${hw.chipLabel}, ${hw.ramGB}GB RAM`);
  console.log(
    chalk.dim("  Plan:     ") +
      `Install Ollama → pull ${model.name} (${model.size}) → set up Prowl`,
  );
  console.log(chalk.dim("  Time:     ") + "About 2-3 minutes (depends on internet speed)");
  console.log("");

  const proceed = await askConfirm("  Continue? (Y/n) ");
  if (!proceed) {
    console.log("  Cancelled.");
    process.exit(0);
  }
  console.log("");

  // Step 1: Node check
  const s1 = ora("  [1/4] Checking Node.js...").start();
  await stepCheckNode(s1);

  // Step 2: Ollama
  const s2 = ora("  [2/4] Checking Ollama...").start();
  await stepCheckOllama(s2);

  // Step 3: Model pull
  console.log(chalk.bold("  [3/4] Pulling AI model..."));
  await stepPullModel(model);

  // Step 4: Install Prowl
  const s4 = ora("  [4/4] Setting up Prowl...").start();
  await stepInstallProwl(s4);

  // Config
  writeConfig(model);

  // Done
  console.log("");
  console.log(chalk.bold.green("  🐾 Prowl is ready!"));
  console.log("");
  console.log(`     Dashboard:  ${chalk.cyan("http://localhost:18789")}`);
  console.log(`     Docs:       ${chalk.cyan("https://prowl.dev/docs")}`);
  console.log("");
  console.log(chalk.yellow("     💰 You saved $0.00 and counting"));
  console.log("");

  // Auto-start offer
  const startNow = await askConfirm("  Start Prowl now? (Y/n) ");
  if (startNow) {
    const startSpinner = ora("  Starting Prowl...").start();
    const pm = commandExists("pnpm") ? "pnpm" : "npm";
    const child = spawn(pm, ["start", "gateway", "run", "--allow-unconfigured"], {
      cwd: PROWL_DIR,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 3000));

    // Open browser
    const url = "http://localhost:18789";
    try {
      if (platform() === "darwin") {
        execSync(`open "${url}"`, { stdio: "ignore" });
      } else if (platform() === "win32") {
        execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
      } else if (commandExists("xdg-open")) {
        execSync(`xdg-open "${url}"`, { stdio: "ignore" });
      }
    } catch {
      /* */
    }

    startSpinner.succeed(chalk.green("Prowl is running! Dashboard opened."));
  }

  console.log("");
}

main().catch((err) => {
  console.error(chalk.red(`\n  Fatal: ${err.message}`));
  process.exit(1);
});
