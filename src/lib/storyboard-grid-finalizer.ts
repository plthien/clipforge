import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, scripts } from "@/lib/db/schema";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { validateOrDelete } from "@/lib/media-validate";
import { getUploadsDir } from "@/lib/paths";
import { computeGridCells, GRID_MAX_SHOTS } from "@/lib/storyboard-grid";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9-]+$/;
const GRID_MODE_PREFIX = "storyboard-grid:v1:";
const GRID_SOURCE_LIMIT = 24 * 1024 * 1024;
const IMAGE_EXTENSIONS = ["png", "jpg", "webp"] as const;

export function storyboardGridMode(scriptId: string): string {
  if (!SAFE_ID.test(scriptId)) throw new Error("Invalid storyboard Grid script id");
  return GRID_MODE_PREFIX + scriptId;
}

export function parseStoryboardGridMode(mode: string | null | undefined): string | null {
  if (!mode?.startsWith(GRID_MODE_PREFIX)) return null;
  const scriptId = mode.slice(GRID_MODE_PREFIX.length);
  return SAFE_ID.test(scriptId) ? scriptId : null;
}

function taskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 32);
}

function extensionFromSource(sourceUrl: string): typeof IMAGE_EXTENSIONS[number] {
  const clean = sourceUrl.split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith(".webp") || sourceUrl.startsWith("data:image/webp")) return "webp";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg") || sourceUrl.startsWith("data:image/jpeg")) return "jpg";
  return "png";
}

async function validatedExisting(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 && info.size <= GRID_SOURCE_LIMIT && await validateOrDelete(path, "image");
  } catch {
    return false;
  }
}

async function findRetainedGrid(projectId: string, projectDir: string, key: string): Promise<{ absPath: string; publicPath: string } | null> {
  for (const ext of IMAGE_EXTENSIONS) {
    const fileName = `storyboard-grid-${key}.${ext}`;
    const absPath = join(projectDir, fileName);
    if (await validatedExisting(absPath)) return { absPath, publicPath: `/api/files/${projectId}/${fileName}` };
  }
  return null;
}

async function trustedLocalSource(sourceUrl: string): Promise<string | null> {
  if (!sourceUrl.startsWith("/api/files/")) return null;
  const encoded = sourceUrl.slice("/api/files/".length);
  if (!encoded || /%(?:2f|5c|2e|25)/i.test(encoded)) throw new Error("Invalid local Grid source path");
  let segments: string[];
  try { segments = encoded.split("/").map(decodeURIComponent); }
  catch { throw new Error("Invalid local Grid source path"); }
  if (segments.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":")))
    throw new Error("Invalid local Grid source path");
  const uploadsRoot = await realpath(getUploadsDir());
  const actual = await realpath(join(uploadsRoot, ...segments));
  const rel = relative(uploadsRoot, actual);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep))
    throw new Error("Grid source escaped the uploads directory");
  const info = await stat(actual);
  if (!info.isFile() || info.size <= 0 || info.size > GRID_SOURCE_LIMIT) throw new Error("Invalid Grid source file");
  return actual;
}

