import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

// The chocolatey shims on this machine are blocked by Application Control, but
// the real binaries underneath run fine — so probe real paths before PATH. The
// unix prefixes matter for the same reason on macOS: a GUI-launched app gets no
// shell PATH, so a bare name resolves to nothing. Kept in step with the
// candidate list in src-tauri/src/media.rs.
const CANDIDATES = {
  ffmpeg: [
    config.ffmpeg,
    'C:/ProgramData/chocolatey/lib/ffmpeg-full/tools/ffmpeg/bin/ffmpeg.exe',
    'C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/opt/local/bin/ffmpeg',
    'ffmpeg',
  ],
  ffprobe: [
    config.ffprobe,
    'C:/ProgramData/chocolatey/lib/ffmpeg-full/tools/ffmpeg/bin/ffprobe.exe',
    'C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe',
    'C:/ffmpeg/bin/ffprobe.exe',
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
    '/opt/local/bin/ffprobe',
    'ffprobe',
  ],
};

const resolved = {};

async function resolve(which) {
  if (resolved[which] !== undefined) return resolved[which];
  for (const cand of CANDIDATES[which]) {
    if (!cand) continue;
    if (cand.includes('/') && !fs.existsSync(cand)) continue;
    try {
      await run(cand, ['-version'], { timeout: 10_000, windowsHide: true });
      resolved[which] = cand;
      return cand;
    } catch {
      /* blocked or missing — try the next candidate */
    }
  }
  resolved[which] = null;
  return null;
}

export const ffmpegPath = () => resolve('ffmpeg');
export const ffprobePath = () => resolve('ffprobe');

export async function ffmpegStatus() {
  const [ffmpeg, ffprobe] = await Promise.all([ffmpegPath(), ffprobePath()]);
  return { ffmpeg, ffprobe, ok: Boolean(ffmpeg) };
}

export async function probe(file) {
  const bin = await ffprobePath();
  if (!bin) return null;
  try {
    const { stdout } = await run(
      bin,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,codec_name', '-of', 'json', file],
      { timeout: 30_000, maxBuffer: 1 << 20, windowsHide: true }
    );
    return JSON.parse(stdout).streams?.[0] || null;
  } catch {
    return null;
  }
}

/** Runs ffmpeg, resolving with stderr so callers can log/report failures. */
export async function ffmpeg(args, { timeout = 30 * 60_000 } = {}) {
  const bin = await ffmpegPath();
  if (!bin) throw new Error('ffmpeg not found — set "ffmpeg" in config.json to its full path');
  return run(bin, args, { timeout, maxBuffer: 1 << 24, windowsHide: true });
}
