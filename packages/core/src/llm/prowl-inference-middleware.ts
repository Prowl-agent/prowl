/**
 * Prowl Inference Middleware
 *
 * Intercepts Ollama requests and applies the Model Prompt Optimizer before
 * they hit /api/chat. This is what makes small local models (qwen3:8b etc.)
 * actually work well for agent tasks.
 *
 * Architecture:
 *   User message → OpenClaw pipeline → THIS MIDDLEWARE → Ollama /api/chat
 *
 * What it does:
 *   1. Detects task type from the conversation (chat/code/agent/tool)
 *   2. Runs optimizeModelPrompt() to get tier-specific system prompts
 *   3. Sets optimal sampling parameters (temperature, top_p, num_predict)
 *   4. Sets num_ctx based on model context window
 *   5. Records completed inferences for cost tracking
 */

import { recordInference } from "../analytics/cost-tracker.js";
import {
  optimizeModelPrompt,
  resolveModelTier,
  type OptimizerTaskType,
  type OptimizedPromptResult,
} from "../optimizer/model-prompt-optimizer.js";
import { ModelSelector, type TaskWeight } from "./model-selector.js";
import { PromptCache } from "./prompt-cache.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface ProwlInferenceConfig {
  /** Model name, e.g. "qwen3:8b" */
  model: string;
  /** Ollama base URL used to query loaded models */
  ollamaUrl: string;
  /** Whether the optimizer is enabled. Disable via PROWL_DISABLE_OPTIMIZER=true */
  enableOptimizer: boolean;
  /** Whether cost tracking is enabled. Disable via PROWL_DISABLE_COST_TRACKING=true */
  enableCostTracking: boolean;
}

export function createProwlInferenceConfig(
  model?: string,
  ollamaUrl?: string,
): ProwlInferenceConfig {
  return {
    model: model ?? process.env.PROWL_DEFAULT_CHAT_MODEL ?? "qwen3:8b",
    ollamaUrl: ollamaUrl ?? process.env.PROWL_OLLAMA_URL ?? "http://127.0.0.1:11434",
    enableOptimizer: process.env.PROWL_DISABLE_OPTIMIZER !== "true",
    enableCostTracking: process.env.PROWL_DISABLE_COST_TRACKING !== "true",
  };
}

// ── Ollama request options (subset relevant to optimizer) ───────────────────

export interface OllamaOptimizedOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  num_ctx?: number;
}

// ── Ollama message format (matches ollama-stream.ts) ────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: unknown[];
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

// ── Task type detection ─────────────────────────────────────────────────────

const CODE_SIGNALS = [
  "write code",
  "fix this",
  "debug",
  "function",
  "class",
  "implement",
  "refactor",
  "typescript",
  "python",
  "javascript",
  "```",
  "error:",
  "traceback",
  "compile",
  "build",
];

const AGENT_SIGNALS = [
  "search for",
  "find and",
  "create a file",
  "run this",
  "step by step",
  "first do",
  "then do",
  "automate",
];

export function detectTaskType(userContent: string, tools?: OllamaTool[]): OptimizerTaskType {
  // Tool use if tools are provided
  if (tools && tools.length > 0) {
    return "tool";
  }

  const lower = userContent.toLowerCase();

  if (CODE_SIGNALS.some((s) => lower.includes(s))) {
    return "code";
  }
  if (AGENT_SIGNALS.some((s) => lower.includes(s))) {
    return "agent";
  }

  return "chat";
}

// ── Middleware class ────────────────────────────────────────────────────────

export interface OptimizeResult {
  messages: OllamaMessage[];
  options: OllamaOptimizedOptions;
  selectedModel: string;
  modelReason: string;
  taskWeight: TaskWeight;
  taskType: OptimizerTaskType;
  optimizerResult?: OptimizedPromptResult;
  /** Whether the system prompt + tool schemas were served from cache. */
  promptCacheHit?: boolean;
}

export class ProwlInferenceMiddleware {
  private config: ProwlInferenceConfig;
  private modelSelector: ModelSelector;
  private selectorPreferredModel: string;
  private requestCount = 0;
  private promptCache = new PromptCache();

