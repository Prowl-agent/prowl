import { resolveOpenClawAgentDir } from "../../../src/agents/agent-paths.js";
/**
 * Auto-bootstrap Ollama auth profile for keyless local provider.
 * Creates a default auth profile so Ollama works without manual configuration.
 */
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
} from "../../../src/agents/auth-profiles.js";

const OLLAMA_PROFILE_ID = "ollama:default";
const OLLAMA_DUMMY_KEY = "ollama-local-no-key-needed";

/**
 * Check if Ollama is running by hitting its API.
 */
export async function isOllamaRunning(
  ollamaUrl: string = "http://127.0.0.1:11434",
): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Auto-create Ollama auth profile if it doesn't exist.
 * This allows Ollama to work as a keyless local provider.
 */
export function ensureOllamaAuthProfile(agentDir?: string): boolean {
  const store = ensureAuthProfileStore(agentDir);
  const existingProfiles = listProfilesForProvider(store, "ollama");

  // If Ollama profile already exists, no need to create one
  if (existingProfiles.length > 0) {
    return false;
  }

  // Create default Ollama profile with dummy key (Ollama doesn't actually need a key)
  upsertAuthProfile({
    profileId: OLLAMA_PROFILE_ID,
    credential: {
      type: "api_key",
      provider: "ollama",
      key: OLLAMA_DUMMY_KEY,
    },
    agentDir,
  });

  return true;
}

/**
 * Bootstrap Ollama auth for the main agent directory.
 * Called during plugin initialization.
 */
export function bootstrapOllamaAuth(): void {
  const agentDir = resolveOpenClawAgentDir();
  const created = ensureOllamaAuthProfile(agentDir);
  if (created) {
    // Profile was created - this is expected on first run
  }
}
