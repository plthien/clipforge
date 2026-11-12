// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import {
  listLocalMaterials,
  storeLocalMaterial,
  updateMaterialMetadata,
} from "@/lib/local-material-library";
import {
  materialMatchScore,
  materialTags,
  MATERIAL_MAX_BYTES,
} from "@/lib/material-library";
import { scanLocalMaterials } from "@/lib/providers/local-stock";
import { probeMedia } from "@/lib/media-probe";
vi.mock("@/lib/media-probe", () => ({ probeMedia: vi.fn() }));
let directory: string;
const stream = (text = "image content") =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-material-test-"));
  vi.mocked(probeMedia).mockResolvedValue({
    width: 320,
    height: 180,
    duration: 0,
    hasAudio: false,
    frameRate: 30,
    videoCodec: "png",
    formatName: "png_pipe",
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("local material lifecycle", () => {
  it("hashes concurrent imports once and keeps edited names/tags on re-upload", async () => {
    const results = await Promise.all([
      storeLocalMaterial(directory, "coffee.png", stream()),
      storeLocalMaterial(directory, "another.png", stream()),
    ]);
    expect(results[0].material.name).toBe(results[1].material.name);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    const name = results[0].material.name;
    await updateMaterialMetadata(directory, name, "厨房倒咖啡", [
      "coffee",
      "倒咖啡",
      "coffee",
    ]);
    const repeat = await storeLocalMaterial(directory, "renamed.png", stream());
    expect(repeat.duplicate).toBe(true);
    expect(repeat.material.originalName).toBe("厨房倒咖啡");
    expect(repeat.material.tags).toEqual(["coffee", "倒咖啡"]);
    expect(await listLocalMaterials(directory)).toHaveLength(1);
  });
  it("retains searchable names, real dimensions and edited tags in stock candidates", async () => {
    const unrelated = await storeLocalMaterial(
      directory,
      "zzz.png",
      stream("first"),
    );
    const coffee = await storeLocalMaterial(
      directory,
      "camera-1.png",
      stream("second"),
    );
    await updateMaterialMetadata(directory, coffee.material.name, "手冲咖啡", [
      "pour",
      "coffee",
    ]);
    const results = await scanLocalMaterials(directory, "pour coffee", {
      mediaType: "image",
    });
    expect(results[0]).toMatchObject({
      id: coffee.material.name,
      title: "手冲咖啡",
      tags: ["pour", "coffee"],
      width: 320,
      height: 180,
    });
    expect(results[1].id).toBe(unrelated.material.name);
  });
  it("ignores directories, symlinks, temporary files and extracted frame helpers", async () => {
    await writeFile(join(directory, "legacy.png"), "legacy");
    await writeFile(join(directory, "movie.mp4.last.jpg"), "frame");
    await writeFile(join(directory, ".upload.part"), "partial");
    await mkdir(join(directory, "folder.png"));
    try {
      await symlink(join(directory, "legacy.png"), join(directory, "linked.png"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
      // Windows without Developer Mode cannot create test symlinks. Keep all
      // regular file, directory, temp-file and extracted-frame assertions.
      console.warn("Windows symlink permission denied: link filtering not exercised");
    }
    const rows = await listLocalMaterials(directory);
    expect(rows.map((r) => r.name)).toEqual(["legacy.png"]);
    expect(rows[0]).toMatchObject({
      originalName: "legacy.png",
      tags: [],
      sizeBytes: 6,
    });
  });
  it("rejects size declarations, incomplete streams and invalid formats without residue", async () => {
    await expect(
      storeLocalMaterial(directory, "a.png", stream(), {
        expectedBytes: MATERIAL_MAX_BYTES + 1,
      }),
    ).rejects.toThrow("MATERIAL_SIZE");
    await expect(
      storeLocalMaterial(directory, "a.png", stream(), { expectedBytes: 900 }),
    ).rejects.toThrow("INCOMPLETE_MATERIAL");
    await expect(
      storeLocalMaterial(directory, "a.jpg", stream()),
    ).rejects.toThrow("INVALID_MATERIAL");
    vi.mocked(probeMedia).mockRejectedValueOnce(new Error("invalid bytes"));
    await expect(
      storeLocalMaterial(directory, "a.png", stream()),
    ).rejects.toThrow("INVALID_MATERIAL");
    expect(await readdir(directory)).toEqual([]);
  });
  it("enforces the size limit on actual streaming bytes when Content-Length is absent", async () => {
    async function* chunks() {
      for (let index = 0; index < 11; index++)
        yield Buffer.alloc(8 * 1024 * 1024);
    }
    await expect(
      storeLocalMaterial(
        directory,
        "big.png",
        Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>,
      ),
    ).rejects.toThrow("MATERIAL_SIZE");
    expect(await readdir(directory)).toEqual([]);
  });
  it("aborts blocked uploads and removes temporary files", async () => {
    const controller = new AbortController();
    const pending = storeLocalMaterial(
      directory,
      "a.png",
      new ReadableStream<Uint8Array>(),
      { signal: controller.signal },
    );
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    setTimeout(() => controller.abort(), 10);
    await cancelled;
    expect(await readdir(directory)).toEqual([]);
  });
  it("validates metadata and blocks traversal without changing existing files", async () => {
    const { material } = await storeLocalMaterial(directory, "a.png", stream());
    await expect(
      updateMaterialMetadata(directory, "../outside.png", "x", []),
    ).rejects.toThrow("MATERIAL_NOT_FOUND");
    await expect(
      updateMaterialMetadata(directory, material.name, "../rename", []),
    ).rejects.toThrow("INVALID_NAME");
    await expect(
      updateMaterialMetadata(directory, material.name, "valid", [
        "x".repeat(33),
      ]),
    ).rejects.toThrow("INVALID_TAGS");
    expect((await listLocalMaterials(directory))[0].originalName).toBe("a.png");
  });
});
describe("material queries", () => {
  it("matches whole English tokens and CJK phrases without loose substrings", () => {
    expect(
      materialMatchScore("kitchen_pour_over.mp4 coffee", "pour over coffee"),
    ).toBe(3);
    expect(materialMatchScore("厨房倒咖啡", "倒咖啡")).toBe(1);
    expect(materialMatchScore("scattered catalog", "cat")).toBe(0);
    expect(materialTags([" kitchen ", "kitchen", ""])).toEqual(["kitchen"]);
  });
});
