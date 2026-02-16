// Defaults for agent metadata when upstream does not supply them.
// Can be overridden via OPENCLAW_DEFAULT_PROVIDER / OPENCLAW_DEFAULT_MODEL env vars.
export const DEFAULT_PROVIDER = process.env.OPENCLAW_DEFAULT_PROVIDER ?? "anthropic";
export const DEFAULT_MODEL = process.env.OPENCLAW_DEFAULT_MODEL ?? "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
