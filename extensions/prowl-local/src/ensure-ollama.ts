/**
 * Start Ollama in the background if it is not already reachable.
 * Used so that "launch Prowl" works without the user having to run `ollama serve` first.
 */
import { spawn } from "node:child_process";

const CHECK_TIMEOUT_MS = 2_000;
const WAIT_AFTER_SPAWN_MS = 4_000;

/** Resolve PATH so ollama is findable on macOS/Linux (common install locations). */
function spawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform !== "win32" && env.PATH) {
    const extra = "/usr/local/bin:/opt/homebrew/bin";
    if (!env.PATH.includes("/usr/local/bin") || !env.PATH.includes("/opt/homebrew/bin")) {
      env.PATH = `${env.PATH}:${extra}`;
    }
  }
  return env;
}

export async function startOllamaIfNeeded(
  ollamaUrl: string,
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ started: boolean; error?: string }> {
  const base = ollamaUrl.replace(/\/+$/, "");

  // Quick check if Ollama is already running
  try {
    const res = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (res.ok) {
      log?.info("Ollama is already running.");
      return { started: false }; // already running
    }
  } catch {
    // Connection refused or timeout — try to start Ollama
  }

  log?.info("Ollama not reachable — starting ollama serve in the background.");

  let child;
  try {
    child = spawn("ollama", ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: spawnEnv(),
    });

    // Handle spawn errors
    child.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`Ollama process error: ${msg}`);
    });

    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(`Could not start Ollama: ${msg}. Run 'ollama serve' in a terminal.`);
    return { started: false, error: msg };
  }

  // Give Ollama a few seconds to bind and respond.
  await new Promise((r) => setTimeout(r, WAIT_AFTER_SPAWN_MS));

  // Verify Ollama started successfully
  try {
    const res = await fetch(`${base}/api/version`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (res.ok) {
      log?.info("Ollama started successfully and is now running.");
      return { started: true };
    }
  } catch (err) {
    // Ollama may still be starting up
    log?.info("Ollama process started but not yet responding. It may still be initializing.");
  }

  // Assume started even if not yet responding (it may take longer on slower systems)
  return { started: true };
}
