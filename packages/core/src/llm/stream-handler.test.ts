import { describe, expect, it } from "vitest";
import { parseNdjsonStream } from "./stream-handler.js";

// Helper: build a ReadableStreamDefaultReader from NDJSON lines
function mockNdjsonReader(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  let consumed = false;
  return {
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: encoder.encode(payload) };
    },
    releaseLock: () => {},
    cancel: async () => {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe("parseNdjsonStream", () => {
  it("parses text-only streaming chunks", async () => {
    const reader = mockNdjsonReader([
      '{"message":"Hello"}',
      '{"message":" world"}',
      '{"done":true}',
    ]);
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of parseNdjsonStream<Record<string, unknown>>(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0].message).toBe("Hello");
    expect(chunks[1].message).toBe(" world");
    expect(chunks[2].done).toBe(true);
  });

  it("handles malformed JSON lines if loggerName is provided", async () => {
    const reader = mockNdjsonReader(['{"valid":true}', "invalid json", '{"still": "valid"}']);
    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of parseNdjsonStream<Record<string, unknown>>(reader, {
      loggerName: "test",
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].valid).toBe(true);
    expect(chunks[1].still).toBe("valid");
  });

  it("handles trailing data", async () => {
    const encoder = new TextEncoder();
    const payload = '{"trailing": true}';
    let consumed = false;
    const reader = {
      read: async () => {
        if (consumed) {
          return { done: true as const, value: undefined };
        }
        consumed = true;
        return { done: false as const, value: encoder.encode(payload) };
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const chunks: Record<string, unknown>[] = [];
    for await (const chunk of parseNdjsonStream<Record<string, unknown>>(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trailing).toBe(true);
  });
});
