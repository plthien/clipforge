/**
 * G-Labs Webhook v5.0.8+ media adapter.
 * The only wire endpoints used for generation are /api/openai/generate and
 * /api/meta/generate. meta_muse is a ClipForge-only catalog alias.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { BaseProvider, ProviderError } from "./base";
import { getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { validateOrDelete } from "@/lib/media-validate";
import type { ImageOptions, ImageResult, MediaType, Model, ProviderConfig, TaskStatus, VideoOptions, VideoResult } from "./types";

export const GLABS_DEFAULT_ORIGIN = "http://127.0.0.1:8765";
export const GLABS_IMAGE_MODEL = "glabs-gpt-image-2";
export const GLABS_VIDEO_MODEL = "meta_muse";
const PROVIDER = "glabs-webhook";
const BODY_LIMIT = 50 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
/** Shared cap for both G-Labs result download and project-owned materialization. */
export const GLABS_VIDEO_FILE_LIMIT = 512 * 1024 * 1024;
const IMAGE_RATIOS = ["1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"];
const VIDEO_RATIOS = ["9:16", "16:9", "1:1"];
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function fail(message: string, code = "GLABS_PREFLIGHT"): never {
  throw new ProviderError(message, code, PROVIDER);
}

/** A fixed loopback host with an optional numeric port is the only allowed origin. */
export function glabsOrigin(input?: string): string {
  const value = input?.trim() || GLABS_DEFAULT_ORIGIN;
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(value);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail("G-Labs chỉ cho phép http://127.0.0.1:PORT (1–65535)", "GLABS_BAD_ORIGIN");
  return "http://127.0.0.1:" + port;
}

function imageMime(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** No arbitrary HTTP URL or filesystem path may become a private G-Labs image reference. */
export async function glabsImageDataUri(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value) return fail("Ảnh tham chiếu phải là data URI hoặc /api/files/...", "GLABS_BAD_REFERENCE");
  let bytes: Buffer;
  if (value.startsWith("data:")) {
    const match = /^data:(image\/png|image\/jpeg|image\/webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length > Math.ceil(IMAGE_LIMIT * 4 / 3) + 4) return fail("Data URI ảnh không hợp lệ hoặc quá lớn", "GLABS_BAD_REFERENCE");
    bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2]) return fail("Base64 ảnh không hợp lệ", "GLABS_BAD_REFERENCE");
    if (imageMime(bytes) !== match[1]) return fail("Kiểu nội dung ảnh không khớp dữ liệu", "GLABS_BAD_REFERENCE");
  } else {
    if (!/^\/api\/files\/[a-zA-Z0-9_.%/-]+$/.test(value) || /%(?:2f|5c|2e|25)/i.test(value))
      return fail("Chỉ nhận ảnh đã lưu trong uploads của ClipForge", "GLABS_BAD_REFERENCE");
    let segments: string[];
    try { segments = value.slice("/api/files/".length).split("/").map(decodeURIComponent); }
    catch { return fail("Đường dẫn ảnh không hợp lệ", "GLABS_BAD_REFERENCE"); }
    if (segments.some((s) => !s || s === "." || s === ".." || s.includes("\\") || s.includes(":") || s.includes("%")))
      return fail("Đường dẫn ảnh không hợp lệ", "GLABS_BAD_REFERENCE");
    const root = await realpath(getUploadsDir());
    const path = join(root, ...segments);
    const actual = await realpath(path).catch(() => fail("Không tìm thấy ảnh trong uploads", "GLABS_BAD_REFERENCE"));
    const rel = relative(root, actual);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep))
      return fail("Ảnh tham chiếu nằm ngoài uploads", "GLABS_BAD_REFERENCE");
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0 || info.size > IMAGE_LIMIT || !IMAGE_MIME[extname(actual).toLowerCase()])
      return fail("Ảnh tham chiếu không hỗ trợ hoặc quá lớn", "GLABS_BAD_REFERENCE");
    bytes = await readFile(actual);
    if (imageMime(bytes) !== IMAGE_MIME[extname(actual).toLowerCase()])
      return fail("Chữ ký file ảnh không hợp lệ", "GLABS_BAD_REFERENCE");
  }
  if (!bytes.length || bytes.length > IMAGE_LIMIT || !imageMime(bytes))
    return fail("Ảnh tham chiếu không hợp lệ hoặc quá lớn", "GLABS_BAD_REFERENCE");
  return "data:" + imageMime(bytes) + ";base64," + bytes.toString("base64");
}

