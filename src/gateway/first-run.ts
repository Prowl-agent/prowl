/**
 * First-run detection and auto-launch logic.
 *
 * When the gateway starts for the very first time (no config file exists yet),
 * this module opens the dashboard in the user's default browser so they land
 * directly on the setup wizard without having to know the URL.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIRST_RUN_MARKER = path.join(os.homedir(), ".prowl", ".first-run-done");

/**
 * Returns true if this appears to be the first time the gateway is starting.
 * First-run is determined by:
 *   1. No Prowl config exists (~/.prowl/config.json) AND
 *   2. No first-run marker file exists (~/.prowl/.first-run-done)
 */
export function isFirstRun(configExists: boolean): boolean {
  if (configExists) {
    return false;
  }
  // Even without a config, if the marker exists this isn't the first run
  // (the user may have deleted the config but already went through setup).
  try {
    return !fs.existsSync(FIRST_RUN_MARKER);
  } catch {
    return true;
  }
}

/**
 * Mark first-run as complete so we don't re-open the browser on every start
 * for users who haven't created a config yet.
 */
export function markFirstRunComplete(): void {
  try {
    const dir = path.dirname(FIRST_RUN_MARKER);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FIRST_RUN_MARKER, new Date().toISOString(), "utf8");
  } catch {
    // Best-effort; don't block gateway startup.
  }
}

/**
 * Open a URL in the user's default browser.
 * Platform-aware: macOS (open), Linux (xdg-open), Windows (start).
 * Fires-and-forgets — never throws.
 */
export function openBrowser(url: string): void {
  try {
    const plat = process.platform;
    let cmd: string;
    let args: string[];

    if (plat === "darwin") {
      cmd = "open";
      args = [url];
    } else if (plat === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Swallow — if the browser can't open, the URL is still printed to console.
  }
}

/**
 * If this is a first-run, open the dashboard URL in the browser after a short
 * delay (gives the HTTP server time to be fully ready).
 *
 * Call this from the gateway startup after the HTTP server is listening.
 */
export function maybeAutoLaunchDashboard(opts: {
  configExists: boolean;
  port: number;
  delayMs?: number;
  log?: { info: (msg: string) => void };
}): void {
  if (!isFirstRun(opts.configExists)) {
    return;
  }

  const delayMs = opts.delayMs ?? 1500;
  const url = `http://localhost:${opts.port}`;

  opts.log?.info(`First run detected — opening dashboard at ${url} in ${delayMs}ms`);

  setTimeout(() => {
    openBrowser(url);
    markFirstRunComplete();
  }, delayMs);
}
