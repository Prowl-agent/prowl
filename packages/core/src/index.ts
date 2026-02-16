export * from "./analytics/index.js";
export * from "./benchmark/index.js";
export * from "./models/index.js";
export * from "./optimizer/index.js";
export * from "./privacy/index.js";
export * from "./router/index.js";
export * from "./setup/hardware-detect.js";
export * from "./setup/model-recommend.js";
export {
  isOllamaRunning,
  readProwlConfig,
  runInstaller,
  startOllamaService,
  type InstallerOptions,
  type InstallerPhase,
  type InstallerProgress,
  type InstallerResult,
  type ProwlConfig,
} from "./setup/installer.js";
