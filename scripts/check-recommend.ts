import { detectHardware } from "../packages/core/src/setup/hardware-detect.js";
import {
  listCompatibleModels,
  recommendModel,
} from "../packages/core/src/setup/model-recommend.js";

const profile = await detectHardware();
const recommendation = recommendModel(profile);
const compatible = listCompatibleModels(profile);

console.log("=== MODEL RECOMMENDATION ===");
console.log(`Recommended: ${recommendation.displayName}`);
console.log(`Reason: ${recommendation.reason}`);
console.log(`Quality: ${recommendation.quality}`);
console.log(`Ollama tag: ${recommendation.ollamaTag}`);
console.log(`HF repo: ${recommendation.hfRepo}`);
console.log(`Recommended quant: ${recommendation.recommendedQuant}`);
console.log("");
console.log(`Compatible models (${compatible.length} total):`);
for (const model of compatible) {
  console.log(`  - ${model.displayName} (${model.quality})`);
}

if (!recommendation.model) {
  throw new Error("FAIL: recommendation.model is empty");
}
if (!recommendation.hfRepo) {
  throw new Error("FAIL: hfRepo not populated");
}
if (compatible.length === 0) {
  throw new Error("FAIL: no compatible models returned");
}

console.log("✅ Model recommendation PASSED");
