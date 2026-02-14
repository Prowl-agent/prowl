import { searchHuggingFace, selectBestQuant } from "../packages/core/src/models/hf-bridge.js";

console.log("=== HUGGINGFACE SEARCH (live network) ===");

try {
  const results = await searchHuggingFace("Qwen3-8B-GGUF", { limit: 3 });

  if (results.length === 0) {
    throw new Error("FAIL: no results returned from HuggingFace");
  }

  console.log(`Found ${results.length} repos:`);
  for (const result of results) {
    console.log(`  ${result.repoId} — ${result.files.length} GGUF files`);
    for (const file of result.files.slice(0, 3)) {
      const sizeGB = (file.sizeBytes / 1073741824).toFixed(1);
      console.log(`    ${file.filename} (${sizeGB}GB) quant: ${file.quantization}`);
    }
  }

  const firstRepo = results[0];
  if (firstRepo && firstRepo.files.length > 0) {
    const best = selectBestQuant(firstRepo.files, 14);
    console.log(`Best quant for 14GB available: ${best.filename}`);
    if (!best.filename) {
      throw new Error("FAIL: selectBestQuant returned no filename");
    }
  }

  console.log("✅ HuggingFace search PASSED");
} catch (error) {
  if (error instanceof Error && error.message.includes("fetch")) {
    console.log("⚠️  Network error — check internet connection");
  } else {
    throw error;
  }
}
