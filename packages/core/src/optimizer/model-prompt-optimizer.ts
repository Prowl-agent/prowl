export type OptimizerTaskType = "chat" | "code" | "agent" | "tool" | "unknown";
export type ModelTier = "small" | "medium" | "large";
export type TruncationStrategy = "recent-first" | "head-tail" | "balanced";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OptimizedMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SamplingSettings {
  temperature: number;
  topP: number;
  maxOutputTokens: number;
}

export interface OptimizeModelPromptParams {
  model: string;
  taskType: OptimizerTaskType;
  userPrompt: string;
  systemPrompt?: string;
  conversationHistory?: HistoryMessage[];
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  truncationStrategy?: TruncationStrategy;
}

export interface ContextOptimizationStats {
  contextWindowTokens: number;
  inputBudgetTokens: number;
  beforeTokens: number;
  afterTokens: number;
  droppedMessages: number;
  truncated: boolean;
  strategy: TruncationStrategy;
}

export interface OptimizedPromptResult {
  modelTier: ModelTier;
  systemPrompt: string;
  userPrompt: string;
  conversationHistory: HistoryMessage[];
  messages: OptimizedMessage[];
  sampling: SamplingSettings;
  context: ContextOptimizationStats;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;
const DEFAULT_RESERVED_OUTPUT_TOKENS = 1_024;
const MIN_INPUT_BUDGET_TOKENS = 256;

const MAX_SYSTEM_TOKENS_BY_TIER: Record<ModelTier, number> = {
  small: 180,
  medium: 300,
  large: 420,
};

const BASE_SAMPLING_BY_TASK: Record<OptimizerTaskType, SamplingSettings> = {
  chat: { temperature: 0.65, topP: 0.9, maxOutputTokens: 768 },
  code: { temperature: 0.2, topP: 0.95, maxOutputTokens: 1_024 },
  agent: { temperature: 0.35, topP: 0.9, maxOutputTokens: 1_536 },
  tool: { temperature: 0.1, topP: 0.8, maxOutputTokens: 512 },
  unknown: { temperature: 0.4, topP: 0.9, maxOutputTokens: 768 },
};

const TEMPLATE_BY_TIER_AND_TASK: Record<ModelTier, Record<OptimizerTaskType, string>> = {
  small: {
    chat: [
      "You are a concise assistant running on a small local model.",
      "Rules:",
      "1) Answer directly.",
      "2) Keep responses short and clear.",
      '3) If uncertain, say "I do not know".',
      "Format:",
      "- Answer: <response>",
    ].join("\n"),
    code: [
      "You are a coding assistant on a small local model.",
      "Rules:",
      "1) Prefer minimal, working edits.",
      "2) Avoid long explanations unless asked.",
      "3) Highlight assumptions briefly.",
      "Format:",
      "1) Plan",
      "2) Code",
      "3) Verify",
    ].join("\n"),
    agent: [
      "You are an autonomous task assistant on a small local model.",
      "Rules:",
      "1) Break work into small steps.",
      "2) Keep tool instructions explicit.",
      "3) Return a short final status.",
      "Format:",
      "1) Goal",
      "2) Steps",
      "3) Result",
    ].join("\n"),
    tool: [
      "You are a tool-use assistant on a small local model.",
      "Rules:",
      "1) Pick the simplest valid tool action.",
      "2) Use exact arguments only.",
      "3) Report result tersely.",
      "Format:",
      "1) Action",
      "2) Inputs",
      "3) Output",
    ].join("\n"),
    unknown: [
      "You are a concise assistant on a small local model.",
      "Use short, structured answers and explicit assumptions.",
    ].join("\n"),
  },
  medium: {
    chat: [
      "You are a helpful local assistant.",
      "Prefer accurate, practical answers with concise structure.",
    ].join("\n"),
    code: [
      "You are a senior software assistant.",
      "Provide robust implementation guidance and short verification steps.",
    ].join("\n"),
    agent: [
      "You are an autonomous task assistant.",
      "Plan before action, then report outcomes and blockers clearly.",
    ].join("\n"),
    tool: [
      "You are a precise tool-use assistant.",
      "Choose correct tools and keep outputs compact and reproducible.",
    ].join("\n"),
    unknown: [
      "You are a practical local assistant.",
      "Favor clarity, correctness, and actionable responses.",
    ].join("\n"),
  },
  large: {
    chat: [
      "You are an expert assistant.",
      "Answer with depth when needed and summarize key decisions.",
    ].join("\n"),
    code: [
      "You are an expert software engineer.",
      "Deliver technically rigorous, testable solutions with tradeoffs.",
    ].join("\n"),
    agent: [
      "You are an expert autonomous problem-solver.",
      "Use explicit reasoning, staged execution, and clear outcome tracking.",
    ].join("\n"),
    tool: [
      "You are an expert tool orchestrator.",
      "Use reliable actions, validate outputs, and report residual risk.",
    ].join("\n"),
    unknown: [
      "You are an expert assistant.",
      "Balance completeness with direct, actionable answers.",
    ].join("\n"),
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function extractModelSizeInBillions(model: string): number | null {
  const match = model.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveModelTier(model: string): ModelTier {
  const normalized = model.trim().toLowerCase();
  const size = extractModelSizeInBillions(normalized);

  if (size !== null) {
    if (size <= 8) {
      return "small";
    }
    if (size <= 24) {
      return "medium";
    }
    return "large";
  }

  if (normalized.includes("tiny") || normalized.includes("mini") || normalized.includes("small")) {
    return "small";
  }
  if (normalized.includes("70b") || normalized.includes("72b") || normalized.includes("large")) {
    return "large";
  }
  return "medium";
}

export function estimatePromptTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

function detectContextWindowFromModel(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  const explicit = normalized.match(/(\d+)\s*k\b/);
  if (explicit) {
    const size = Number(explicit[1]);
    if (Number.isFinite(size) && size >= 4 && size <= 1_000) {
      return size * 1_000;
    }
  }

  if (normalized.includes("8k")) {
    return 8_192;
  }
  if (normalized.includes("16k")) {
    return 16_384;
  }
  if (normalized.includes("32k")) {
    return 32_768;
  }
  if (normalized.includes("64k")) {
    return 65_536;
  }
  if (normalized.includes("128k")) {
    return 128_000;
  }
  return null;
}

function resolveContextWindowTokens(model: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const detected = detectContextWindowFromModel(model);
  if (detected) {
    return detected;
  }

  const tier = resolveModelTier(model);
  if (tier === "small") {
    return 8_192;
  }
  if (tier === "medium") {
    return 16_384;
  }
  return 32_768;
}

function resolveTruncationStrategy(
  contextWindowTokens: number,
  explicit?: TruncationStrategy,
): TruncationStrategy {
  if (explicit) {
    return explicit;
  }
  if (contextWindowTokens <= 8_192) {
    return "head-tail";
  }
  return "recent-first";
}

function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  strategy: TruncationStrategy,
): string {
  if (tokenBudget <= 0) {
    return "";
  }
  if (estimatePromptTokens(text) <= tokenBudget) {
    return text;
  }

  const marker = "\n...[truncated]...\n";
  const maxChars = Math.max(0, Math.floor(tokenBudget * 4));
  if (maxChars <= marker.length) {
    return text.slice(-maxChars);
  }

  if (strategy === "recent-first") {
    const tailChars = maxChars - marker.length;
    return `${marker}${text.slice(-tailChars)}`;
  }

  const ratio = strategy === "balanced" ? 0.5 : 0.55;
  const headChars = Math.floor((maxChars - marker.length) * ratio);
  const tailChars = maxChars - marker.length - headChars;
  const combined = `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(0, maxChars);
}

function normalizeHistory(history: HistoryMessage[] | undefined): HistoryMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? "").trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function tokenCountForHistory(history: HistoryMessage[]): number {
  return history.reduce((total, message) => total + estimatePromptTokens(message.content), 0);
}

function truncateHistoryRecentFirst(
  history: HistoryMessage[],
  tokenBudget: number,
): HistoryMessage[] {
  if (tokenBudget <= 0 || history.length === 0) {
    return [];
  }

  let used = 0;
  const keptReverse: HistoryMessage[] = [];

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) {
      continue;
    }
    const tokens = estimatePromptTokens(message.content);
    if (tokens <= 0) {
      continue;
    }
    if (used + tokens <= tokenBudget) {
      keptReverse.push(message);
      used += tokens;
      continue;
    }

    if (keptReverse.length === 0 && used < tokenBudget) {
      const remaining = tokenBudget - used;
      const truncated = truncateTextToTokenBudget(message.content, remaining, "recent-first");
      if (truncated) {
        keptReverse.push({ ...message, content: truncated });
      }
    }
    break;
  }

  return keptReverse.toReversed();
}

function truncateHistoryHeadTail(
  history: HistoryMessage[],
  tokenBudget: number,
  headRatio: number,
): HistoryMessage[] {
  if (tokenBudget <= 0 || history.length === 0) {
    return [];
  }

  const clampedHeadRatio = clamp(headRatio, 0.1, 0.9);
  const earlyBudget = Math.floor(tokenBudget * clampedHeadRatio);
  const lateBudget = tokenBudget - earlyBudget;
  const selected = new Map<number, HistoryMessage>();
  let usedEarly = 0;
  let usedLate = 0;

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!message) {
      continue;
    }
    const tokens = estimatePromptTokens(message.content);
    if (tokens <= 0 || usedEarly + tokens > earlyBudget) {
      break;
    }
    selected.set(index, message);
    usedEarly += tokens;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) {
      continue;
    }
    const message = history[index];
    if (!message) {
      continue;
    }
    const tokens = estimatePromptTokens(message.content);
    if (tokens <= 0 || usedLate + tokens > lateBudget) {
      continue;
    }
    selected.set(index, message);
    usedLate += tokens;
  }

  const selectedTokens = Array.from(selected.values()).reduce(
    (total, message) => total + estimatePromptTokens(message.content),
    0,
  );
  let remaining = tokenBudget - selectedTokens;
  if (remaining > 0) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (selected.has(index)) {
        continue;
      }
      const message = history[index];
      if (!message) {
        continue;
      }
      const tokens = estimatePromptTokens(message.content);
      if (tokens <= 0 || tokens > remaining) {
        continue;
      }
      selected.set(index, message);
      remaining -= tokens;
      if (remaining <= 0) {
        break;
      }
    }
  }

  const orderedIndices = [...selected.keys()].toSorted((a, b) => a - b);
  if (orderedIndices.length === 0) {
    const latest = history[history.length - 1];
    if (!latest) {
      return [];
    }
    return [
      {
        ...latest,
        content: truncateTextToTokenBudget(latest.content, tokenBudget, "recent-first"),
      },
    ];
  }
  const orderedMessages: HistoryMessage[] = [];
  for (const index of orderedIndices) {
    const message = selected.get(index);
    if (message) {
      orderedMessages.push(message);
    }
  }
  return orderedMessages;
}

function truncateHistory(
  history: HistoryMessage[],
  tokenBudget: number,
  strategy: TruncationStrategy,
): HistoryMessage[] {
  if (strategy === "recent-first") {
    return truncateHistoryRecentFirst(history, tokenBudget);
  }
  if (strategy === "balanced") {
    return truncateHistoryHeadTail(history, tokenBudget, 0.4);
  }
  return truncateHistoryHeadTail(history, tokenBudget, 0.3);
}

function buildTemplate(taskType: OptimizerTaskType, tier: ModelTier): string {
  return TEMPLATE_BY_TIER_AND_TASK[tier][taskType];
}

function mergeSystemPrompt(params: {
  template: string;
  additionalSystemPrompt?: string;
  tier: ModelTier;
  strategy: TruncationStrategy;
}): string {
  const base = params.template.trim();
  const userSystem = params.additionalSystemPrompt?.trim();
  if (!userSystem) {
    return base;
  }

  const extraBudget = params.tier === "small" ? 160 : params.tier === "medium" ? 260 : 360;
  const normalizedExtra = truncateTextToTokenBudget(userSystem, extraBudget, params.strategy);
  if (!normalizedExtra) {
    return base;
  }

  return `${base}\n\nAdditional requirements:\n${normalizedExtra}`;
}

export function optimizeSamplingSettings(params: {
  taskType: OptimizerTaskType;
  modelTier: ModelTier;
  contextWindowTokens?: number;
}): SamplingSettings {
  const base = BASE_SAMPLING_BY_TASK[params.taskType];
  let temperature = base.temperature;
  let topP = base.topP;
  let maxOutputTokens = base.maxOutputTokens;

  if (params.modelTier === "small") {
    temperature -= 0.1;
    topP -= 0.05;
    maxOutputTokens = Math.min(maxOutputTokens, 1_024);
  } else if (params.modelTier === "large" && params.taskType === "chat") {
    temperature += 0.05;
  }

  if (typeof params.contextWindowTokens === "number" && params.contextWindowTokens <= 8_192) {
    maxOutputTokens = Math.min(maxOutputTokens, 896);
  }

  return {
    temperature: clamp(Number(temperature.toFixed(2)), 0, 1),
    topP: clamp(Number(topP.toFixed(2)), 0.1, 1),
    maxOutputTokens: Math.max(128, Math.floor(maxOutputTokens)),
  };
}

export function optimizeModelPrompt(params: OptimizeModelPromptParams): OptimizedPromptResult {
  const contextWindowTokens = resolveContextWindowTokens(params.model, params.contextWindowTokens);
  const strategy = resolveTruncationStrategy(contextWindowTokens, params.truncationStrategy);
  const tier = resolveModelTier(params.model);
  const history = normalizeHistory(params.conversationHistory);
  const template = buildTemplate(params.taskType, tier);

  let systemPrompt = mergeSystemPrompt({
    template,
    additionalSystemPrompt: params.systemPrompt,
    tier,
    strategy,
  });
  const maxSystemTokens = MAX_SYSTEM_TOKENS_BY_TIER[tier];
  systemPrompt = truncateTextToTokenBudget(systemPrompt, maxSystemTokens, strategy);

  const rawUserPrompt = String(params.userPrompt ?? "").trim();
  let userPrompt = rawUserPrompt;

  const reservedOutputTokens =
    typeof params.reservedOutputTokens === "number" &&
    Number.isFinite(params.reservedOutputTokens) &&
    params.reservedOutputTokens > 0
      ? Math.floor(params.reservedOutputTokens)
      : DEFAULT_RESERVED_OUTPUT_TOKENS;
  const inputBudgetTokens = Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    contextWindowTokens - clamp(reservedOutputTokens, 128, Math.floor(contextWindowTokens * 0.7)),
  );

  const beforeTokens =
    estimatePromptTokens(systemPrompt) +
    estimatePromptTokens(userPrompt) +
    tokenCountForHistory(history);

  let systemTokens = estimatePromptTokens(systemPrompt);
  let userTokens = estimatePromptTokens(userPrompt);

  if (systemTokens + userTokens > inputBudgetTokens) {
    const userBudget = Math.max(64, inputBudgetTokens - systemTokens);
    userPrompt = truncateTextToTokenBudget(userPrompt, userBudget, strategy);
    userTokens = estimatePromptTokens(userPrompt);
  }

  if (systemTokens + userTokens > inputBudgetTokens) {
    const systemBudget = Math.max(48, inputBudgetTokens - userTokens);
    systemPrompt = truncateTextToTokenBudget(systemPrompt, systemBudget, strategy);
    systemTokens = estimatePromptTokens(systemPrompt);
  }

  if (systemTokens + userTokens > inputBudgetTokens) {
    const userBudget = Math.max(16, inputBudgetTokens - systemTokens);
    userPrompt = truncateTextToTokenBudget(userPrompt, userBudget, strategy);
    userTokens = estimatePromptTokens(userPrompt);
  }

  const historyBudget = Math.max(0, inputBudgetTokens - systemTokens - userTokens);
  const truncatedHistory = truncateHistory(history, historyBudget, strategy);
  const historyTokens = tokenCountForHistory(truncatedHistory);
  const afterTokens = systemTokens + userTokens + historyTokens;
  const droppedMessages = Math.max(0, history.length - truncatedHistory.length);
  const truncated =
    droppedMessages > 0 ||
    beforeTokens > afterTokens ||
    userPrompt !== rawUserPrompt ||
    historyBudget < tokenCountForHistory(history);

  const messages: OptimizedMessage[] = [
    { role: "system", content: systemPrompt },
    ...truncatedHistory,
    { role: "user", content: userPrompt },
  ];

  return {
    modelTier: tier,
    systemPrompt,
    userPrompt,
    conversationHistory: truncatedHistory,
    messages,
    sampling: optimizeSamplingSettings({
      taskType: params.taskType,
      modelTier: tier,
      contextWindowTokens,
    }),
    context: {
      contextWindowTokens,
      inputBudgetTokens,
      beforeTokens,
      afterTokens,
      droppedMessages,
      truncated,
      strategy,
    },
  };
}
