/**
 * Prowl Local-First Extension Plugin
 *
 * Registers HTTP routes for the Prowl dashboard (model management, privacy,
 * cost savings, setup) and optional CLI commands. All Prowl-specific gateway
 * functionality lives here so the upstream OpenClaw core remains unmodified.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerBenchmarkCommand } from "./src/cli-commands.js";
import { startOllamaIfNeeded } from "./src/ensure-ollama.js";
import {
  createHealthHandler,
  createModelsActiveHandler,
  createModelsDeleteHandler,
  createModelsInstalledHandler,
  createModelsPullHandler,
  createModelsSwitchHandler,
  createOllamaStartHandler,
  createPrivacyExportCsvHandler,
  createPrivacyLogHandler,
  createPrivacyStatsHandler,
  createProwlPrivacyHandler,
  createProwlSavingsHandler,
  createProwlStatsHandler,
  createSavingsHandler,
  createSetupStatusHandler,
  defaultProwlHttpConfig,
  type ProwlHttpConfig,
} from "./src/http-routes.js";
import { bootstrapOllamaAuth } from "./src/ollama-auth-bootstrap.js";

export function register(api: OpenClawPluginApi): void {
  const pluginCfg = (api.pluginConfig ?? {}) as { ollamaUrl?: string };
  const cfg: ProwlHttpConfig = {
    ...defaultProwlHttpConfig(),
    ...(pluginCfg.ollamaUrl ? { ollamaUrl: pluginCfg.ollamaUrl } : {}),
  };

  // ── HTTP Routes ─────────────────────────────────────────────────────
  // Paths match the original gateway routes so the existing UI components
  // continue to work without changes. These are dispatched by the plugin
  // HTTP layer after core routes.

  api.registerHttpRoute({
    path: "/api/models/active",
    handler: createModelsActiveHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/models/installed",
    handler: createModelsInstalledHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/models/switch",
    handler: createModelsSwitchHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/models/pull",
    handler: createModelsPullHandler(cfg),
  });

  // DELETE /api/models/<tag> — handled via a prefix match route.
  api.registerHttpRoute({
    path: "/api/models/",
    handler: createModelsDeleteHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/setup/status",
    handler: createSetupStatusHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/ollama/start",
    handler: createOllamaStartHandler(cfg),
  });

  api.registerHttpRoute({
    path: "/api/savings",
    handler: createSavingsHandler(),
  });

  api.registerHttpRoute({
    path: "/api/privacy/stats",
    handler: createPrivacyStatsHandler(),
  });

  api.registerHttpRoute({
    path: "/api/privacy/log",
    handler: createPrivacyLogHandler(),
  });

  api.registerHttpRoute({
    path: "/api/privacy/export-csv",
    handler: createPrivacyExportCsvHandler(),
  });

  // ── Prowl Real Data Routes ──────────────────────────────────────────

  api.registerHttpRoute({
    path: "/api/prowl/savings",
    handler: createProwlSavingsHandler(),
  });

  api.registerHttpRoute({
    path: "/api/prowl/privacy",
    handler: createProwlPrivacyHandler(),
  });

  api.registerHttpRoute({
    path: "/api/prowl/stats",
    handler: createProwlStatsHandler(),
  });

  // ── CLI Commands ───────────────────────────────────────────────────
  api.registerCli(
    ({ program }) => {
      registerBenchmarkCommand(program);
    },
    { commands: ["benchmark"] },
  );

  api.logger.info("Prowl local-first plugin registered");

  // Auto-bootstrap Ollama auth profile (keyless local provider)
  bootstrapOllamaAuth();

  // Start Ollama immediately if not already running.
  // This runs synchronously during plugin registration to ensure Ollama is available
  // before the gateway starts accepting requests.
  void (async () => {
    try {
      const result = await startOllamaIfNeeded(cfg.ollamaUrl, {
        info: (msg) => api.logger.info(msg),
        warn: (msg) => api.logger.warn(msg),
      });
      if (result.started) {
        api.logger.info("Ollama started successfully");
      } else if (result.error) {
        api.logger.warn(`Ollama startup failed: ${result.error}`);
      }
    } catch (err) {
      api.logger.warn(
        `Failed to start Ollama: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}