function ratio(width?: number, height?: number, allowed: string[] = IMAGE_RATIOS): string {
  if (width === undefined && height === undefined) return "9:16";
  if (!Number.isInteger(width) || !Number.isInteger(height) || !width || !height || width < 1 || height < 1)
    return fail("Chiều rộng/cao không hợp lệ", "GLABS_BAD_SIZE");
  const match = allowed.find((entry) => {
    const [w, h] = entry.split(":").map(Number);
    return Math.abs(width / height - w / h) <= 0.012;
  });
  return match ?? fail("Tỷ lệ khung hình không được G-Labs hỗ trợ", "GLABS_BAD_RATIO");
}

function rejectUnknown(options: Record<string, unknown>, fields: string[]) {
  for (const [key, value] of Object.entries(options)) {
    if (!fields.includes(key) && value !== undefined && value !== null && value !== "")
      fail("G-Labs không hỗ trợ tùy chọn " + key + ". Vui lòng bỏ tùy chọn trước khi tạo job tính phí.", "GLABS_UNSUPPORTED_OPTION");
  }
}

function strEnum(value: unknown, allowed: string[], fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) return fail("Tham số không được G-Labs hỗ trợ", "GLABS_BAD_PARAMETER");
  return value;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("Phản hồi G-Labs không đúng định dạng JSON", "GLABS_BAD_RESPONSE");
  return payload as Record<string, unknown>;
}

function normalizedFailureCode(value: unknown): number {
  const parsed = typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]{0,2})$/.test(value)
      ? Number(value)
      : 0;
  return parsed >= 0 && parsed <= 999 ? parsed : 0;
}

function safeFailure(code: number): { category: string; message: string } {
  switch (code) {
    case 429: return { category: "quota", message: "G-Labs quota or rate limit reached (429). Do not resubmit automatically; check quota before a new paid job." };
    case 401: return { category: "authentication", message: "G-Labs authentication failed (401). Check the Webhook API key." };
    case 403: return { category: "permission", message: "G-Labs permission denied (403). Check MAX-tier and account eligibility." };
    case 400: return { category: "invalid-request", message: "G-Labs rejected the generation request (400). Review supported inputs before submitting another job." };
    case 500: return { category: "server", message: "G-Labs generation failed on the local service (500). Inspect G-Labs safely; no automatic paid retry was made." };
    default: return { category: "unknown", message: code === 0
      ? "G-Labs generation failed with no classified error code. Inspect the local application without exposing account details."
      : `G-Labs generation failed with code ${code}. Inspect the local application; no automatic paid retry was made.` };
  }
}

