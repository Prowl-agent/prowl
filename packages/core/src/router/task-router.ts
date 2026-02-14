import { CLOUD_PRICING, type CloudPricing, type CloudProvider } from "../analytics/cost-tracker.js";

export type RouteDecision = "local" | "cloud" | "hybrid";
export type TaskComplexity = "simple" | "moderate" | "complex" | "very-complex";
export type CloudFallbackMode = "disabled" | "manual" | "auto";

export interface TaskContext {
  prompt: string;
  taskType: "chat" | "code" | "agent" | "tool" | "unknown";
  conversationHistory?: { role: "user" | "assistant"; content: string }[];
  attachments?: { type: "file" | "image" | "url"; sizeKB?: number }[];
  requiresInternetAccess?: boolean;
  requiresLongContext?: boolean;
  maxTokenBudget?: number;
}

export interface RouterConfig {
  localModel: string;
  cloudFallbackMode: CloudFallbackMode;
  cloudProvider?: CloudProvider;
  cloudModel?: string;
  complexityThreshold?: TaskComplexity;
  localContextWindowTokens?: number;
  confirmCloudCallback?: (cost: EstimatedCost) => Promise<boolean>;
}

export interface RoutingDecision {
  route: RouteDecision;
  complexity: TaskComplexity;
  localModel: string;
  cloudModel?: string;
  cloudProvider?: CloudProvider;
  reasoning: string;
  estimatedCost?: EstimatedCost;
  warnings: string[];
}

export interface EstimatedCost {
  promptTokens: number;
  estimatedCompletionTokens: number;
  estimatedTotalUSD: number;
  provider: CloudProvider;
  model: string;
}

const COMPLEXITY_ORDER: TaskComplexity[] = ["simple", "moderate", "complex", "very-complex"];

const COMPLETION_TOKENS_BY_COMPLEXITY: Record<TaskComplexity, number> = {
  simple: 256,
  moderate: 512,
  complex: 1_024,
  "very-complex": 2_048,
};

function findCloudPricing(config: RouterConfig): CloudPricing | undefined {
  if (!config.cloudProvider || !config.cloudModel) {
    return undefined;
  }

  return CLOUD_PRICING.find(
    (pricing) => pricing.provider === config.cloudProvider && pricing.model === config.cloudModel,
  );
}

function createEstimatedCost(
  pricing: CloudPricing,
  promptTokens: number,
  estimatedCompletionTokens: number,
): EstimatedCost {
  const estimatedTotalUSD =
    (promptTokens / 1_000) * pricing.inputPricePer1kTokens +
    (estimatedCompletionTokens / 1_000) * pricing.outputPricePer1kTokens;

  return {
    promptTokens,
    estimatedCompletionTokens,
    estimatedTotalUSD,
    provider: pricing.provider,
    model: pricing.model,
  };
}

function createReasoning(
  route: Exclude<RouteDecision, "hybrid">,
  complexity: TaskComplexity,
  taskType: TaskContext["taskType"],
  config: RouterConfig,
  detail: string,
): string {
  const prefix = route === "local" ? "Local" : "Cloud";
  return `${prefix}: ${complexity} ${taskType} task ${detail} (${config.localModel})`;
}

