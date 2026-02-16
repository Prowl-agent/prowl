import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { syncProwlEnv } from "../prowl-shim.js";
import { getCommandPath, getPrimaryCommand, hasHelpOrVersion } from "./argv.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPath(argv, 2);
  if (!primary) {
    return true;
  }
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

export async function runCli(argv: string[] = process.argv) {
  const normalizedArgv = normalizeWindowsArgv(argv);
  loadDotEnv({ quiet: true });
  syncProwlEnv(); // Re-sync after .env may have added new PROWL_* vars.
  normalizeEnv();

  // First-run auto-model detection: if no config.json exists, detect hardware
  // and pick the best model. This only runs once; subsequent starts read the
  // saved config synchronously in prowl-shim.ts.
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const configPath = join(homedir(), ".prowl", "config.json");
    try {
      readFileSync(configPath);
    } catch {
      // Config doesn't exist — first run. Auto-detect the best model.
      const { resolveAutoModel } = await import("../../packages/core/src/setup/auto-model.js");
      const result = await resolveAutoModel({
        onProgress: (msg: string) => console.log(`[prowl] ${msg}`),
      });
      // Update env so the rest of this startup uses the auto-detected model.
      process.env.OPENCLAW_DEFAULT_MODEL = result.model;
      process.env.OPENCLAW_DEFAULT_PROVIDER = result.provider;
    }
  } catch {
    // Auto-model detection is best-effort; don't block startup.
  }

  // Warm-on-boot: pre-load the model into GPU/RAM in the background so
  // the first chat message doesn't pay cold-start latency.
  try {
    const { readWarmupConfig, warmModel, startKeepAlive } =
      await import("../../packages/core/src/perf/model-warmup.js");
    const warmupCfg = readWarmupConfig();
    const currentModel = process.env.OPENCLAW_DEFAULT_MODEL;
    if (warmupCfg.warmOnBoot && currentModel) {
      // Fire-and-forget: don't block CLI startup.
      void warmModel(currentModel).then(() => {
        if (warmupCfg.keepAlive) {
          startKeepAlive(currentModel);
        }
      });
    }
  } catch {
    // Warm-up is best-effort.
  }

  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  if (await tryRouteCli(normalizedArgv)) {
    return;
  }

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  enableConsoleCapture();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[prowl] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
  // Register the primary command (builtin or subcli) so help and command parsing
  // are correct even with lazy command registration.
  const primary = getPrimaryCommand(parseArgv);
  if (primary) {
    const { getProgramContext } = await import("./program/program-context.js");
    const ctx = getProgramContext(program);
    if (ctx) {
      const { registerCoreCliByName } = await import("./program/command-registry.js");
      await registerCoreCliByName(program, ctx, primary, parseArgv);
    }
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  const hasBuiltinPrimary =
    primary !== null && program.commands.some((command) => command.name() === primary);
  const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
    argv: parseArgv,
    primary,
    hasBuiltinPrimary,
  });
  if (!shouldSkipPluginRegistration) {
    // Register plugin CLI commands before parsing
    const { registerPluginCliCommands } = await import("../plugins/cli.js");
    const { loadConfig } = await import("../config/config.js");
    registerPluginCliCommands(program, loadConfig());
  }

  await program.parseAsync(parseArgv);
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
