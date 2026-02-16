import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_API_BASE_URL,
  resolveOpenAiApiBaseUrl,
  resolveOpenAiAudioSpeechUrl,
  resolveOpenAiRealtimeWebSocketUrl,
} from "./openai-endpoints.js";

describe("openai endpoint helpers", () => {
  it("uses the OpenAI default base URL", () => {
    expect(resolveOpenAiApiBaseUrl()).toBe(DEFAULT_OPENAI_API_BASE_URL);
  });

  it("normalizes trailing slashes", () => {
    expect(resolveOpenAiApiBaseUrl("https://proxy.example/openai/v1///")).toBe(
      "https://proxy.example/openai/v1",
    );
  });

  it("builds OpenAI-compatible audio speech URL", () => {
    expect(resolveOpenAiAudioSpeechUrl("https://proxy.example/openai/v1")).toBe(
      "https://proxy.example/openai/v1/audio/speech",
    );
  });

  it("builds realtime WebSocket URL for https base URLs", () => {
    expect(resolveOpenAiRealtimeWebSocketUrl("https://proxy.example/openai/v1")).toBe(
      "wss://proxy.example/openai/v1/realtime?intent=transcription",
    );
  });

  it("builds realtime WebSocket URL for http base URLs", () => {
    expect(resolveOpenAiRealtimeWebSocketUrl("http://127.0.0.1:8080/v1")).toBe(
      "ws://127.0.0.1:8080/v1/realtime?intent=transcription",
    );
  });

  it("throws on invalid URLs", () => {
    expect(() => resolveOpenAiApiBaseUrl("not-a-url")).toThrow("Invalid OpenAI base URL");
  });
});
