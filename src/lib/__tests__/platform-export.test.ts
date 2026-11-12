// @vitest-environment node
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { DEFAULT_VIDEO_FRAMING, parseVideoFraming } from "@/lib/video-framing";
import { buildPlatformExportArgs, previewPlatformExport, renderPlatformExport } from "@/lib/platform-export";

const run = promisify(execFile);
const target = { name: "Test", w: 180, h: 320, ratio: "9:16", maxVideoKbps: 5000, maxFps: 30 };

describe("构图参数契约", () => {
  it("兼容旧调用，拒绝非数值和滤镜注入", () => {
    expect(parseVideoFraming(undefined)).toEqual(DEFAULT_VIDEO_FRAMING);
    for (const value of [null, [], "crop", { mode: "crop;movie=/tmp/x" }, { mode: "crop", positionX: -1 }, { positionY: Infinity }, { positionX: "0.5" }, { positionY: null }]) {
      expect(() => parseVideoFraming(value)).toThrow("INVALID_VIDEO_FRAMING");
    }
    expect(parseVideoFraming({ mode: "fit", positionX: 1 })).toEqual({ mode: "fit", positionX: 0.5, positionY: 0.5 });
  });

  it("路径是独立参数，显式映射可选音轨并保留标识元数据", () => {
    const sourcePath = '/tmp/a " quote $(touch nope).mp4';
    const args = buildPlatformExportArgs({ sourcePath, outputPath: "/tmp/output.mp4", target, framing: DEFAULT_VIDEO_FRAMING, sourceFps: 60 });
    expect(args[args.indexOf("-i") + 1]).toBe(sourcePath);
    expect(args).toContain("0:a:0?");
    expect(args).toContain("-map_metadata");
    expect(args[args.indexOf("-r") + 1]).toBe("30");
  });
});

describe("真实 FFmpeg 构图与导出", () => {
  let directory: string;
  let source: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "clipforge-framing-"));
    source = join(directory, "source with spaces.mp4");
    await run(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x180:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-vf", "drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata", "comment=clipforge-test-marker", "-shortest", source]);
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  const centerPixel = async (file: string) => {
    const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", file, "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
    return [...stdout.subarray(0, 3)];
  };

  it("左右裁切保留指定主体，音轨、时长和原文件完整，预览匹配导出", async () => {
    const original = await readFile(source);
    for (const [positionX, color] of [[0, 0], [1, 2]] as const) {
      const framing = { mode: "crop" as const, positionX, positionY: 0.5 };
      const outputPath = join(directory, `crop-${positionX}.mp4`);
      await renderPlatformExport({ sourcePath: source, outputPath, target, framing });
      const probe = await probeMedia(outputPath);
      expect(probe).toMatchObject({ width: 180, height: 320, hasAudio: true });
      expect(probe.duration).toBeCloseTo(2, 1);
      const pixel = await centerPixel(outputPath);
      expect(pixel[color]).toBeGreaterThan(220);
      expect(pixel[color === 0 ? 2 : 0]).toBeLessThan(20);
      const preview = await previewPlatformExport({ sourcePath: source, target, framing, time: 0.5 });
      const image = join(directory, `preview-${positionX}.jpg`);
      await writeFile(image, Buffer.from(preview.split(",")[1], "base64"));
      expect((await centerPixel(image))[color]).toBeGreaterThan(220);
      const compared = await run(ffmpegBin(), ["-v", "info", "-i", outputPath, "-i", image,
        "-filter_complex", "[1:v]scale=180:320,format=yuv420p[p];[0:v][p]ssim", "-frames:v", "1", "-f", "null", "-"]);
      expect(Number(/All:([\d.]+)/.exec(compared.stderr)?.[1])).toBeGreaterThan(0.97);
    }
    expect(await readFile(source)).toEqual(original);
    expect((await readdir(directory)).some((name) => name.includes("partial"))).toBe(false);
  }, 30_000);

  it("模糊与留白模式不丢画面，无音轨和非方形像素也可导出", async () => {
    for (const mode of ["blur", "fit"] as const) {
      const outputPath = join(directory, `${mode}.mp4`);
      await renderPlatformExport({ sourcePath: source, outputPath, target, framing: { ...DEFAULT_VIDEO_FRAMING, mode } });
      for (const [x, color] of [[20, 0], [150, 2]] as const) {
        const { stdout } = await run(ffmpegBin(), ["-v", "error", "-i", outputPath, "-vf", `crop=2:2:${x}:160,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
        expect(stdout[color]).toBeGreaterThan(220);
        expect(stdout[color === 0 ? 2 : 0]).toBeLessThan(20);
      }
    }
    const silent = join(directory, "anamorphic.mp4");
    await run(ffmpegBin(), ["-v", "error", "-y", "-i", source, "-an", "-vf", "setsar=2", "-c:v", "libx264", silent]);
    const outputPath = join(directory, "silent.mp4");
    await renderPlatformExport({ sourcePath: silent, outputPath, target, framing: DEFAULT_VIDEO_FRAMING });
    expect(await probeMedia(outputPath)).toMatchObject({ width: 180, height: 320, hasAudio: false });
  }, 30_000);

  it("失败和取消不会留下可下载的半成品", async () => {
    const outputPath = join(directory, "failed.mp4");
    await expect(renderPlatformExport({ sourcePath: join(directory, "missing.mp4"), outputPath, target, framing: DEFAULT_VIDEO_FRAMING })).rejects.toThrow();
    const active = new AbortController();
    const pending = renderPlatformExport({ sourcePath: source, outputPath, target: { ...target, w: 1080, h: 1920 }, framing: DEFAULT_VIDEO_FRAMING, signal: active.signal });
    const timer = setTimeout(() => active.abort(new Error("cancel-test")), 120);
    // 取消可能发生在探测或编码阶段；Node 子进程探测使用标准 AbortError。
    try { await expect(pending).rejects.toThrow(/cancel-test|The operation was aborted/); } finally { clearTimeout(timer); }
    expect(active.signal.aborted).toBe(true);
    expect((await readdir(directory)).filter((name) => name.startsWith("failed.mp4"))).toEqual([]);
  }, 30_000);
});