  constructor(config: ProwlInferenceConfig) {
    this.config = config;
    this.modelSelector = new ModelSelector(config.model, config.ollamaUrl);
    this.selectorPreferredModel = config.model;
  }

  /**
   * Optimize the Ollama request. Call this BEFORE building the request body.
   *
   * Takes the already-converted OllamaMessages and tools, runs the optimizer,
   * and returns optimized messages + Ollama options to merge into the request.
   */
  async optimizeRequest(
    modelId: string,
    messages: OllamaMessage[],
    tools?: OllamaTool[],
    conversationLength?: number,
  ): Promise<OptimizeResult> {
    this.refreshSelectorModel(modelId);

    // Extract system prompt, user prompt, and conversation history
    const systemMsg = messages.find((m) => m.role === "system");
    const lastUserMsg = messages.toReversed().find((m) => m.role === "user");
    const taskType = detectTaskType(lastUserMsg?.content || "", tools);
    const taskWeight = this.modelSelector.classifyTaskWeight(
      lastUserMsg?.content || "",
      tools,
      conversationLength,
    );
    const selection = await this.modelSelector.select(taskWeight);

    if (!this.config.enableOptimizer) {
      this.requestCount++;
      return {
        messages: [...messages],
        options: {},
        selectedModel: selection.model,
        modelReason: selection.reason,
        taskWeight,
        taskType,
      };
    }

    // Build conversation history from non-system, non-tool messages
    // (excluding the last user message which becomes userPrompt)
    const history = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m !== lastUserMsg)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Use prompt cache to avoid re-serializing tool schemas and rebuilding
    // the system prompt template when model + tools haven't changed between turns.
    const cached = this.promptCache.getOrBuild(
      selection.model,
      () => systemMsg?.content ?? "",
      tools,
    );

    // Run the optimizer
    const optimized = optimizeModelPrompt({
      model: selection.model,
      taskType,
      userPrompt: lastUserMsg?.content || "",
      systemPrompt: systemMsg?.content,
      conversationHistory: history,
    });

    // Rebuild messages from optimizer output
    const optimizedMessages: OllamaMessage[] = optimized.messages.map((m) => ({
      role: m.role as OllamaMessage["role"],
      content: m.content,
    }));

    // Re-attach tool messages from original (they're not in the optimizer output)
    for (const msg of messages) {
      if (msg.role === "tool") {
        optimizedMessages.push(msg);
      }
    }

    // Build Ollama options from optimizer sampling settings
    const options: OllamaOptimizedOptions = {
      temperature: optimized.sampling.temperature,
      top_p: optimized.sampling.topP,
      num_predict: optimized.sampling.maxOutputTokens,
      num_ctx: optimized.context.contextWindowTokens,
    };

    this.requestCount++;

    return {
      messages: optimizedMessages,
      options,
      selectedModel: selection.model,
      modelReason: selection.reason,
      taskWeight,
      taskType,
      optimizerResult: optimized,
      promptCacheHit: cached.wasCached,
    };
  }

  /**
   * Record a completed inference for cost tracking.
   * Call this AFTER receiving the final response from Ollama.
   * Best-effort — never throws.
   */
  async recordCompletion(
    promptTokens: number,
    completionTokens: number,
    durationMs: number,
    tokensPerSecond: number,
    taskType: OptimizerTaskType = "unknown",
    model?: string,
  ): Promise<void> {
    if (!this.config.enableCostTracking) {
      return;
    }

    try {
      await recordInference({
        localModel: model || this.config.model,
        promptTokens,
        completionTokens,
        durationMs,
        tokensPerSecond,
        taskType,
      });
    } catch {
      // Cost tracking failure should never break inference
    }
  }

  get stats() {
    return {
      requestCount: this.requestCount,
      model: this.config.model,
      tier: resolveModelTier(this.config.model),
    };
  }

  private refreshSelectorModel(modelId: string): void {
    if (modelId === this.selectorPreferredModel) {
      return;
    }
    this.selectorPreferredModel = modelId;
    this.modelSelector = new ModelSelector(modelId, this.config.ollamaUrl);
  }
}
