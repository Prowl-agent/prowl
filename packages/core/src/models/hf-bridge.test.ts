import { afterEach, describe, expect, it, vi } from "vitest";
import type { HFGGUFFile } from "./hf-bridge.js";
import { installFromHuggingFace, searchHuggingFace, selectBestQuant } from "./hf-bridge.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hugging Face repo path encoding", () => {
  it("searchHuggingFace requests model details without encoding the owner/repo slash", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/models?")) {
        return new Response(JSON.stringify([{ id: "owner/repo" }]), { status: 200 });
      }
      if (url.endsWith("/api/models/owner/repo")) {
        return new Response(
          JSON.stringify({
            id: "owner/repo",
            siblings: [{ rfilename: "model-Q4_K_M.gguf", size: GB }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: `unexpected url: ${url}` }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHuggingFace("repo", { limit: 1, filterGGUF: true });

    expect(results).toHaveLength(1);
    const detailCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/api/models/owner/repo"));
    expect(detailCall).toBeDefined();
    expect(detailCall).not.toContain("%2F");
  });

  it("searchHuggingFace fills missing GGUF sizes from repo tree metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/models?")) {
        return new Response(JSON.stringify([{ id: "owner/repo" }]), { status: 200 });
      }
      if (url.endsWith("/api/models/owner/repo")) {
        return new Response(
          JSON.stringify({
            id: "owner/repo",
            siblings: [{ rfilename: "model-q4_k_m.gguf" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/models/owner/repo/tree/main?recursive=1")) {
        return new Response(
          JSON.stringify([
            {
              type: "file",
              path: "model-q4_k_m.gguf",
              lfs: { size: GB },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: `unexpected url: ${url}` }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [result] = await searchHuggingFace("repo", { limit: 1, filterGGUF: true });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.sizeBytes).toBe(GB);
    expect(
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .some((url) => url.includes("/api/models/owner/repo/tree/main?recursive=1")),
    ).toBe(true);
  });

  it("installFromHuggingFace uses slash-preserving repo detail path", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/models/owner/repo")) {
        return new Response(
          JSON.stringify({
            id: "owner/repo",
            siblings: [],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: `unexpected url: ${url}` }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await installFromHuggingFace("owner/repo", 8, () => undefined);

    expect(result.success).toBe(false);
    const detailCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/api/models/owner/repo"));
    expect(detailCall).toBeDefined();
    expect(detailCall).not.toContain("%2F");
  });
});
