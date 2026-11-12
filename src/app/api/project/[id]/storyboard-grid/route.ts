import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { ProviderError } from "@/lib/providers/base";
import { getDb } from "@/lib/db";
import { scripts } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createProvider } from "@/lib/providers";
import { toRemoteUsableImage } from "@/lib/remote-image";
import { buildStoryboardGridPrompt, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import { finalizeStoryboardGrid, storyboardGridMode } from "@/lib/storyboard-grid-finalizer";
import { apiError, errText } from "@/lib/api-error";

/**
 * POST /api/project/[id]/storyboard-grid — one-image consistency anchoring.
 *
 * Renders ALL shots of a script as a single 3x3 storyboard grid (same person /
 * outfit / room / light physically guaranteed by being one generation), then
 * crops each cell into that shot's keyframe asset. The existing per-shot i2v
 * pass ("animate") picks the keyframes up from there. Scripts with more than 9
 * shots are rejected honestly instead of silently truncated.
 *
 * body: { scriptId, provider, model, apiKey, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return apiError(req, "无效的项目ID", "Invalid project id", 400);
    }
    const body = await req.json();
    const { scriptId, provider: providerName, model, apiKey, baseUrl, options, characterSheetUrl, productImageUrl } = body as {
      scriptId?: string;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
      /** Presenter's multi-view sheet — locks the person's identity across all nine cells */
      characterSheetUrl?: string;
      /** Product photo — locks the product's appearance across all nine cells */
      productImageUrl?: string;
    };
    if (!scriptId || !providerName || !model) {
      return apiError(req, "缺少 scriptId / provider / model", "Missing scriptId / provider / model", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置生图平台", "Missing API key — configure an image provider in settings first", 400);
    }

    const db = getDb();
    const [script] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const shots = Array.isArray(script.shots) ? script.shots : [];
    if (shots.length < 2) {
      return apiError(req, "分镜太少，九宫格至少需要 2 个分镜", "Too few shots — the grid needs at least 2", 400);
    }
    if (shots.length > GRID_MAX_SHOTS) {
      return apiError(
        req,
        `九宫格最多放 ${GRID_MAX_SHOTS} 个分镜（当前 ${shots.length} 个）——适合短脚本；长脚本请用逐镜生成+链式首尾帧`,
        `The grid holds at most ${GRID_MAX_SHOTS} shots (this script has ${shots.length}) — use per-shot generation with keyframe chaining for longer scripts`,
        400
      );
    }

    // reference images (order matters — the prompt cites them by position):
    // [character sheet?, product photo?]; local /api/files paths travel as Base64
    const refInputs = [characterSheetUrl, productImageUrl].filter((u): u is string => !!u);
    const referenceImageUrls = providerName === "glabs-webhook"
      ? refInputs // validate locally with glabsImageDataUri; don't forward arbitrary HTTP URLs
      : (await Promise.all(refInputs.map(toRemoteUsableImage))).filter((u): u is string => !!u);

    // 1) one generation renders every shot — consistency is physical, not prompted;
    // with references attached the sheet pins the person and the photo pins the product
    const prompt = buildStoryboardGridPrompt(shots, script.characters, {
      characterSheet: !!characterSheetUrl,
      productImage: !!productImageUrl,
    });
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const imageOptions = {
      ...(options ?? {}),
      modelId: model,
      mode: referenceImageUrls.length > 0 ? "image-to-image" as const : "text-to-image" as const,
      ...(referenceImageUrls.length > 0 && { referenceImageUrls }),
      prompt,
    };
    let result;
    let workflowTaskId: string;
    let rowId: string | null = null;
    if (providerName === "glabs-webhook" && provider.submitImageTask && provider.waitForTask) {
      // Grid is a paid image job too: persist the ID before waiting, same as Assets.
      const { taskId, modelId } = await provider.submitImageTask(imageOptions);
      workflowTaskId = taskId;
      rowId = await recordAiTask({ projectId: id, provider: providerName,
        model: modelId, mediaType: "image", mode: storyboardGridMode(scriptId), prompt, taskId });
      if (!rowId) return NextResponse.json({
        error: "G-Labs accepted the task but SQLite persistence failed. Save the task ID and do not resubmit.",
        taskId, recoverable: true,
      }, { status: 503 });
      try {
        const finished = await provider.waitForTask(taskId, { interval: 5000 });
        if (!finished.result || !("imageUrls" in finished.result) || !finished.result.imageUrls?.length)
          throw new ProviderError("G-Labs returned no grid image", "GLABS_NO_RESULT", "glabs-webhook");
        result = finished.result;
        // Remote completion is not workflow completion: keep the paid task recoverable
        // until every local crop and asset row has been finalized.
        await updateAiTask(rowId, { status: "processing", resultUrls: result.imageUrls, error: null });
      } catch (error) {
        const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
        await updateAiTask(rowId, { status: failed ? "failed" : "unknown", error: "Storyboard grid task needs manual recovery" });
        return NextResponse.json({ error: "Storyboard grid task needs manual recovery; do not resubmit",
          taskId, recoverable: !failed }, { status: failed ? 500 : 504 });
      }
    } else {
      result = await provider.generateImage(imageOptions);
      workflowTaskId = /^[a-zA-Z0-9_-]{1,160}$/.test(result.taskId)
        ? result.taskId
        : "local-" + createHash("sha256").update(result.taskId + prompt).digest("hex").slice(0, 32);
    }
    const gridUrl = result.imageUrls?.[0];
    if (!gridUrl) throw new Error("生图未返回图片");

    try {
      const finalized = await finalizeStoryboardGrid({
        projectId: id,
        taskId: workflowTaskId,
        mode: storyboardGridMode(scriptId),
        provider: providerName,
        model,
        sourceUrl: gridUrl,
      });
      await updateAiTask(rowId, { status: "completed", resultUrls: [finalized.gridPath], error: null });
      return NextResponse.json(finalized);
    } catch (error) {
      await updateAiTask(rowId, {
        status: "unknown",
        resultUrls: [gridUrl],
        error: "Storyboard Grid finalization needs recovery",
      });
      if (rowId) return NextResponse.json({
        error: error instanceof Error ? error.message : "Storyboard Grid finalization needs recovery",
        taskId: workflowTaskId,
        recoverable: true,
      }, { status: 500 });
      throw error;
    }
  } catch (error) {
    console.error("九宫格分镜生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "九宫格分镜生成失败", "Storyboard grid failed") },
      { status: 500 }
    );
  }
}
