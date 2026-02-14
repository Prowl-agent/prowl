import {
  deleteModel,
  listInstalledModels,
  pullModel,
  switchActiveModel,
  type ModelManagerConfig,
} from "./model-manager.js";

export interface ApiRequest {
  params: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
}

export interface ApiResponse {
  json: (data: unknown) => void;
  status: (code: number) => ApiResponse;
  send: (data: string) => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function getTagFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const maybeTag = (body as { tag?: unknown }).tag;
  if (typeof maybeTag !== "string") {
    return "";
  }

  return maybeTag.trim();
}

function getTagFromParams(params: Record<string, string>): string {
  return (params.tag ?? "").trim();
}

export async function handleListModels(
  _req: ApiRequest,
  res: ApiResponse,
  config: ModelManagerConfig,
): Promise<void> {
  const models = await listInstalledModels(config);
  res.json({ models });
}

export async function handlePullModel(
  req: ApiRequest,
  res: ApiResponse,
  config: ModelManagerConfig,
): Promise<void> {
  const tag = getTagFromBody(req.body);
  if (!tag) {
    res.status(400).json({ error: "Model tag is required" });
    return;
  }

  try {
    await pullModel(tag, config, () => undefined);
    res.json({ success: true, model: tag });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
}

export async function handleDeleteModel(
  req: ApiRequest,
  res: ApiResponse,
  config: ModelManagerConfig,
): Promise<void> {
  const tag = getTagFromParams(req.params);
  if (!tag) {
    res.status(400).json({ error: "Model tag is required" });
    return;
  }

  try {
    await deleteModel(tag, config);
    res.json({ success: true });
  } catch (error) {
    const message = getErrorMessage(error);
    const statusCode = /not found/i.test(message) ? 404 : 400;
    res.status(statusCode).json({ error: message });
  }
}

export async function handleSwitchModel(
  req: ApiRequest,
  res: ApiResponse,
  config: ModelManagerConfig,
): Promise<void> {
  const tag = getTagFromBody(req.body);
  if (!tag) {
    res.status(400).json({ error: "Model tag is required" });
    return;
  }

  try {
    await switchActiveModel(tag, config);
    res.json({ success: true, activeModel: tag });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
}
