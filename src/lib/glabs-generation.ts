/**
 * R2 G-Labs route integration. No existing provider's request contract is changed.
 * The accepted task ID is saved BEFORE any GET polling or file download.
 */
import { NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import type { ImageOptions, VideoOptions } from "@/lib/providers/types";
import { GLABS_IMAGE_MODEL, GLABS_VIDEO_MODEL } from "@/lib/providers/glabs-webhook";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";

const imageKeys = new Set(["width", "height", "count", "extra", "negativePrompt", "steps", "guidanceScale", "seed"]);
const videoKeys = new Set(["width", "height", "extra", "duration", "fps", "negativePrompt", "audioEnabled", "audioPrompt", "voiceover",
  "openaiSize", "guidanceScale", "motionStrength", "seed", "referenceImageUrls", "referenceVideoUrls", "referenceAudioUrls", "referenceVideoUrl"]);
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const errorResponse = (error: unknown, taskId?: string, afterSubmit = false) => {
  const code = error instanceof ProviderError ? error.code : "GLABS_INTERNAL";
  const message = error instanceof ProviderError ? error.message : "G-Labs request failed; inspect local logs without exposing credentials";
  return NextResponse.json({ error: message, errorCode: code, ...(taskId ? { taskId } : {}),
    ...(afterSubmit ? { recoverable: true } : {}) },
  { status: code.includes("PREFLIGHT") || code.startsWith("GLABS_BAD") || code === "GLABS_UNSUPPORTED_OPTION" ? 400
    : code === "GLABS_SUBMIT_UNCERTAIN" ? 504 : afterSubmit ? 504 : 502 });
};

function checkedOptions(x: unknown, allowed: Set<string>): Record<string, unknown> {
  if (x === undefined || x === null) return {};
  if (!isRecord(x)) throw new ProviderError("options phải là object", "GLABS_BAD_PARAMETER", "glabs-webhook");
  for (const key of Object.keys(x)) if (!allowed.has(key))
    throw new ProviderError("G-Labs không hỗ trợ options." + key, "GLABS_UNSUPPORTED_OPTION", "glabs-webhook");
  return x;
}

function validInputs(body: Record<string, unknown>, extraKeys: string[]) {
  const allowed = new Set(["provider", "model", "prompt", "mode", "apiKey", "baseUrl", "options", "projectId", "shotId", "controlPlan", ...extraKeys]);
  for (const key of Object.keys(body)) if (!allowed.has(key))
    throw new ProviderError("G-Labs không hỗ trợ input " + key, "GLABS_UNSUPPORTED_OPTION", "glabs-webhook");
  if (typeof body.prompt !== "string" || !body.prompt.trim())
    throw new ProviderError("Prompt không hợp lệ", "GLABS_BAD_PROMPT", "glabs-webhook");
  if (body.projectId !== undefined && (typeof body.projectId !== "string" || body.projectId.length > 128))
    throw new ProviderError("projectId không hợp lệ", "GLABS_BAD_PARAMETER", "glabs-webhook");
  if (body.shotId !== undefined && (!Number.isInteger(body.shotId) || Number(body.shotId) < 0))
    throw new ProviderError("shotId không hợp lệ", "GLABS_BAD_PARAMETER", "glabs-webhook");
  if (typeof body.apiKey !== "string" || !body.apiKey.trim())
    throw new ProviderError("Thiếu G-Labs Webhook API key", "GLABS_NO_KEY", "glabs-webhook");
}

async function waitAndPersist(
  provider: ReturnType<typeof createProvider>,
  taskId: string, modelId: string, mediaType: "image" | "video",
  body: Record<string, unknown>, mode: string,
): Promise<NextResponse> {
  const rowId = await recordAiTask({
    provider: "glabs-webhook", model: modelId, mediaType, mode,
    projectId: body.projectId as string | undefined, shotId: body.shotId as number | undefined,
    taskId, prompt: body.prompt as string,
  });
  // Never continue polling without a durable recovery handle. Return the known paid task ID.
  if (!rowId) return NextResponse.json({
    error: "G-Labs đã nhận job nhưng ClipForge chưa lưu được task vào SQLite. Giữ taskId và đối soát thủ công; không gửi lại.",
    errorCode: "GLABS_DB_PERSIST_FAILED", taskId, recoverable: true,
  }, { status: 503 });

  try {
    if (!provider.waitForTask) throw new Error("Missing async task support");
    const status = await provider.waitForTask(taskId, { interval: 5000, maxAttempts: 180 });
    const result = status.result;
    const urls = result && ("imageUrls" in result ? result.imageUrls : result.videoUrls);
    if (!urls?.length) throw new ProviderError("G-Labs completed but returned no local media", "GLABS_NO_RESULT", "glabs-webhook");
    if ((mediaType === "image" && !(result && "imageUrls" in result)) ||
        (mediaType === "video" && !(result && "videoUrls" in result)))
      throw new ProviderError("G-Labs returned the wrong media type", "GLABS_BAD_RESULT", "glabs-webhook");
    await updateAiTask(rowId, { status: "completed", resultUrls: urls, error: null });
    if (mediaType === "image" && result && "imageUrls" in result)
      return NextResponse.json(result);
    if (mediaType === "video" && result && "videoUrls" in result)
      return NextResponse.json(result);
    throw new ProviderError("G-Labs returned the wrong media type", "GLABS_BAD_RESULT", "glabs-webhook");
  } catch (error) {
    const definitivelyFailed = error instanceof ProviderError && error.code === "TASK_FAILED";
    await updateAiTask(rowId, { status: definitivelyFailed ? "failed" : "unknown",
      error: error instanceof ProviderError ? error.message : "Task result is unknown; do not resubmit" });
    if (definitivelyFailed) return errorResponse(error, taskId);
    return errorResponse(error, taskId, true);
  }
}

/** Used only when provider=glabs-webhook; no double-submit or speculative endpoint fallback. */
export async function handleGlabsImage(body: Record<string, unknown>): Promise<NextResponse> {
  try {
    validInputs(body, ["imageUrl", "imageUrls"]);
    if (body.model !== GLABS_IMAGE_MODEL) throw new ProviderError("Choose GPT Image 2 in G-Labs image picker", "GLABS_BAD_MODEL", "glabs-webhook");
    const provided = checkedOptions(body.options, imageKeys);
    const sources = body.imageUrls !== undefined ? body.imageUrls : body.imageUrl !== undefined ? [body.imageUrl] : [];
    if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string") || sources.length > 5)
      throw new ProviderError("Reference images must be 0–5 ordered file references", "GLABS_BAD_REFERENCE", "glabs-webhook");
    const mode = body.mode ?? (sources.length ? "image-to-image" : "text-to-image");
    if (mode !== "image-to-image" && mode !== "text-to-image")
      throw new ProviderError("Unsupported image mode", "GLABS_BAD_MODE", "glabs-webhook");
    const options: ImageOptions = {
      modelId: GLABS_IMAGE_MODEL, prompt: body.prompt as string, mode,
      ...(provided as Partial<ImageOptions>),
      ...(sources.length ? { referenceImageUrls: sources as string[] } : {}),
    };
    const provider = createProvider({ name: "glabs-webhook", apiKey: body.apiKey as string, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "" });
    if (!provider.submitImageTask) throw new Error("G-Labs image task support unavailable");
    const { taskId, modelId } = await provider.submitImageTask(options);
    return await waitAndPersist(provider, taskId, modelId, "image", body, mode);
  } catch (error) { return errorResponse(error); }
}

export async function handleGlabsVideo(body: Record<string, unknown>): Promise<NextResponse> {
  try {
    validInputs(body, ["imageUrl", "lastImageUrl", "referenceVideoUrls", "referenceImageUrls", "referenceAudioUrls"]);
    if (body.model !== GLABS_VIDEO_MODEL) throw new ProviderError("Choose Meta Muse in G-Labs video picker", "GLABS_BAD_MODEL", "glabs-webhook");
    const provided = checkedOptions(body.options, videoKeys);
    if (body.referenceVideoUrls !== undefined || body.referenceImageUrls !== undefined || body.referenceAudioUrls !== undefined)
      throw new ProviderError("Meta video supports only named start/end image, not generic references", "GLABS_UNSUPPORTED_OPTION", "glabs-webhook");
    if (body.controlPlan !== undefined) {
      const plan = body.controlPlan;
      if (!isRecord(plan) || plan.audioMode === "native" || plan.mode === "video-to-video" ||
        (typeof plan.referenceCount === "number" && plan.referenceCount >
          Number(Boolean(body.imageUrl)) + Number(Boolean(body.lastImageUrl)))) {
        throw new ProviderError("Meta cannot honor this control plan (reference pack, native audio or reference video).", "GLABS_UNSUPPORTED_OPTION", "glabs-webhook");
      }
    }
    const mode = body.mode ?? (body.imageUrl ? "image-to-video" : "text-to-video");
    if (mode !== "image-to-video" && mode !== "text-to-video")
      throw new ProviderError("Meta does not support reference-to-video mode", "GLABS_BAD_MODE", "glabs-webhook");
    const options: VideoOptions = {
      modelId: GLABS_VIDEO_MODEL, mode, prompt: body.prompt as string,
      ...(provided as Partial<VideoOptions>),
      ...(body.imageUrl !== undefined ? { firstFrameUrl: body.imageUrl as string } : {}),
      ...(body.lastImageUrl !== undefined ? { lastFrameUrl: body.lastImageUrl as string } : {}),
    };
    const provider = createProvider({ name: "glabs-webhook", apiKey: body.apiKey as string, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "" });
    if (!provider.submitVideoTask) throw new Error("G-Labs video task support unavailable");
    const { taskId, modelId } = await provider.submitVideoTask(options);
    return await waitAndPersist(provider, taskId, modelId, "video", body, mode);
  } catch (error) { return errorResponse(error); }
}
