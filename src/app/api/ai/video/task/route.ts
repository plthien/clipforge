import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/base";
import { apiError, errText } from "@/lib/api-error";
import { findAiTaskByProviderTaskId, updateAiTask, updateAiTaskByProviderTaskId, type AiTaskStatus } from "@/lib/ai-tasks";
import type { TaskStatusEnum } from "@/lib/providers/types";
import { finalizeStoryboardGrid, parseStoryboardGridMode } from "@/lib/storyboard-grid-finalizer";

// Query / resume a previously submitted video task by its provider task ID (issue #16).
// POST because the request carries the API key — keys must never appear in URLs.
// body: { provider, apiKey, baseUrl?, taskId, wait? }
//   wait=false (default): single status check
//   wait=true: block until the task reaches a terminal state (resume flow)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(req, "请求体必须是 JSON 对象", "Request body must be a JSON object", 400);
  }
  const { provider: providerName, apiKey, baseUrl, taskId, wait, projectId } = body;

  if (!providerName || !taskId) {
    return apiError(req, "缺少必要参数（provider / taskId）", "Missing required parameters (provider / taskId)");
  }
  if (!apiKey) {
    return apiError(req, "缺少 API Key，请先在设置中配置对应平台", "Missing API Key, please configure the corresponding platform in settings first");
  }

  // map the provider's task status to the persisted ai_tasks status
  const toRowStatus = (s: TaskStatusEnum): AiTaskStatus =>
    s === "completed" ? "completed" : s === "failed" || s === "cancelled" ? "failed" : "processing";

  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });
    const persisted = await findAiTaskByProviderTaskId(providerName, taskId);
    const gridScriptId = parseStoryboardGridMode(persisted?.mode);

    if (gridScriptId) {
      if (!persisted?.projectId || typeof projectId !== "string" || projectId !== persisted.projectId) {
        return apiError(req, "九宫格任务与项目不匹配", "Storyboard Grid task does not belong to this project", 403);
      }
      const finalize = (sourceUrl?: string) => finalizeStoryboardGrid({
        projectId: persisted.projectId!,
        taskId: persisted.taskId,
        mode: persisted.mode,
        provider: persisted.provider,
        model: persisted.model,
        sourceUrl,
      });

      // A retained local Grid is authoritative recovery evidence. Finalize it before
      // contacting G-Labs, whose in-memory task history may have disappeared.
      try {
        const finalized = await finalize(persisted.resultUrls?.[0]);
        await updateAiTask(persisted.id, { status: "completed", resultUrls: [finalized.gridPath], error: null });
        return NextResponse.json({ taskId, status: "completed", workflow: "storyboard-grid", ...finalized });
      } catch {
        // No usable local source yet (or finalization is still incomplete): a read-only
        // status lookup may recover the already-paid result. Never submit a new job here.
      }

      try {
        const status = wait && provider.waitForTask
          ? await provider.waitForTask(taskId, { interval: 5000 })
          : await provider.getTaskStatus(taskId);
        if (status.status !== "completed") {
          await updateAiTask(persisted.id, {
            status: toRowStatus(status.status),
            error: status.error ?? null,
          });
          return NextResponse.json({ taskId, status: status.status, workflow: "storyboard-grid", error: status.error });
        }
        const sourceUrl = status.result && "imageUrls" in status.result ? status.result.imageUrls?.[0] : undefined;
        if (!sourceUrl) throw new ProviderError("G-Labs returned no storyboard Grid image", "GLABS_NO_RESULT", providerName);
        await updateAiTask(persisted.id, { status: "processing", resultUrls: [sourceUrl], error: null });
        const finalized = await finalize(sourceUrl);
        await updateAiTask(persisted.id, { status: "completed", resultUrls: [finalized.gridPath], error: null });
        return NextResponse.json({ taskId, status: "completed", workflow: "storyboard-grid", ...finalized });
      } catch (error) {
        const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
        const message = failed
          ? error.message
          : "Storyboard Grid needs recovery; the paid task was not resubmitted";
        await updateAiTask(persisted.id, { status: failed ? "failed" : "unknown", error: message });
        return NextResponse.json({ error: message, taskId, recoverable: !failed, workflow: "storyboard-grid" }, { status: failed ? 500 : 504 });
      }
    }

    try {
      const status = wait && provider.waitForTask
        ? await provider.waitForTask(taskId, { interval: 5000 })
        : await provider.getTaskStatus(taskId);

      const result = status.result;
      const videoUrls = result && "videoUrls" in result ? result.videoUrls : undefined;
      const imageUrls = result && "imageUrls" in result ? result.imageUrls : undefined;
      const resultUrls = videoUrls ?? imageUrls;

      await updateAiTaskByProviderTaskId(providerName, taskId, {
        status: toRowStatus(status.status),
        ...(resultUrls && { resultUrls }),
        error: status.error ?? null,
      });

      return NextResponse.json({
        taskId,
        status: status.status,
        videoUrls,
        imageUrls,
        ...(result && "duration" in result && { duration: result.duration }),
        ...(result && "hasAudio" in result && { hasAudio: result.hasAudio }),
        error: status.error,
      });
    } catch (error) {
      // definitive failure vs. lost contact — a paid task must never be downgraded to
      // "failed" just because we couldn't reach the status endpoint
      const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await updateAiTaskByProviderTaskId(providerName, taskId, {
        status: failed ? "failed" : "unknown",
        error: message,
      });
      return NextResponse.json(
        { error: message, taskId, recoverable: !failed },
        { status: failed ? 500 : 504 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "查询任务失败", "Task query failed") },
      { status: 500 }
    );
  }
}
