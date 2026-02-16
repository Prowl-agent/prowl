import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "../../runtime.js";
import {
  clearCloudPricingOverrideFile,
  getCloudPricing,
  getCloudPricingOverridePath,
  writeCloudPricingOverrideFile,
} from "../../../packages/core/src/analytics/cost-tracker.js";

export interface ModelsPricingListOptions {
  json?: boolean;
  plain?: boolean;
}

export interface ModelsPricingUpdateOptions {
  url?: string;
  file?: string;
  clear?: boolean;
  json?: boolean;
}

function validateSourceSelection(opts: ModelsPricingUpdateOptions): void {
  const sourceCount =
    Number(Boolean(opts.url)) + Number(Boolean(opts.file)) + Number(Boolean(opts.clear));
  if (sourceCount !== 1) {
    throw new Error("Specify exactly one source: --url <url>, --file <path>, or --clear");
  }
}

function parseJsonPayload(raw: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON from ${sourceLabel}`);
  }
}

async function readPricingPayload(opts: ModelsPricingUpdateOptions): Promise<{
  payload: unknown;
  sourceLabel: string;
  sourceEntryCount: number;
}> {
  if (opts.file) {
    const filePath = path.resolve(opts.file);
    const raw = await fs.readFile(filePath, "utf8");
    const payload = parseJsonPayload(raw, filePath);
    return {
      payload,
      sourceLabel: filePath,
      sourceEntryCount: Array.isArray(payload) ? payload.length : 0,
    };
  }

  if (!opts.url) {
    throw new Error("Missing source: pass --url <url>, --file <path>, or --clear");
  }

  const response = await fetch(opts.url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch cloud pricing from ${opts.url}: ${response.status} ${response.statusText}`,
    );
  }

  const raw = await response.text();
  const payload = parseJsonPayload(raw, opts.url);
  return {
    payload,
    sourceLabel: opts.url,
    sourceEntryCount: Array.isArray(payload) ? payload.length : 0,
  };
}

export async function modelsPricingListCommand(
  opts: ModelsPricingListOptions,
  runtime: RuntimeEnv,
) {
  const pricing = getCloudPricing();
  const overridePath = getCloudPricingOverridePath();

  if (opts.json) {
    runtime.log(JSON.stringify({ pricing, overridePath }, null, 2));
    return;
  }

  if (opts.plain) {
    for (const entry of pricing) {
      runtime.log(
        `${entry.provider}\t${entry.model}\t${entry.inputPricePer1kTokens}\t${entry.outputPricePer1kTokens}`,
      );
    }
    return;
  }

  runtime.log(`Cloud pricing entries: ${pricing.length}`);
  runtime.log(`Override file: ${overridePath}`);
  for (const entry of pricing) {
    runtime.log(
      `- ${entry.provider}/${entry.model}: in=${entry.inputPricePer1kTokens} out=${entry.outputPricePer1kTokens}`,
    );
  }
}

export async function modelsPricingUpdateCommand(
  opts: ModelsPricingUpdateOptions,
  runtime: RuntimeEnv,
) {
  validateSourceSelection(opts);

  if (opts.clear) {
    const overridePath = await clearCloudPricingOverrideFile();
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            cleared: true,
            overridePath,
          },
          null,
          2,
        ),
      );
      return;
    }
    runtime.log(`Cleared cloud pricing override: ${overridePath}`);
    return;
  }

  const { payload, sourceLabel, sourceEntryCount } = await readPricingPayload(opts);
  const { path: overridePath, entryCount } = await writeCloudPricingOverrideFile(payload);
  const droppedEntryCount = Math.max(0, sourceEntryCount - entryCount);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          source: sourceLabel,
          overridePath,
          writtenEntryCount: entryCount,
          droppedEntryCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Updated cloud pricing override from ${sourceLabel}`);
  runtime.log(`Wrote ${entryCount} entries to ${overridePath}`);
  if (droppedEntryCount > 0) {
    runtime.log(`Ignored ${droppedEntryCount} invalid entries`);
  }
  if (
    typeof process.env.OPENCLAW_CLOUD_PRICING_JSON === "string" &&
    process.env.OPENCLAW_CLOUD_PRICING_JSON.trim().length > 0
  ) {
    runtime.log("OPENCLAW_CLOUD_PRICING_JSON is set and currently overrides file-based pricing.");
  }
}
