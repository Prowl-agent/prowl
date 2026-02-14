import { describe, expect, it } from "vitest";
import type { HFGGUFFile } from "./hf-bridge.js";
import { selectBestQuant } from "./hf-bridge.js";

const GB = 1024 ** 3;

function makeFile(filename: string, sizeGb: number, quantization: string): HFGGUFFile {
  return {
    filename,
    sizeBytes: sizeGb * GB,
    quantization,
    downloadUrl: `https://example.invalid/${filename}`,
  };
}

describe("selectBestQuant", () => {
  const files: HFGGUFFile[] = [
    makeFile("model-Q8_0.gguf", 9, "Q8_0"),
    makeFile("model-Q6_K.gguf", 7, "Q6_K"),
    makeFile("model-Q5_K_M.gguf", 6, "Q5_K_M"),
    makeFile("model-Q4_K_M.gguf", 5, "Q4_K_M"),
  ];

  it("picks the highest scoring quantization that fits available RAM", () => {
    expect(selectBestQuant(files, 10).quantization).toBe("Q6_K");
    expect(selectBestQuant(files, 8).quantization).toBe("Q5_K_M");
  });

  it("throws when no quantization fits", () => {
    expect(() => selectBestQuant(files, 3)).toThrowError(/Minimum RAM needed/i);
  });
});
