import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
import {
  ProwlInferenceMiddleware,
  createProwlInferenceConfig,
} from "../../packages/core/src/llm/prowl-inference-middleware.js";
import { parseNdjsonStream } from "../../packages/core/src/llm/stream-handler.js";
import {
  readWarmupConfig,
  buildKeepAliveParam,
} from "../../packages/core/src/perf/model-warmup.js";
import {
  createPerfTrace,
  finalizePerfTrace,
  logPerfTrace,
  type OllamaTimings,
} from "../../packages/core/src/perf/perf-trace.js";

// ── Prowl prompt optimizer (singleton, lazy init) ───────────────────────────
let prowlMiddleware: ProwlInferenceMiddleware | null = null;
let prowlMiddlewareBaseUrl: string | null = null;
function getProwlMiddleware(ollamaBaseUrl: string): ProwlInferenceMiddleware {
  if (!prowlMiddleware || prowlMiddlewareBaseUrl !== ollamaBaseUrl) {
    prowlMiddleware = new ProwlInferenceMiddleware(
      createProwlInferenceConfig(undefined, ollamaBaseUrl),
    );
    prowlMiddlewareBaseUrl = ollamaBaseUrl;
  }
  return prowlMiddleware;
}

export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";

// ── Ollama /api/chat request types ──────────────────────────────────────────

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  keep_alive?: string;
  /** Disable Qwen3/DeepSeek-R1 internal thinking mode to avoid hidden token waste. */
  think?: boolean;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

// ── Ollama /api/chat response types ─────────────────────────────────────────

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ── Message conversion ──────────────────────────────────────────────────────

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractOllamaImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "image"; data: string } => part.type === "image")
    .map((part) => part.data);
}

function extractToolCalls(content: unknown): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: OllamaToolCall[] = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({ function: { name: part.name, arguments: part.arguments } });
    } else if (part.type === "tool_use") {
      result.push({ function: { name: part.name, arguments: part.input } });
    }
  }
  return result;
}

export function convertToOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    const { role } = msg;

    if (role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool" || role === "toolResult") {
      // SDK uses "toolResult" (camelCase) for tool result messages.
      // Ollama API expects "tool" role with tool_name per the native spec.
      const text = extractTextContent(msg.content);
      const toolName =
        typeof (msg as { toolName?: unknown }).toolName === "string"
          ? (msg as { toolName?: string }).toolName
          : undefined;
      result.push({
        role: "tool",
        content: text,
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }

  return result;
}

// ── Tool extraction ─────────────────────────────────────────────────────────

function extractOllamaTools(tools: Tool[] | undefined): OllamaTool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: OllamaTool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: (tool.parameters ?? {}) as Record<string, unknown>,
      },
    });
  }
  return result;
}