export class GlabsWebhookProvider extends BaseProvider {
  readonly name = PROVIDER;
  readonly displayName = "G-Labs Webhook";
  constructor(config: ProviderConfig) {
    super({ ...config, baseUrl: glabsOrigin(config.baseUrl), timeout: config.timeout || 120_000 });
  }
  protected getAuthHeaders(): Record<string, string> {
    return { "X-API-Key": this.config.apiKey };
  }
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      { id: GLABS_IMAGE_MODEL, name: "GPT Image 2 · G-Labs", mediaType: "image", provider: this.name,
        modes: ["text-to-image", "image-to-image"], description: "G-Labs local Webhook; max 5 positional images; native output ≈1.57 MP, no 4K" },
      { id: GLABS_VIDEO_MODEL, name: "Meta Muse · G-Labs", mediaType: "video", provider: this.name,
        modes: ["text-to-video", "image-to-video"], supportsAudio: false,
        description: "Meta AI · 480p/720p · runtime duration not selectable; image-to-video with start/end" },
    ];
    return mediaType ? models.filter((m) => m.mediaType === mediaType) : models;
  }

  /** No automatic retry on POST, including 429 and 5xx. A lost acknowledgment may have been billed. */
  private async submit(endpoint: "/api/openai/generate" | "/api/meta/generate", payload: Record<string, unknown>): Promise<string> {
    if (!this.config.apiKey || typeof this.config.apiKey !== "string") return fail("Thiếu G-Labs Webhook API key", "GLABS_NO_KEY");
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > BODY_LIMIT) return fail("Payload G-Labs vượt 50 MB", "GLABS_BODY_LIMIT");
    let response: Response;
    try {
      response = await fetch(this.config.baseUrl + endpoint, {
        method: "POST", headers: { ...this.getAuthHeaders(), "Content-Type": "application/json" },
        body, signal: AbortSignal.timeout(this.config.timeout ?? 120_000), redirect: "error", cache: "no-store",
      });
    } catch {
      return fail("Không nhận được xác nhận từ G-Labs. Job có thể đã được tính phí; đừng POST lại khi chưa đối soát.", "GLABS_SUBMIT_UNCERTAIN");
    }
    if (response.status !== 202) {
      if (response.status === 401) return fail("G-Labs Webhook key sai hoặc hết hạn", "GLABS_AUTH");
      if (response.status === 403) return fail("G-Labs cần gói MAX hoặc tài khoản có quyền", "GLABS_FORBIDDEN");
      if (response.status === 413) return fail("Ảnh hoặc request vượt giới hạn 50 MB", "GLABS_BODY_LIMIT");
      if (response.status === 429) return fail("G-Labs đang giới hạn số lượt, không tự thử lại", "GLABS_RATE_LIMIT");
      return fail("G-Labs không xác nhận tạo job (HTTP " + response.status + "). Đối soát trước khi thử lại.", "GLABS_SUBMIT_UNCERTAIN");
    }
    const ack = await jsonResponse(response).catch(() =>
      fail("G-Labs đã trả HTTP 202 nhưng ACK không đọc được; đối soát trước khi thử lại", "GLABS_SUBMIT_UNCERTAIN"));
    if (typeof ack.task_id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(ack.task_id) || ack.status !== "pending")
      return fail("G-Labs 202 thiếu task_id hợp lệ; đối soát trước khi thử lại", "GLABS_SUBMIT_UNCERTAIN");
    return ack.task_id;
  }

  async submitImageTask(options: ImageOptions): Promise<{ taskId: string; modelId: string }> {
    if (options.modelId !== GLABS_IMAGE_MODEL) return fail("Sai model ảnh G-Labs", "GLABS_BAD_MODEL");
    if (!["text-to-image", "image-to-image"].includes(options.mode)) return fail("Sai chế độ tạo ảnh", "GLABS_BAD_MODE");
    if (!options.prompt?.trim()) return fail("Thiếu mô tả ảnh", "GLABS_BAD_PROMPT");
    if (options.count !== undefined && options.count !== 1) return fail("GPT Image 2 Webhook chỉ trả 1 ảnh/job", "GLABS_UNSUPPORTED_OPTION");
    rejectUnknown({ negativePrompt: options.negativePrompt, guidanceScale: options.guidanceScale, steps: options.steps, seed: options.seed }, []);
    const extra = options.extra ?? {};
    rejectUnknown(extra, ["quality", "prompt_mode", "reasoning", "web_search", "aspect_ratio"]);
    const sources = options.referenceImageUrls?.length ? options.referenceImageUrls :
      options.referenceImageUrl ? [options.referenceImageUrl] : [];
    if (sources.length > 5) return fail("GPT Image 2 tối đa 5 ảnh tham chiếu", "GLABS_BAD_REFERENCE");
    if (options.mode === "image-to-image" && !sources.length) return fail("Cần ít nhất 1 ảnh tham chiếu", "GLABS_BAD_REFERENCE");
    if (options.mode === "text-to-image" && sources.length) return fail("Có ảnh tham chiếu, hãy chọn image-to-image", "GLABS_BAD_MODE");
    const references = await Promise.all(sources.map(glabsImageDataUri));
    const expectedAspect = ratio(options.width, options.height);
    const aspect = extra.aspect_ratio === undefined ? expectedAspect : strEnum(extra.aspect_ratio, IMAGE_RATIOS, "9:16");
    if ((options.width !== undefined || options.height !== undefined) && aspect !== expectedAspect)
      return fail("G-Labs aspect_ratio xung đột với kích thước đã chọn", "GLABS_BAD_RATIO");
    const taskId = await this.submit("/api/openai/generate", {
      prompt: options.prompt.trim(), aspect_ratio: aspect,
      quality: strEnum(extra.quality, ["low", "medium", "high"], "high"),
      prompt_mode: strEnum(extra.prompt_mode, ["auto", "direct"], "direct"),
      reasoning: strEnum(extra.reasoning, ["none", "low", "medium", "high", "xhigh", "max"], "none"),
      web_search: extra.web_search === undefined ? false : extra.web_search === true ? true : extra.web_search === false ? false : fail("web_search phải là boolean", "GLABS_BAD_PARAMETER"),
      ...(references.length ? { reference_images: references } : {}),
    });
    return { taskId, modelId: options.modelId };
  }

  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    if (options.modelId !== GLABS_VIDEO_MODEL) return fail("Sai model video G-Labs", "GLABS_BAD_MODEL");
    if (!["text-to-video", "image-to-video"].includes(options.mode)) return fail("Meta chỉ hỗ trợ t2v hoặc i2v", "GLABS_BAD_MODE");
    if (!options.prompt?.trim()) return fail("Thiếu mô tả video", "GLABS_BAD_PROMPT");
    rejectUnknown({
      duration: options.duration, fps: options.fps, negativePrompt: options.negativePrompt, audioEnabled: options.audioEnabled,
      audioPrompt: options.audioPrompt, voiceover: options.voiceover, openaiSize: options.openaiSize,
      referenceImageUrls: options.referenceImageUrls?.length ? options.referenceImageUrls : undefined,
      referenceVideoUrl: options.referenceVideoUrl, referenceVideoUrls: options.referenceVideoUrls?.length ? options.referenceVideoUrls : undefined,
      referenceAudioUrls: options.referenceAudioUrls?.length ? options.referenceAudioUrls : undefined,
      guidanceScale: options.guidanceScale, motionStrength: options.motionStrength, seed: options.seed,
    }, []);
    const extra = options.extra ?? {};
    rejectUnknown(extra, ["resolution", "count", "aspect_ratio"]);
    const resolution = strEnum(extra.resolution, ["480p", "720p"], "720p");
    const count = extra.count ?? 1;
    if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 4) return fail("Meta count phải từ 1 đến 4", "GLABS_BAD_PARAMETER");
    const expectedAspect = ratio(options.width, options.height, VIDEO_RATIOS);
    const aspect = extra.aspect_ratio === undefined ? expectedAspect : strEnum(extra.aspect_ratio, VIDEO_RATIOS, "9:16");
    if ((options.width !== undefined || options.height !== undefined) && aspect !== expectedAspect)
      return fail("G-Labs aspect_ratio xung đột với kích thước đã chọn", "GLABS_BAD_RATIO");
    if (options.mode === "image-to-video" && !options.firstFrameUrl) return fail("Meta i2v yêu cầu start_image", "GLABS_BAD_REFERENCE");
    if (options.mode === "text-to-video" && (options.firstFrameUrl || options.lastFrameUrl)) return fail("Meta t2v không nhận ảnh đầu/cuối", "GLABS_BAD_MODE");
    const start = options.firstFrameUrl ? await glabsImageDataUri(options.firstFrameUrl) : undefined;
    const end = options.lastFrameUrl ? await glabsImageDataUri(options.lastFrameUrl) : undefined;
    const taskId = await this.submit("/api/meta/generate", {
      prompt: options.prompt.trim(), mode: options.mode === "image-to-video" ? "i2v" : "t2v",
      aspect_ratio: aspect, resolution, count,
      ...(start ? { start_image: start } : {}), ...(end ? { end_image: end } : {}),
    });
    return { taskId, modelId: options.modelId };
  }

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const { taskId } = await this.submitImageTask(options);
    const status = await this.waitForTask(taskId);
    const result = this.requireResult(status.result);
    if (!("imageUrls" in result)) return fail("G-Labs không trả ảnh", "GLABS_BAD_RESULT");
    return result;
  }
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options);
    const status = await this.waitForTask(taskId);
    const result = this.requireResult(status.result);
    if (!("videoUrls" in result)) return fail("G-Labs không trả video", "GLABS_BAD_RESULT");
    return result;
  }

  /** Only download files explicitly located under this configured origin's /api/files/{name}. */
  private resultFile(raw: string): { url: string; ext: string } {
    let parsed: URL;
    try { parsed = new URL(raw, this.config.baseUrl); }
    catch { return fail("URL kết quả G-Labs không hợp lệ", "GLABS_RESULT_URL"); }
    if (parsed.origin !== this.config.baseUrl || parsed.search || parsed.hash ||
      !/^\/api\/files\/[a-zA-Z0-9_.%-]+$/.test(parsed.pathname) ||
      /%(?:2f|5c|2e|25)/i.test(parsed.pathname))
      return fail("Từ chối URL kết quả ngoài G-Labs hoặc có đường dẫn đáng ngờ", "GLABS_RESULT_URL");
    let name: string;
    try { name = decodeURIComponent(parsed.pathname.slice("/api/files/".length)); }
    catch { return fail("Tên file G-Labs không hợp lệ", "GLABS_RESULT_URL"); }
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes(":"))
      return fail("Tên file G-Labs không hợp lệ", "GLABS_RESULT_URL");
    const ext = extname(name).toLowerCase();
    if (!IMAGE_MIME[ext] && ext !== ".mp4") return fail("Loại file G-Labs không hỗ trợ", "GLABS_RESULT_TYPE");
    return { url: this.config.baseUrl + parsed.pathname, ext: ext === ".jpeg" ? ".jpg" : ext };
  }

  private async download(raw: string, taskId: string, index: number): Promise<{ url: string; ext: string; duration?: number; hasAudio?: boolean; width?: number; height?: number; fps?: number }> {
    const file = this.resultFile(raw);
    const folder = join(getUploadsDir(), "glabs-webhook");
    const filename = createHash("sha256").update(taskId + ":" + index + ":" + file.url).digest("hex") + file.ext;
    const target = join(folder, filename);
    const localUrl = "/api/files/glabs-webhook/" + filename;
    await mkdir(folder, { recursive: true });
    if (!existsSync(target)) {
      const response = await fetch(file.url, {
        method: "GET", headers: this.getAuthHeaders(), redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) return fail("G-Labs không còn file kết quả; job có thể đã bị xóa khi app khởi động lại", "GLABS_RESULT_UNAVAILABLE");
      const cap = file.ext === ".mp4" ? GLABS_VIDEO_FILE_LIMIT : IMAGE_LIMIT * 2;
      if (Number(response.headers.get("content-length")) > cap) return fail("Kết quả G-Labs vượt giới hạn tải", "GLABS_RESULT_TOO_LARGE");
      const part = target + "." + randomUUID() + ".part";
      let written = 0;
      try {
        const output = await open(part, "wx");
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            written += value.byteLength;
            if (written > cap) fail("Kết quả G-Labs vượt giới hạn tải", "GLABS_RESULT_TOO_LARGE");
            // FileHandle.writeFile appends to the current file position for each awaited chunk.
            await output.writeFile(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          await output.close();
        }
        if (!written) return fail("File G-Labs rỗng", "GLABS_RESULT_INVALID");
        const prefix = Buffer.alloc(16);
        const input = await open(part, "r");
        try { await input.read(prefix, 0, prefix.length, 0); }
        finally { await input.close(); }
        const fileSignatureOk = file.ext === ".mp4"
          ? prefix.toString("ascii", 4, 8) === "ftyp"
          : imageMime(prefix) === IMAGE_MIME[file.ext];
        if (!fileSignatureOk || !(await validateOrDelete(part, file.ext === ".mp4" ? "video" : "image")))
          return fail("Chữ ký hoặc dữ liệu file G-Labs không hợp lệ", "GLABS_RESULT_INVALID");
        if (!existsSync(target)) await rename(part, target);
      } finally { await unlink(part).catch(() => {}); }
    }
    if (!(await validateOrDelete(target, file.ext === ".mp4" ? "video" : "image")))
      return fail("File kết quả G-Labs bị hỏng", "GLABS_RESULT_INVALID");
    if (file.ext !== ".mp4") return { url: localUrl, ext: file.ext };
    const probe = await probeMedia(target);
    return { url: localUrl, ext: file.ext, duration: probe.duration, hasAudio: probe.hasAudio, width: probe.width, height: probe.height, fps: probe.frameRate };
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(taskId)) return fail("G-Labs task_id không hợp lệ", "GLABS_BAD_TASK");
    if (!this.config.apiKey) return fail("Thiếu Webhook API key", "GLABS_NO_KEY");
    let response: Response;
    try {
      response = await fetch(this.config.baseUrl + "/api/status/" + encodeURIComponent(taskId), {
        headers: this.getAuthHeaders(), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
    } catch { return fail("Không đọc được trạng thái G-Labs; task có thể vẫn đang chạy", "GLABS_STATUS_UNKNOWN"); }
    if (response.status === 404) return fail("Task không còn trong bộ nhớ G-Labs (có thể app đã restart); không tự tạo lại", "GLABS_STATUS_UNKNOWN");
    if (!response.ok) return fail("Không đọc được trạng thái G-Labs (HTTP " + response.status + ")", "GLABS_STATUS_UNKNOWN");
    const data = await jsonResponse(response);
    const mapping: Record<string, TaskStatus["status"]> = { pending: "pending", running: "processing", completed: "completed", failed: "failed" };
    const status = typeof data.status === "string" ? mapping[data.status] : undefined;
    if (!status) return fail("G-Labs trả trạng thái không xác định", "GLABS_BAD_RESPONSE");
    if (status === "failed") {
      const upstreamErrorCode = normalizedFailureCode(data.error_code);
      const failure = safeFailure(upstreamErrorCode);
      return {
        taskId, status, error: failure.message,
        // Keep the unified terminal classification consumed by waitForTask/routes.
        errorCode: "TASK_FAILED",
        // Never include error_detail: it may contain an account email or private data.
        extra: { upstreamErrorCode, upstreamErrorCategory: failure.category },
      };
    }
    if (status !== "completed") return { taskId, status };
    if (!Array.isArray(data.results) || !data.results.length || !data.results.every((r) => typeof r === "string") || data.results.length > 4)
      return fail("Task G-Labs completed nhưng thiếu danh sách results", "GLABS_BAD_RESPONSE");
    const files = [];
    for (let i = 0; i < data.results.length; i++) files.push(await this.download(data.results[i] as string, taskId, i));
    if (files.every((f) => f.ext === ".mp4")) return {
      taskId, status, result: { taskId, modelId: GLABS_VIDEO_MODEL,
        videoUrls: files.map((f) => f.url), duration: files[0].duration, hasAudio: files[0].hasAudio,
        extra: { clips: files.map((f) => ({ duration: f.duration, hasAudio: f.hasAudio, width: f.width, height: f.height, fps: f.fps })) } },
    };
    if (files.every((f) => f.ext !== ".mp4")) return {
      taskId, status, result: { taskId, modelId: GLABS_IMAGE_MODEL, imageUrls: files.map((f) => f.url) },
    };
    return fail("G-Labs trả nhiều loại media lẫn nhau", "GLABS_BAD_RESULT");
  }
}

/** Public health check is only reachability, never proof of authentication/account readiness. */
export async function checkGlabsHealth(baseUrl?: string): Promise<boolean> {
  const origin = glabsOrigin(baseUrl);
  try {
    const response = await fetch(origin + "/api/health", { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch { return false; }
}
