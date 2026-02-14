import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const prowlDir = path.join(os.homedir(), ".prowl");

console.log("=== PROWL DATA DIRECTORY ===");
console.log(`Location: ${prowlDir}`);
console.log("");

async function checkFile(filePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const content = await fs.readFile(filePath, "utf8");
    const preview = content.slice(0, 120).replace(/\n/g, " ");
    console.log(`✅ ${label}: ${(stat.size / 1024).toFixed(1)}KB`);
    console.log(`   Preview: ${preview}...`);
  } catch {
    console.log(`❌ ${label}: NOT FOUND at ${filePath}`);
  }
}

await checkFile(path.join(prowlDir, "config.json"), "Config");
await checkFile(path.join(prowlDir, "analytics", "inferences.jsonl"), "Inferences log");
await checkFile(path.join(prowlDir, "analytics", "totals.json"), "Analytics totals");
await checkFile(path.join(prowlDir, "privacy", "audit.jsonl"), "Privacy audit");
await checkFile(path.join(prowlDir, "privacy", "stats.json"), "Privacy stats");

console.log("");

try {
  const configRaw = await fs.readFile(path.join(prowlDir, "config.json"), "utf8");
  const config = JSON.parse(configRaw);
  const required = ["model", "ollamaUrl", "installedAt", "prowlVersion"];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    console.log(`⚠️  config.json missing fields: ${missing.join(", ")}`);
  } else {
    console.log("✅ config.json structure valid");
    console.log(`   Active model: ${config.model}`);
    console.log(`   Ollama URL: ${config.ollamaUrl}`);
    console.log(`   Prowl version: ${config.prowlVersion}`);
  }
} catch {
  console.log("❌ config.json invalid or missing — run check-installer.ts first");
}
