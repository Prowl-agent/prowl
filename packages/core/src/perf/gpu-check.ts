/**
 * GPU Offload Verification
 *
 * Queries Ollama to check whether models are GPU-accelerated.
 * Surfaces warnings when running CPU-only on large models.
 */

const GPU_CHECK_TIMEOUT_MS = 5_000;

export interface GpuStatus {
  loaded: boolean;
  gpuAccelerated: boolean;
  gpuLayers: number;
  totalLayers: number;
  modelName: string;
  /** Size in bytes (from Ollama /api/ps). */
  size: number;
}

export interface GpuCheckResult {
  available: boolean;
  models: GpuStatus[];
  warnings: string[];
}

/**
 * Query Ollama /api/ps to check GPU offload status of loaded models.
 */
export async function checkGpuOffload(
  ollamaUrl: string = "http://127.0.0.1:11434",
): Promise<GpuCheckResult> {
  const apiUrl = `${ollamaUrl.replace(/\/+$/, "")}/api/ps`;
  const warnings: string[] = [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GPU_CHECK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(apiUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { available: false, models: [], warnings: ["Ollama is not responding."] };
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        size: number;
        details?: { gpu_layers?: number; total_layers?: number };
      }>;
    };

    if (!data.models || data.models.length === 0) {
      return { available: true, models: [], warnings: ["No models currently loaded."] };
    }

    const models: GpuStatus[] = data.models.map((m) => {
      const gpuLayers = m.details?.gpu_layers ?? 0;
      const totalLayers = m.details?.total_layers ?? 0;
      const gpuAccelerated = gpuLayers > 0;

      if (!gpuAccelerated) {
        const sizeGB = Math.round((m.size / 1_073_741_824) * 10) / 10;
        if (sizeGB >= 8) {
          warnings.push(
            `${m.name} (${sizeGB}GB) is running CPU-only. Performance will be very slow. ` +
              `Ensure your GPU drivers and Ollama GPU support are properly configured.`,
          );
        }
      }

      return {
        loaded: true,
        gpuAccelerated,
        gpuLayers,
        totalLayers,
        modelName: m.name,
        size: m.size,
      };
    });

    return { available: true, models, warnings };
  } catch {
    return { available: false, models: [], warnings: ["Could not connect to Ollama."] };
  }
}

/**
 * Format GPU status for CLI output (e.g. `prowl doctor`).
 */
export function formatGpuStatus(result: GpuCheckResult): string {
  const lines: string[] = [];

  if (!result.available) {
    lines.push("GPU Check: ❌ Ollama not available");
    return lines.join("\n");
  }

  if (result.models.length === 0) {
    lines.push("GPU Check: ⚠️  No models loaded");
    return lines.join("\n");
  }

  for (const model of result.models) {
    const accel = model.gpuAccelerated ? "✅ GPU" : "❌ CPU-only";
    const layers =
      model.totalLayers > 0 ? ` (${model.gpuLayers}/${model.totalLayers} layers on GPU)` : "";
    const sizeGB = Math.round((model.size / 1_073_741_824) * 10) / 10;
    lines.push(`${model.modelName} (${sizeGB}GB): ${accel}${layers}`);
  }

  for (const warning of result.warnings) {
    lines.push(`⚠️  ${warning}`);
  }

  return lines.join("\n");
}
