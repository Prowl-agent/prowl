import { listInstalledModels } from "../packages/core/src/models/model-manager.js";

const config = {
  ollamaUrl: "http://localhost:11434",
  prowlConfigPath: `${process.env.HOME}/.prowl/config.json`,
};

console.log("=== OLLAMA MODEL LIST ===");
const models = await listInstalledModels(config);

if (models.length === 0) {
  console.warn("⚠️  No models installed in Ollama. Run: ollama pull qwen3:8b");
} else {
  for (const model of models) {
    console.log(
      `  ${model.isActive ? "▶" : " "} ${model.displayName} ` +
        `(${model.sizeGB.toFixed(1)}GB) ${model.isActive ? "[ACTIVE]" : ""}`,
    );
  }
  console.log("✅ Ollama connection PASSED");
}
