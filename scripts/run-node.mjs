#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const compiler = "tsdown";
const compilerArgs = ["exec", compiler, "--no-clean"];
const gitWatchedPaths = ["src", "tsconfig.json", "package.json"];

const statMtime = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (srcRoot, filePath) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return false;
  }
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const waitForExit = (child) =>
  new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

/**
 * @param {{
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   spawn?: typeof spawn;
 *   spawnSync?: typeof spawnSync;
 *   execPath?: string;
 *   platform?: NodeJS.Platform;
 * }} options
 * @returns {Promise<number>}
 */
export async function runNodeMain(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? { ...process.env };
  const cwd = options.cwd ?? process.cwd();
  const spawnFn = options.spawn ?? spawn;
  const spawnSyncFn = options.spawnSync ?? spawnSync;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;

  const distRoot = path.join(cwd, "dist");
  const distEntry = path.join(distRoot, "/entry.js");
  const buildStampPath = path.join(distRoot, ".buildstamp");
  const srcRoot = path.join(cwd, "src");
  const configFiles = [path.join(cwd, "tsconfig.json"), path.join(cwd, "package.json")];

  const runGit = (gitArgs) => {
    try {
      const result = spawnSyncFn("git", gitArgs, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0) {
        return null;
      }
      return (result.stdout ?? "").trim();
    } catch {
      return null;
    }
  };

  const resolveGitHead = () => {
    const head = runGit(["rev-parse", "HEAD"]);
    return head || null;
  };

  const hasDirtySourceTree = () => {
    const output = runGit([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ...gitWatchedPaths,
    ]);
    if (output === null) {
      return null;
    }
    return output.length > 0;
  };

  const readBuildStamp = () => {
    const mtime = statMtime(buildStampPath);
    if (mtime == null) {
      return { mtime: null, head: null };
    }
    try {
      const raw = fs.readFileSync(buildStampPath, "utf8").trim();
      if (!raw.startsWith("{")) {
        return { mtime, head: null };
      }
      const parsed = JSON.parse(raw);
      const head =
        typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
      return { mtime, head };
    } catch {
      return { mtime, head: null };
    }
  };

  const hasSourceMtimeChanged = (stampMtime) => {
    const srcMtime = findLatestMtime(srcRoot, (filePath) => isExcludedSource(srcRoot, filePath));
    return srcMtime != null && srcMtime > stampMtime;
  };

  const shouldBuild = () => {
    if (env.OPENCLAW_FORCE_BUILD === "1") {
      return true;
    }
    const stamp = readBuildStamp();
    if (stamp.mtime == null) {
      return true;
    }
    if (statMtime(distEntry) == null) {
      return true;
    }

    for (const filePath of configFiles) {
      const mtime = statMtime(filePath);
      if (mtime != null && mtime > stamp.mtime) {
        return true;
      }
    }

    const currentHead = resolveGitHead();
    if (currentHead && !stamp.head) {
      return hasSourceMtimeChanged(stamp.mtime);
    }
    if (currentHead && stamp.head && currentHead !== stamp.head) {
      return hasSourceMtimeChanged(stamp.mtime);
    }
    if (currentHead) {
      const dirty = hasDirtySourceTree();
      if (dirty === true) {
        return true;
      }
      if (dirty === false) {
        return false;
      }
    }

    if (hasSourceMtimeChanged(stamp.mtime)) {
      return true;
    }
    return false;
  };

  const logRunner = (message) => {
    if (env.OPENCLAW_RUNNER_LOG === "0") {
      return;
    }
    process.stderr.write(`[prowl] ${message}\n`);
  };

  const runNode = async () => {
    const nodeProcess = spawnFn(execPath, ["openclaw.mjs", ...args], {
      cwd,
      env,
      stdio: "inherit",
    });
    const { code, signal } = await waitForExit(nodeProcess);
    if (signal) {
      return 1;
    }
    return code ?? 1;
  };

  const writeBuildStamp = () => {
    try {
      fs.mkdirSync(distRoot, { recursive: true });
      const stamp = {
        builtAt: Date.now(),
        head: resolveGitHead(),
      };
      fs.writeFileSync(buildStampPath, `${JSON.stringify(stamp)}\n`);
    } catch (error) {
      // Best-effort stamp; still allow the runner to start.
      logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
    }
  };

  if (!shouldBuild()) {
    return runNode();
  }

  logRunner("Building TypeScript (dist is stale).");
  const buildCmd = platform === "win32" ? "cmd.exe" : "pnpm";
  const buildArgs =
    platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...compilerArgs] : compilerArgs;
  const build = spawnFn(buildCmd, buildArgs, {
    cwd,
    env,
    stdio: "inherit",
  });

  const { code, signal } = await waitForExit(build);
  if (signal) {
    return 1;
  }
  if (code !== 0 && code !== null) {
    return code;
  }

  writeBuildStamp();
  return runNode();
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const exitCode = await runNodeMain();
  process.exit(exitCode);
}
