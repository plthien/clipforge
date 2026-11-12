import { execFileSync } from "node:child_process";

/**
 * ffmpeg / ffprobe binary path resolution — allows commands to target the bundled binary,
 * supporting Electron packaging.
 *
 * Development: falls back to `ffmpeg` / `ffprobe` on the system PATH (same behaviour as before).
 * Electron package: the main process injects the absolute paths extracted from ffmpeg-static /
 * @ffprobe-installer into FFMPEG_PATH / FFPROBE_PATH, so users don't need to install ffmpeg themselves.
 *
 * Note: return values are interpolated into shell command strings; paths may contain spaces —
 * callers must wrap them in double quotes.
 */

/** Path to the ffmpeg executable (callers must quote it if it contains spaces) */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Path to the ffprobe executable (callers must quote it if it contains spaces) */
export function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

/**
 * Use the actual runtime binary, not the build host's FFmpeg version.
 * ffmpeg-static@5.3.0 bundles FFmpeg 6.1.1 (legacy -filter_complex_script),
 * while FFmpeg 7+ supports file-based -/filter_complex and FFmpeg 8 removes the old flag.
 * Cache by executable path; never interpolate the path into a shell command.
 */
const complexFilterFileFlags = new Map<string, "-/filter_complex" | "-filter_complex_script">();

export function ffmpegComplexFilterFileFlag(): "-/filter_complex" | "-filter_complex_script" {
  const executable = ffmpegBin();
  const cached = complexFilterFileFlags.get(executable);
  if (cached) return cached;
  let flag: "-/filter_complex" | "-filter_complex_script" = "-/filter_complex";
  try {
    const version = execFileSync(executable, ["-version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const major = /^ffmpeg version\s+(?:n)?(\d+)(?:\.|\b)/im.exec(version);
    if (major && Number(major[1]) < 7) flag = "-filter_complex_script";
  } catch {
    // Preserve the modern default if the installed version cannot be determined.
    // The actual renderer still reports a native FFmpeg failure rather than masking it.
  }
  complexFilterFileFlags.set(executable, flag);
  return flag;
}