// ── Response conversion ─────────────────────────────────────────────────────

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [];

  if (response.message.content) {
    content.push({ type: "text", text: response.message.content });
  }

  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall",
        id: `ollama_call_${randomUUID()}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const stopReason: StopReason = hasToolCalls ? "toolUse" : "stop";

  const usage: Usage = {
    input: response.prompt_eval_count ?? 0,
    output: response.eval_count ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage,
    timestamp: Date.now(),
  };
}

// ── Main StreamFn factory ───────────────────────────────────────────────────

function resolveOllamaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalizedBase = trimmed.replace(/\/v1$/i, "");
  return normalizedBase || OLLAMA_NATIVE_BASE_URL;
}

function resolveOllamaChatUrl(baseUrl: string): string {
  const apiBase = resolveOllamaBaseUrl(baseUrl);
  return `${apiBase}/api/chat`;
}

export function createOllamaStreamFn(baseUrl: string): StreamFn {
  const ollamaBaseUrl = resolveOllamaBaseUrl(baseUrl);
  const chatUrl = resolveOllamaChatUrl(baseUrl);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    let selectedModelId = model.id;

    const run = async () => {
      try {
        let ollamaMessages = convertToOllamaMessages(context.messages ?? [], context.systemPrompt);

        const ollamaTools = extractOllamaTools(context.tools);
        selectedModelId = model.id;

        // ── Prowl optimizer + model selection ───────────────────────────────
        const optimized = await getProwlMiddleware(ollamaBaseUrl).optimizeRequest(
          model.id,
          ollamaMessages,
          ollamaTools.length > 0 ? ollamaTools : undefined,
          context.messages?.length,
        );
        let detectedTaskType: string = "unknown";

        // Smart context sizing: allocate only what's needed instead of 64K.
        // Reverted to safe static cap (8192) to prevent potential Ollama hangs/reloads.
        // const contextConfig = readContextConfig();
        // const estimatedTokenCount = estimateMessageTokens(
        //   context.messages ?? [],
        //   context.systemPrompt,
        // );
        // const maxOutput = typeof options?.maxTokens === "number" ? options.maxTokens : 4096;
        // const numCtx = computeNumCtx(
        //   estimatedTokenCount,
        //   maxOutput,
        //   contextConfig,
        //   model.contextWindow,
        // );

        // Use optimizer-resolved context window when available, else safe static default.
        let numCtx = 8192;
        const ollamaOptions: Record<string, unknown> = { num_ctx: numCtx };

        ollamaMessages = optimized.messages as OllamaChatMessage[];
        detectedTaskType = optimized.taskType;
        selectedModelId = optimized.selectedModel;
        // Merge optimizer sampling params
        if (optimized.options.temperature !== undefined) {
          ollamaOptions.temperature = optimized.options.temperature;
        }
        if (optimized.options.top_p !== undefined) {
          ollamaOptions.top_p = optimized.options.top_p;
        }
        if (optimized.options.num_predict !== undefined) {
          ollamaOptions.num_predict = optimized.options.num_predict;
        }
        if (optimized.options.num_ctx !== undefined) {
          numCtx = optimized.options.num_ctx;
          ollamaOptions.num_ctx = numCtx;
        }

        const trace = createPerfTrace(selectedModelId, chatUrl);
        trace.numCtx = numCtx;

        // Caller overrides take precedence over optimizer defaults
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }

        // Keep-alive: tell Ollama to keep the model loaded.
        const warmupConfig = readWarmupConfig();
        const keepAlive = buildKeepAliveParam(warmupConfig);

        const body: OllamaChatRequest = {
          model: selectedModelId,
          messages: ollamaMessages,
          stream: true,
          ...(ollamaTools.length > 0 ? { tools: ollamaTools } : {}),
          options: ollamaOptions,
          // Disable Qwen3/DeepSeek-R1 internal "thinking" mode.
          // Without this, qwen3:8b generates 150-2000 hidden reasoning tokens
          // before producing any visible response (~20s for "say hi" vs ~4s).
          think: false,
          ...(keepAlive ? { keep_alive: keepAlive } : {}),
        };

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...options?.headers,
        };
        if (options?.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Ollama API error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();
        let accumulatedContent = "";
        const accumulatedToolCalls: OllamaToolCall[] = [];
        let finalResponse: OllamaChatResponse | undefined;
        let firstTokenAt = 0;
        let textStreamStarted = false;
        const contentIndex = 0;

        // Build a partial AssistantMessage that evolves as tokens stream in.
        const partial: AssistantMessage = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: selectedModelId,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as StopReason,
          timestamp: Date.now(),
        };

        // Push a start event so the UI knows the response has begun.
        stream.push({ type: "start", partial });

        for await (const chunk of parseNdjsonStream<OllamaChatResponse>(reader, {
          loggerName: "ollama-stream",
        })) {
          if (chunk.message?.content) {
            const delta = chunk.message.content;

            // First visible token — mark TTFT and emit text_start.
            if (!textStreamStarted && delta.length > 0) {
              firstTokenAt = Date.now();
              textStreamStarted = true;
              partial.content = [{ type: "text" as const, text: "" }];
              stream.push({ type: "text_start", contentIndex, partial });
            }

            // Stream each token to the UI immediately.
            accumulatedContent += delta;
            (partial.content[contentIndex] as TextContent).text = accumulatedContent;
            stream.push({ type: "text_delta", contentIndex, delta, partial });
          }

          // Ollama sends tool_calls in intermediate (done:false) chunks,
          // NOT in the final done:true chunk. Collect from all chunks.
          if (chunk.message?.tool_calls) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }

          if (chunk.done) {
            finalResponse = chunk;
            break;
          }
        }

        // Close the text stream if we started one.
        if (textStreamStarted) {
          stream.push({
            type: "text_end",
            contentIndex,
            content: accumulatedContent,
            partial,
          });
        }

        if (!finalResponse) {
          throw new Error("Ollama API stream ended without a final response");
        }

        finalResponse.message.content = accumulatedContent;
        if (accumulatedToolCalls.length > 0) {
          finalResponse.message.tool_calls = accumulatedToolCalls;
        }

        const assistantMessage = buildAssistantMessage(finalResponse, {
          api: model.api,
          provider: model.provider,
          id: selectedModelId,
        });

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop";

        // Log perf trace.
        const timings: OllamaTimings = {
          total_duration: finalResponse.total_duration,
          load_duration: finalResponse.load_duration,
          prompt_eval_count: finalResponse.prompt_eval_count,
          prompt_eval_duration: finalResponse.prompt_eval_duration,
          eval_count: finalResponse.eval_count,
          eval_duration: finalResponse.eval_duration,
        };
        const finalTrace = finalizePerfTrace(trace, timings, firstTokenAt, numCtx);
        logPerfTrace(finalTrace);

        // Record inference for Prowl cost analytics (best-effort, never throws).
        getProwlMiddleware(ollamaBaseUrl)
          .recordCompletion(
            finalResponse.prompt_eval_count ?? 0,
            finalResponse.eval_count ?? 0,
            finalTrace.totalMs,
            finalTrace.tokensPerSec,
            detectedTaskType as "chat" | "code" | "agent" | "tool" | "unknown",
            selectedModelId,
          )
          .catch(() => {});

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: selectedModelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
