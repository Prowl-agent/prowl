/**
 * Smart Model Selector
 *
 * Queries Ollama for loaded models and picks the best one per task.
 * Never hardcodes a single model and adapts to what is currently available.
 */

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  sizeVram: number;
  family: string;
  parameterSize: string;
  parameterCount: number;
}

export type TaskWeight = "quick" | "standard" | "heavy";

export interface ModelSelection {
  model: string;
  reason: string;
  taskWeight: TaskWeight;
  allAvailable: string[];
}

const PARAM_TIERS = {
  quick: { maxParams: 4 },
  standard: { maxParams: 10 },
  heavy: { minParams: 10 },
} as const;

interface OllamaPsResponse {
  models?: Array<{
    name: string;
    size: number;
    size_vram: number;
    details?: {
      family?: string;
      parameter_size?: string;
    };
  }>;
}

export class ModelSelector {
  private readonly ollamaUrl: string;
  private readonly preferredModel: string;
  private loadedModels: LoadedModel[] = [];
  private lastRefresh = 0;
  private readonly refreshIntervalMs = 30_000;

  constructor(preferredModel: string, ollamaUrl = "http://localhost:11434") {
    this.preferredModel = preferredModel;
    this.ollamaUrl = ollamaUrl.replace(/\/+$/, "");
  }

  async select(taskWeight: TaskWeight = "standard"): Promise<ModelSelection> {
    await this.refreshIfNeeded();

    const available = this.loadedModels.map((m) => m.name);
    if (this.loadedModels.length === 0) {
      return {
        model: this.preferredModel,
        reason: "No loaded Ollama models detected; using configured default model",
        taskWeight,
        allAvailable: [],
      };
    }

    if (this.loadedModels.length === 1) {
      return {
        model: this.loadedModels[0].name,
        reason: "Only one loaded model available",
        taskWeight,
        allAvailable: available,
      };
    }

    const sorted = [...this.loadedModels].toSorted((a, b) => {
      if (a.parameterCount !== b.parameterCount) {
        return a.parameterCount - b.parameterCount;
      }
      return a.sizeBytes - b.sizeBytes;
    });

    const preferred = this.loadedModels.find((m) => m.name === this.preferredModel);
    const quickCandidate =
      sorted.find((m) => m.parameterCount > 0 && m.parameterCount <= PARAM_TIERS.quick.maxParams) ??
      sorted[0];
    const standardCandidate =
      [...sorted]
        .toReversed()
        .find(
          (m) =>
            m.parameterCount > PARAM_TIERS.quick.maxParams &&
            m.parameterCount <= PARAM_TIERS.standard.maxParams,
        ) ??
      sorted[Math.floor((sorted.length - 1) / 2)] ??
      sorted[sorted.length - 1];
    const heavyCandidate =
      [...sorted].toReversed().find((m) => m.parameterCount >= PARAM_TIERS.heavy.minParams) ??
      sorted[sorted.length - 1];

    let selected: LoadedModel = standardCandidate;

    if (taskWeight === "quick") {
      selected = quickCandidate;
    } else if (taskWeight === "heavy") {
      selected = heavyCandidate;
    } else if (preferred) {
      selected = preferred;
    }

    const preferredMissing =
      taskWeight === "standard" && !preferred && this.preferredModel.trim().length > 0;
    const reason = preferredMissing
      ? `Configured model "${this.preferredModel}" is not loaded; using ${selected.parameterSize} model for ${taskWeight} task`
      : `Selected ${selected.parameterSize} model for ${taskWeight} task (${this.loadedModels.length} loaded models)`;

    return {
      model: selected.name,
      reason,
      taskWeight,
      allAvailable: available,
    };
  }

  classifyTaskWeight(message: string, tools?: unknown[], conversationLength?: number): TaskWeight {
    const lower = message.toLowerCase();

    const quickSignals = [
      /^(hi|hello|hey|thanks|ok|yes|no|sure)\b/,
      /^what (is|are) /,
      /\b(summarize|tldr|brief)\b/,
      /^(how many|when did|who is|where is)\b/,
    ];

    if (lower.length < 50 && quickSignals.some((r) => r.test(lower))) {
      return "quick";
    }

    const heavySignals = [
      /\b(implement|refactor|architect|design|debug|write a? ?(full|complete|comprehensive))\b/,
      /\b(analyze|compare|evaluate|review|audit)\b/,
      /\b(step by step|detailed|thorough|in-depth)\b/,
      /```[\s\S]{100,}/,
    ];

    if (tools && tools.length > 3) {
      return "heavy";
    }
    if ((conversationLength ?? 0) > 20) {
      return "heavy";
    }
    if (heavySignals.some((r) => r.test(lower))) {
      return "heavy";
    }

    return "standard";
  }

  private async refreshIfNeeded(): Promise<void> {
    if (Date.now() - this.lastRefresh < this.refreshIntervalMs) {
      return;
    }

    try {
      const response = await fetch(`${this.ollamaUrl}/api/ps`);
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as OllamaPsResponse;
      this.loadedModels = (data.models ?? []).map((model) => {
        const parameterSize = model.details?.parameter_size ?? this.extractParamSize(model.name);
        return {
          name: model.name,
          sizeBytes: model.size,
          sizeVram: model.size_vram,
          family: model.details?.family ?? this.extractFamily(model.name),
          parameterSize,
          parameterCount: this.parseParamCount(parameterSize),
        };
      });
    } catch {
      // Keep existing cache on network/parsing failures.
    } finally {
      this.lastRefresh = Date.now();
    }
  }

  private extractFamily(name: string): string {
    const withoutTag = name.split(":")[0];
    const segments = withoutTag.split("/");
    return segments[segments.length - 1] || withoutTag;
  }

  private extractParamSize(name: string): string {
    const tag = name.includes(":") ? name.split(":").slice(1).join(":") : name;
    const fromTag = tag.match(/(\d+(?:\.\d+)?)[bB]/);
    if (fromTag) {
      return `${fromTag[1]}B`;
    }
    const fallback = name.match(/(\d+(?:\.\d+)?)[bB]/);
    return fallback ? `${fallback[1]}B` : "unknown";
  }

  private parseParamCount(parameterSize: string): number {
    const match = parameterSize.match(/(\d+(?:\.\d+)?)/);
    return match ? Number.parseFloat(match[1]) : 0;
  }

  get state() {
    return {
      preferredModel: this.preferredModel,
      loadedModels: this.loadedModels.map((model) => ({
        name: model.name,
        params: model.parameterSize,
        vramGB: Number((model.sizeVram / 1_073_741_824).toFixed(1)),
      })),
      lastRefresh: this.lastRefresh > 0 ? new Date(this.lastRefresh).toISOString() : null,
    };
  }
}
