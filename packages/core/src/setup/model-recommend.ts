import type { HardwareProfile } from "./hardware-detect.js";
export type { HardwareProfile } from "./hardware-detect.js";

export interface QuantizationOption {
  name: string;
  sizeGB: number;
  quality: string;
  minRAMGB: number;
}

export interface ModelRecommendation {
  model: string;
  displayName: string;
  quality: "basic" | "good" | "great" | "excellent";
  estimatedSpeed: string;
  sizeGB: number;
  reason: string;
  source: "ollama" | "huggingface";
  ollamaTag?: string;
  hfRepo?: string;
  quantizationOptions?: QuantizationOption[];
  recommendedQuant?: string;
}

interface ModelSpec {
  model: string;
  displayName: string;
  quality: ModelRecommendation["quality"];
  estimatedSpeed: string;
  sizeGB: number;
  reason: string;
  hfRepo: string;
  minAvailableGB: number;
  quantizationOptions: QuantizationOption[];
}

const QUALITY_ORDER: Record<ModelRecommendation["quality"], number> = {
  excellent: 4,
  great: 3,
  good: 2,
  basic: 1,
};

const MODELS: ModelSpec[] = [
  {
    model: "qwen3:32b",
    displayName: "Qwen3 32B",
    quality: "excellent",
    estimatedSpeed: "8-12 tok/s",
    sizeGB: 36,
    reason: "Full power for complex autonomous tasks",
    hfRepo: "bartowski/Qwen3-32B-GGUF",
    minAvailableGB: 40,
    quantizationOptions: [
      { name: "Q3_K_M", sizeGB: 16.7, quality: "Basic", minRAMGB: 21 },
      { name: "Q4_K_M", sizeGB: 19.8, quality: "Good - recommended", minRAMGB: 25 },
      { name: "Q5_K_M", sizeGB: 23.2, quality: "Great", minRAMGB: 29 },
      { name: "Q8_0", sizeGB: 36, quality: "Excellent", minRAMGB: 41 },
    ],
  },
  {
    model: "qwen2.5-coder:14b",
    displayName: "Qwen2.5 Coder 14B",
    quality: "great",
    estimatedSpeed: "10-15 tok/s",
    sizeGB: 16,
    reason: "Strong coding and reasoning",
    hfRepo: "bartowski/Qwen2.5-Coder-14B-GGUF",
    minAvailableGB: 14,
    quantizationOptions: [
      { name: "Q3_K_M", sizeGB: 7.3, quality: "Basic", minRAMGB: 9 },
      { name: "Q4_K_M", sizeGB: 8.8, quality: "Good - recommended", minRAMGB: 11 },
      { name: "Q5_K_M", sizeGB: 10.2, quality: "Great", minRAMGB: 13 },
      { name: "Q8_0", sizeGB: 16, quality: "Excellent", minRAMGB: 19 },
    ],
  },
  {
    model: "qwen3:8b",
    displayName: "Qwen3 8B",
    quality: "good",
    estimatedSpeed: "15-20 tok/s",
    sizeGB: 9,
    reason: "Best balance for most hardware",
    hfRepo: "bartowski/Qwen3-8B-GGUF",
    minAvailableGB: 8,
    quantizationOptions: [
      { name: "Q3_K_M", sizeGB: 4.1, quality: "Basic", minRAMGB: 5 },
      { name: "Q4_K_M", sizeGB: 4.8, quality: "Good - recommended", minRAMGB: 6 },
      { name: "Q5_K_M", sizeGB: 5.6, quality: "Great", minRAMGB: 7 },
      { name: "Q8_0", sizeGB: 9, quality: "Excellent", minRAMGB: 11 },
    ],
  },
  {
    model: "qwen3:4b",
    displayName: "Qwen3 4B",
    quality: "basic",
    estimatedSpeed: "20-30 tok/s",
    sizeGB: 5,
    reason: "Limited capability, consider upgrading RAM",
    hfRepo: "bartowski/Qwen3-4B-GGUF",
    minAvailableGB: 4,
    quantizationOptions: [
      { name: "Q3_K_M", sizeGB: 2.2, quality: "Basic", minRAMGB: 3 },
      { name: "Q4_K_M", sizeGB: 2.9, quality: "Good - recommended", minRAMGB: 5 },
      { name: "Q5_K_M", sizeGB: 3.4, quality: "Great", minRAMGB: 6 },
      { name: "Q8_0", sizeGB: 5, quality: "Excellent", minRAMGB: 7 },
    ],
  },
];

function getAvailableModelMemory(profile: HardwareProfile): number {
  return profile.availableForModelGB;
}

function chooseQuantization(model: ModelSpec, availableGB: number): string {
  if (availableGB >= model.sizeGB * 1.2) {
    return "Q8_0";
  }
  if (availableGB >= model.sizeGB * 0.9) {
    return "Q5_K_M";
  }

  const q4Option = model.quantizationOptions.find((option) => option.name === "Q4_K_M");
  if (q4Option && availableGB >= q4Option.minRAMGB) {
    return "Q4_K_M";
  }

  return "Q3_K_M";
}

function toRecommendation(model: ModelSpec, availableGB: number): ModelRecommendation {
  return {
    model: model.model,
    displayName: model.displayName,
    quality: model.quality,
    estimatedSpeed: model.estimatedSpeed,
    sizeGB: model.sizeGB,
    reason: model.reason,
    source: "ollama",
    ollamaTag: model.model,
    hfRepo: model.hfRepo,
    quantizationOptions: model.quantizationOptions,
    recommendedQuant: chooseQuantization(model, availableGB),
  };
}

export function recommendModel(profile: HardwareProfile): ModelRecommendation {
  const availableGB = getAvailableModelMemory(profile);
  const selected = MODELS.find((model) => availableGB >= model.minAvailableGB);

  if (!selected) {
    throw new Error("Insufficient memory. Minimum 16GB RAM recommended.");
  }

  return toRecommendation(selected, availableGB);
}

export function listCompatibleModels(profile: HardwareProfile): ModelRecommendation[] {
  const availableGB = getAvailableModelMemory(profile);

  return MODELS.filter((model) => availableGB >= model.minAvailableGB)
    .map((model) => toRecommendation(model, availableGB))
    .toSorted((a, b) => QUALITY_ORDER[b.quality] - QUALITY_ORDER[a.quality]);
}
