/**
 * Prowl Local-First Extension Plugin
 *
 * Registers HTTP routes for the Prowl dashboard (model management, privacy,
 * cost savings, setup) and optional CLI commands. All Prowl-specific gateway
 * functionality lives here so the upstream OpenClaw core remains unmodified.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerBenchmarkCommand } from "./src/cli-commands.js";
import {
  createHealthHandler,
  createModelsActiveHandler,
  createModelsDeleteHandler,
  createModelsInstalledHandler,
  createModelsPullHandler,
  createModelsSwitchHandler,
  createPrivacyExportCsvHandler,
  createPrivacyLogHandler,
  createPrivacyStatsHandler,
  createSavingsHandler,
  createSetupStatusHandler,
  defaultProwlHttpConfig,
  type ProwlHttpConfig,
} from "./src/http-routes.js";

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

  // ── CLI Commands ───────────────────────────────────────────────────
  api.registerCli(
    ({ program }) => {
      registerBenchmarkCommand(program);
    },
    { commands: ["benchmark"] },
  );

  api.logger.info("Prowl local-first plugin registered");
}
