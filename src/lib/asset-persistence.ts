import { constants, existsSync } from "fs";
import { copyFile, mkdir, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { basename, extname, join, relative, sep } from "path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets } from "@/lib/db/schema";
import { validateMediaFile, validateOrDelete } from "@/lib/media-validate";
import { getDataDir, getUploadsDir } from "@/lib/paths";
import { MAX_DOWNLOAD_BYTES } from "@/lib/providers/stock-types";
import { resolveUploadFilePath } from "@/lib/remote-image";
import { sanitizeGenerationControlSummary, type GenerationControlSummary } from "@/lib/video-repair-plan";
import { extractLastFrame, LAST_FRAME_SUFFIX } from "@/lib/video-composer/frame-extract";

const SAFE_ID = /^[a-zA-Z0-9-]+$/;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

function extensionForMime(mime: string): "png" | "webp" | "mp4" | "jpg" {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("mp4") || mime.includes("video")) return "mp4";
  return "jpg";
}

async function assertValidMedia(absPath: string, ext: string): Promise<void> {
  const kind = ext === "mp4" ? "video" : "image";
  if (!(await validateOrDelete(absPath, kind))) throw new Error("素材文件校验失败（下载内容损坏或非媒体文件），请重新生成");
}

async function materializeGlabsSource(projectId: string, sourceUrl: string): Promise<string> {
  const match = /^\/api\/files\/glabs-webhook\/([a-f0-9]{64}\.(?:png|jpg|webp|mp4))$/i.exec(sourceUrl);
  if (!match) throw new Error("Invalid G-Labs managed media path");
  const glabsRoot = await realpath(join(getUploadsDir(), "glabs-webhook"));
  const source = await realpath(join(glabsRoot, match[1]));
  const rel = relative(glabsRoot, source);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep))
    throw new Error("G-Labs media escaped its managed uploads directory");
  const info = await stat(source);
  const ext = extname(source).toLowerCase();
  const kind = ext === ".mp4" ? "video" : "image";
  const sizeLimit = kind === "video" ? MAX_DOWNLOAD_BYTES : 24 * 1024 * 1024;
  if (!info.isFile() || info.size <= 0 || info.size > sizeLimit) throw new Error("Invalid or oversized G-Labs media file");
  if (!(await validateMediaFile(source, kind))) throw new Error("G-Labs media metadata is invalid");

  const directory = join(getUploadsDir(), projectId);
  await mkdir(directory, { recursive: true });
  const fileName = `glabs-${basename(source)}`;
  const target = join(directory, fileName);
  if (existsSync(target)) {
    if (await validateMediaFile(target, kind)) return `/api/files/${projectId}/${fileName}`;
    await unlink(target);
  }
  const part = join(directory, `.${fileName}.${randomUUID()}.part`);
  try {
    await copyFile(source, part, constants.COPYFILE_EXCL);
    const copied = await stat(part);
    if (!copied.isFile() || copied.size !== info.size || !(await validateOrDelete(part, kind)))
      throw new Error("Project-owned G-Labs media copy failed validation");
    try { await rename(part, target); }
    catch (error) {
      if (!existsSync(target) || !(await validateMediaFile(target, kind))) throw error;
    }
  } finally {
    await unlink(part).catch(() => {});
  }
  return `/api/files/${projectId}/${fileName}`;
}

/** Persist an expiring provider URL or data URI under the project's uploads directory. */
export async function persistAssetSource(projectId: string, sourceUrl: string, shotId: number, prefix = "asset"): Promise<string> {
  if (!SAFE_ID.test(projectId)) throw new Error("无效的项目ID");
  if (sourceUrl.startsWith("/api/files/glabs-webhook/")) return materializeGlabsSource(projectId, sourceUrl);
  if (sourceUrl.startsWith("/api/files/")) {
    const local = resolveUploadFilePath(sourceUrl);
    if (!local || !existsSync(local)) throw new Error("本地素材文件不存在");
    return sourceUrl;
  }

  let bytes: Buffer;
  let mime = "image/jpeg";
  if (sourceUrl.startsWith("data:")) {
    const comma = sourceUrl.indexOf(",");
    if (comma === -1) throw new Error("无法解析 data URI 素材");
    const meta = sourceUrl.slice(5, comma);
    const payload = sourceUrl.slice(comma + 1);
    mime = meta.split(";")[0] || "image/png";
    bytes = /;base64/i.test(meta) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } else if (/^https?:\/\//.test(sourceUrl)) {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`下载素材失败: ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error(`素材体积 ${declared} 超过上限 ${MAX_DOWNLOAD_BYTES}`);
    bytes = Buffer.from(await response.arrayBuffer());
    mime = response.headers.get("content-type") || mime;
  } else {
    throw new Error("不支持的素材来源");
  }

  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`素材体积 ${bytes.byteLength} 超过上限 ${MAX_DOWNLOAD_BYTES}`);
  const ext = extensionForMime(mime);
  const directory = join(getDataDir(), "uploads", projectId);
  await mkdir(directory, { recursive: true });
  const safePrefix = prefix.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40) || "asset";
  const fileName = `${safePrefix}-${shotId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const absolutePath = join(directory, fileName);
  await writeFile(absolutePath, bytes);
  await assertValidMedia(absolutePath, ext);
  return `/api/files/${projectId}/${fileName}`;
}

export interface SaveAssetCandidateInput {
  projectId: string;
  shotId: number;
  filePath: string;
  type?: "ai_generated" | "product_image" | "user_upload" | "stock_footage";
  thumbnailPath?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  generationPlan?: GenerationControlSummary | null;
}

/** Insert a validated take and atomically make it the active composition input. */
export async function saveAssetCandidate(input: SaveAssetCandidateInput) {
  if (!SAFE_ID.test(input.projectId)) throw new Error("无效的项目ID");
  const db = getDb();
  let lastFrameUrl: string | undefined;
  if (VIDEO_EXT.test(input.filePath) && input.filePath.startsWith(`/api/files/${input.projectId}/`)) {
    const absolutePath = resolveUploadFilePath(input.filePath);
    if (!absolutePath || !existsSync(absolutePath)) throw new Error("本地素材文件不存在");
    const frame = await extractLastFrame(absolutePath);
    if (frame) lastFrameUrl = `${input.filePath}${LAST_FRAME_SUFFIX}`;
  }
  const generationPlan = input.generationPlan ? sanitizeGenerationControlSummary(input.generationPlan) : null;
  const rows = db.transaction((transaction) => {
    transaction.update(assets).set({ selected: false }).where(and(eq(assets.projectId, input.projectId), eq(assets.shotId, input.shotId))).run();
    return transaction.insert(assets).values({
      projectId: input.projectId,
      shotId: input.shotId,
      type: input.type ?? "ai_generated",
      filePath: input.filePath,
      ...(input.thumbnailPath?.startsWith("/api/files/") && { thumbnailPath: input.thumbnailPath }),
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      generationPlan,
      selected: true,
      status: "done",
    }).returning().all();
  });
  return { ...rows[0], ...(lastFrameUrl && { lastFrameUrl }) };
}
