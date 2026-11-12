/**
 * Single LLM egress policy for the Windows-local edition.
 * DeepSeek Flash supports vision; V4 Pro is text-only (verified Nov 2026).
 * Never trust UI selectors or a caller-supplied llmConfig as an outbound URL.
 */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
export const DEEPSEEK_VISION_MODEL = "deepseek-flash";
export const DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

export function assertDeepSeekEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("DEEPSEEK_ONLY_ENDPOINT");
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("DEEPSEEK_ONLY_ENDPOINT"); }
  if (
    url.protocol !== "https:" || url.hostname !== "api.deepseek.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" ||
    !["/", "/v1", "/v1/"].includes(url.pathname)
  ) throw new Error("DEEPSEEK_ONLY_ENDPOINT");
  return DEEPSEEK_BASE_URL;
}

export function isDeepSeekEndpoint(value: unknown): boolean {
  try { assertDeepSeekEndpoint(value); return true; }
  catch { return false; }
}

export function assertDeepSeekModel(value: unknown): DeepSeekModel {
  if (typeof value !== "string" || !DEEPSEEK_MODELS.includes(value as DeepSeekModel)) {
    throw new Error("DEEPSEEK_ONLY_MODEL");
  }
  return value as DeepSeekModel;
}

export function assertDeepSeekConfig(value: {
  baseUrl?: unknown; model?: unknown; visionModel?: unknown;
}): { baseUrl: string; model: DeepSeekModel; visionModel: typeof DEEPSEEK_VISION_MODEL } {
  const baseUrl = assertDeepSeekEndpoint(value?.baseUrl);
  const model = assertDeepSeekModel(value?.model);
  if (value?.visionModel && value.visionModel !== DEEPSEEK_VISION_MODEL) {
    throw new Error("DEEPSEEK_VISION_REQUIRES_FLASH");
  }
  return { baseUrl, model, visionModel: DEEPSEEK_VISION_MODEL };
}

export function normalizeSavedDeepSeekModel(value: unknown): DeepSeekModel {
  // Old direct DeepSeek model names are aliases of the latest Flash; never accept other vendors.
  if (value === "deepseek-v4-pro") return "deepseek-v4-pro";
  return DEEPSEEK_DEFAULT_MODEL;
}
