import { describe, expect, it } from "vitest";
import type { DownloadProgress } from "./hf-bridge.js";
import { installFromHuggingFace, searchHuggingFace } from "./hf-bridge.js";

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

const LIVE =
  isTruthy(process.env.HF_BRIDGE_LIVE_TEST) ||
  isTruthy(process.env.LIVE) ||
  isTruthy(process.env.OPENCLAW_LIVE_TEST);

const REPO_ID = process.env.HF_BRIDGE_LIVE_REPO_ID?.trim() ?? "";
const QUERY = process.env.HF_BRIDGE_LIVE_QUERY?.trim() ?? REPO_ID.split("/").at(-1) ?? "";
const INSTALL_ENABLED = isTruthy(process.env.HF_BRIDGE_LIVE_INSTALL);
const AVAILABLE_RAM_GB = Number.parseFloat(process.env.HF_BRIDGE_LIVE_RAM_GB ?? "16");

const describeLive = LIVE && REPO_ID.length > 0 && QUERY.length > 0 ? describe : describe.skip;
const itInstall = INSTALL_ENABLED ? it : it.skip;

describeLive("hf-bridge live", () => {
  it("searches HuggingFace GGUF models with real API", async () => {
    const results = await searchHuggingFace(QUERY, { limit: 50, filterGGUF: true });
    const matched = results.find((entry) => entry.repoId.toLowerCase() === REPO_ID.toLowerCase());

    expect(matched).toBeDefined();
    expect(matched?.files.length ?? 0).toBeGreaterThan(0);
    expect(
      (matched?.files ?? []).some((file) => file.filename.toLowerCase().endsWith(".gguf")),
    ).toBe(true);
    expect((matched?.files ?? []).some((file) => file.sizeBytes > 0)).toBe(true);
  }, 120_000);

  itInstall(
    "installs model into Ollama end-to-end without mocks",
    async () => {
      const progressEvents: DownloadProgress[] = [];
      const result = await installFromHuggingFace(REPO_ID, AVAILABLE_RAM_GB, (progress) => {
        progressEvents.push(progress);
      });

      expect(result.success).toBe(true);
      expect(result.ollamaModelName.startsWith("hf-")).toBe(true);
      expect(result.modelPath.length).toBeGreaterThan(0);
      expect(result.benchmarkResult).toBeDefined();
      expect(result.benchmarkResult?.passed).toBe(true);
      expect(progressEvents.some((event) => event.phase === "registering")).toBe(true);
      expect(progressEvents.some((event) => event.phase === "benchmarking")).toBe(true);
      expect(progressEvents.some((event) => event.phase === "complete")).toBe(true);
    },
    1_800_000,
  );
});
