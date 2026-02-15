import { OLLAMA_DEFAULT_MODEL_ID } from "./ollama-config.js";

// Defaults for agent metadata when upstream does not supply them.
// Keep code-level defaults local-first for repo users who skip installer flows.
export const DEFAULT_PROVIDER = "ollama";
export const DEFAULT_MODEL = OLLAMA_DEFAULT_MODEL_ID;
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