async function sourceBytes(sourceUrl: string): Promise<Buffer> {
  if (sourceUrl.startsWith("data:")) {
    const match = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(sourceUrl);
    if (!match) throw new Error("Invalid Grid image data URI");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > GRID_SOURCE_LIMIT || bytes.toString("base64") !== match[2]) throw new Error("Invalid or oversized Grid image");
    return bytes;
  }
  if (!/^https?:\/\//.test(sourceUrl)) throw new Error("Unsupported Grid image source");
  const response = await fetch(sourceUrl, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Failed to download storyboard Grid: ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > GRID_SOURCE_LIMIT) throw new Error("Storyboard Grid exceeds the download limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > GRID_SOURCE_LIMIT) throw new Error("Invalid or oversized Grid image");
  return bytes;
}

async function retainGridSource(projectId: string, taskId: string, sourceUrl?: string): Promise<{ absPath: string; publicPath: string }> {
  const projectDir = join(getUploadsDir(), projectId);
  await mkdir(projectDir, { recursive: true });
  const key = taskKey(taskId);
  const retained = await findRetainedGrid(projectId, projectDir, key);
  if (retained) return retained;
  if (!sourceUrl) throw new Error("The paid Grid task has no retained local source and G-Labs no longer has a result");

  const ext = extensionFromSource(sourceUrl);
  const fileName = `storyboard-grid-${key}.${ext}`;
  const target = join(projectDir, fileName);
  const part = join(projectDir, `.${fileName}.${randomUUID()}.part`);
  try {
    const local = await trustedLocalSource(sourceUrl);
    if (local) await copyFile(local, part, constants.COPYFILE_EXCL);
    else await writeFile(part, await sourceBytes(sourceUrl), { flag: "wx" });
    if (!(await validateOrDelete(part, "image"))) throw new Error("Storyboard Grid source is not a valid image");
    try { await rename(part, target); }
    catch (error) {
      if (!(await validatedExisting(target))) throw error;
    }
  } finally {
    await unlink(part).catch(() => {});
  }
  return { absPath: target, publicPath: `/api/files/${projectId}/${fileName}` };
}

export interface FinalizeStoryboardGridInput {
  projectId: string;
  taskId: string;
  mode: string | null;
  provider: string;
  model: string;
  sourceUrl?: string;
}

/** Finalize a paid Grid result exactly once; all files are ready before selected takes change. */
export async function finalizeStoryboardGrid(input: FinalizeStoryboardGridInput) {
  if (!SAFE_ID.test(input.projectId) || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.taskId))
    throw new Error("Invalid storyboard Grid workflow identity");
  const scriptId = parseStoryboardGridMode(input.mode);
  if (!scriptId) throw new Error("Invalid storyboard Grid workflow marker");
  const db = getDb();
  const [script] = await db.select().from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.projectId, input.projectId))).limit(1);
  if (!script) throw new Error("Storyboard Grid script does not belong to this project");
  const shots = Array.isArray(script.shots) ? script.shots : [];
  if (shots.length < 2 || shots.length > GRID_MAX_SHOTS) throw new Error(`Storyboard Grid requires 2-${GRID_MAX_SHOTS} shots`);
  const shotIds = shots.map((shot) => shot.shotId);
  if (shotIds.some((shotId) => !Number.isInteger(shotId)) || new Set(shotIds).size !== shotIds.length)
    throw new Error("Storyboard Grid requires unique integer shot ids");

  const projectDir = join(getUploadsDir(), input.projectId);
  const key = taskKey(input.taskId);
  const expected = shots.map((shot, index) => {
    const fileName = `storyboard-grid-${key}-shot-${shot.shotId}.png`;
    return {
      shotId: shot.shotId,
      index,
      description: shot.description ?? "",
      absPath: join(projectDir, fileName),
      filePath: `/api/files/${input.projectId}/${fileName}`,
    };
  });
  const existingRows = await db.select().from(assets).where(eq(assets.projectId, input.projectId));
  const matchingRow = (item: (typeof expected)[number], rows = existingRows) => rows.find((row) =>
    row.filePath === item.filePath && row.shotId === item.shotId && row.status === "done");
  const fileValidity = new Map<string, boolean>();
  for (const item of expected) fileValidity.set(item.filePath, await validatedExisting(item.absPath));

  // A fully finalized Grid is immutable recovery output. In particular, a later
  // manual take selection must survive every repeated resume.
  if (expected.every((item) => fileValidity.get(item.filePath) && matchingRow(item))) {
    const retained = await findRetainedGrid(input.projectId, projectDir, key);
    return {
      gridPath: retained?.publicPath ?? input.sourceUrl ?? expected[0].filePath,
      cells: expected.map(({ shotId, filePath }) => ({ shotId, filePath })),
      count: expected.length,
      finalizationState: "complete" as const,
    };
  }

  const hadPartialProgress = expected.some((item) => fileValidity.get(item.filePath) || matchingRow(item));
  const grid = await retainGridSource(input.projectId, input.taskId, input.sourceUrl);
  const { probeMedia } = await import("@/lib/media-probe");
  const probe = await probeMedia(grid.absPath);
  if (!probe.width || !probe.height) throw new Error("Cannot read storyboard Grid dimensions");
  const cells = computeGridCells(probe.width, probe.height);

  // Prepare and validate every missing crop before any DB selection changes.
  for (const item of expected) {
    if (!fileValidity.get(item.filePath)) {
      const fileName = item.filePath.split("/").pop()!;
      const target = item.absPath;
      const part = join(projectDir, `.${fileName}.${randomUUID()}.part.png`);
      try {
        const cell = cells[item.index];
        await execFileAsync(ffmpegBin(), ["-y", "-i", grid.absPath, "-vf", `crop=${cell.w}:${cell.h}:${cell.x}:${cell.y}`, "-frames:v", "1", part]);
        if (!(await validateOrDelete(part, "image"))) throw new Error(`Grid cell ${item.index + 1} is invalid`);
        try { await rename(part, target); }
        catch (error) {
          if (!(await validatedExisting(target))) throw error;
        }
      } finally {
        await unlink(part).catch(() => {});
      }
    }
    if (!(await validatedExisting(item.absPath))) throw new Error(`Grid cell ${item.index + 1} is unavailable after finalization`);
  }

  const committed = db.transaction((tx) => {
    const finalized: { shotId: number; filePath: string }[] = [];
    let inserted = 0;
    for (const item of expected) {
      const rows = tx.select().from(assets)
        .where(and(eq(assets.projectId, input.projectId), eq(assets.filePath, item.filePath))).all();
      let row = rows.find((candidate) => candidate.shotId === item.shotId && candidate.status === "done");
      if (rows.length && !row) throw new Error(`Storyboard Grid asset integrity mismatch for shot ${item.shotId}`);
      if (!row) {
        row = tx.insert(assets).values({
          projectId: input.projectId,
          shotId: item.shotId,
          type: "ai_generated",
          filePath: item.filePath,
          provider: input.provider,
          model: input.model,
          prompt: `[storyboard-grid task ${input.taskId} cell ${item.index + 1}] ${item.description}`.trim(),
          selected: false,
          status: "done",
        }).returning().get();
        // Only a newly finalized cell becomes active. Existing Grid rows are never
        // re-selected, preserving any manual take chosen after their completion.
        tx.update(assets).set({ selected: false }).where(and(eq(assets.projectId, input.projectId), eq(assets.shotId, item.shotId))).run();
        tx.update(assets).set({ selected: true }).where(eq(assets.id, row.id)).run();
        inserted += 1;
      }
      finalized.push({ shotId: item.shotId, filePath: item.filePath });
    }
    return { finalized, inserted };
  });
  return {
    gridPath: grid.publicPath,
    cells: committed.finalized,
    count: committed.finalized.length,
    finalizationState: committed.inserted === 0 ? "complete" as const
      : hadPartialProgress ? "resumed" as const : "finalized" as const,
  };
}