function getComplexityThreshold(config: RouterConfig): TaskComplexity {
  return config.complexityThreshold ?? "complex";
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function compareComplexityLevels(a: TaskComplexity, b: TaskComplexity): -1 | 0 | 1 {
  const aIndex = COMPLEXITY_ORDER.indexOf(a);
  const bIndex = COMPLEXITY_ORDER.indexOf(b);

  if (aIndex < bIndex) {
    return -1;
  }
  if (aIndex > bIndex) {
    return 1;
  }
  return 0;
}

export function estimateComplexity(context: TaskContext): TaskComplexity {
  let score = 0;
  const promptLength = context.prompt.length;

  if (promptLength >= 200 && promptLength <= 500) {
    score += 10;
  } else if (promptLength > 500 && promptLength <= 2_000) {
    score += 20;
  } else if (promptLength > 2_000) {
    score += 35;
  }

  switch (context.taskType) {
    case "chat":
      break;
    case "tool":
      score += 5;
      break;
    case "code":
      score += 15;
      break;
    case "agent":
      score += 25;
      break;
    case "unknown":
      score += 10;
      break;
  }

  const historyTurns = context.conversationHistory?.length ?? 0;
  if (historyTurns >= 1 && historyTurns <= 5) {
    score += 5;
  } else if (historyTurns >= 6 && historyTurns <= 15) {
    score += 10;
  } else if (historyTurns > 15) {
    score += 20;
  }

  const attachments = context.attachments ?? [];
  if (attachments.some((attachment) => attachment.type === "image")) {
    score += 15;
  } else if (
    attachments.some((attachment) => attachment.type === "file" || attachment.type === "url")
  ) {
    score += 10;
  }

  if (context.requiresInternetAccess) {
    score += 10;
  }

  if (context.requiresLongContext) {
    score += 20;
  }

  const boundedScore = Math.min(score, 100);
  if (boundedScore <= 25) {
    return "simple";
  }
  if (boundedScore <= 50) {
    return "moderate";
  }
  if (boundedScore <= 75) {
    return "complex";
  }
  return "very-complex";
}

export function shouldWarnAboutCost(cost: EstimatedCost): boolean {
  return cost.estimatedTotalUSD > 0.1;
}

export function createDefaultConfig(localModel: string): RouterConfig {
  return {
    localModel,
    cloudFallbackMode: "disabled",
    localContextWindowTokens: 8_192,
    complexityThreshold: "complex",
  };
}

export async function routeTask(
  context: TaskContext,
  config: RouterConfig,
): Promise<RoutingDecision> {
  const complexity = estimateComplexity(context);
  const promptTokens = estimateTokenCount(context.prompt);
  const historyTokens = (context.conversationHistory ?? []).reduce(
    (total, message) => total + estimateTokenCount(message.content),
    0,
  );
  const totalContextTokens = promptTokens + historyTokens;
  const estimatedCompletionTokens = COMPLETION_TOKENS_BY_COMPLEXITY[complexity];
  const localContextWindowTokens = config.localContextWindowTokens ?? 8_192;
  const contextOverflow = totalContextTokens > localContextWindowTokens;
  const warnings: string[] = [];

  if (contextOverflow) {
    warnings.push(`Prompt exceeds local context window (${totalContextTokens} tokens estimated)`);
  }

  const mode = config.cloudFallbackMode ?? "disabled";
  const threshold = getComplexityThreshold(config);
  const exceedsThreshold = compareComplexityLevels(complexity, threshold) >= 0;

  const baseDecision = {
    complexity,
    localModel: config.localModel,
    cloudModel: config.cloudModel,
    cloudProvider: config.cloudProvider,
  };

  if (mode === "disabled") {
    return {
      ...baseDecision,
      route: "local",
      reasoning: "Local: cloud fallback disabled, routing all tasks locally",
      warnings,
    };
  }

  const shouldConsiderCloud = contextOverflow || exceedsThreshold;
  if (!shouldConsiderCloud) {
    return {
      ...baseDecision,
      route: "local",
      reasoning: createReasoning(
        "local",
        complexity,
        context.taskType,
        config,
        `is below cloud threshold ${threshold}`,
      ),
      warnings,
    };
  }

  const pricing = findCloudPricing(config);
  if (!pricing) {
    warnings.push("Cloud fallback requested but cloud provider/model pricing is not configured");
    return {
      ...baseDecision,
      route: "local",
      reasoning: createReasoning(
        "local",
        complexity,
        context.taskType,
        config,
        "has no cloud pricing configured",
      ),
      warnings,
    };
  }

  const estimatedCost = createEstimatedCost(pricing, totalContextTokens, estimatedCompletionTokens);

  if (mode === "manual") {
    if (!config.confirmCloudCallback) {
      warnings.push(
        "Cloud fallback requires confirmation but no confirmCloudCallback was provided",
      );
      return {
        ...baseDecision,
        route: "local",
        estimatedCost,
        reasoning: createReasoning(
          "local",
          complexity,
          context.taskType,
          config,
          "requires manual confirmation and none was available",
        ),
        warnings,
      };
    }

    const confirmed = await config.confirmCloudCallback(estimatedCost);
    if (!confirmed) {
      warnings.push("Cloud routing rejected by user confirmation callback");
      return {
        ...baseDecision,
        route: "local",
        estimatedCost,
        reasoning: createReasoning(
          "local",
          complexity,
          context.taskType,
          config,
          "was declined after cloud cost confirmation",
        ),
        warnings,
      };
    }

    return {
      ...baseDecision,
      route: "cloud",
      estimatedCost,
      reasoning: createReasoning(
        "cloud",
        complexity,
        context.taskType,
        config,
        `exceeds threshold ${threshold} and was approved in manual mode`,
      ),
      warnings,
    };
  }

  return {
    ...baseDecision,
    route: "cloud",
    estimatedCost,
    reasoning: createReasoning(
      "cloud",
      complexity,
      context.taskType,
      config,
      contextOverflow
        ? "exceeds local context window and auto cloud fallback is enabled"
        : `exceeds threshold ${threshold} with auto cloud fallback enabled`,
    ),
    warnings,
  };
}
