import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { config } from './config.js';

// The static builds npm installed (the same ones the desktop app bundles), so
// the web version works on a machine with nothing but Node. Optional: a
// checkout without devDependencies simply falls through to the system.
const require = createRequire(import.meta.url);
const packaged = (name) => {
  try {
    return name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
  } catch {
    return null;
  }
};

const run = promisify(execFile);

// The chocolatey shims on this machine are blocked by Application Control, but
// the real binaries underneath run fine — so probe real paths before PATH. The
// unix prefixes matter for the same reason on macOS: a GUI-launched app gets no
// shell PATH, so a bare name resolves to nothing. Kept in step with the
// candidate list in src-tauri/src/media.rs.
const CANDIDATES = {
  ffmpeg: [
    config.ffmpeg,
    packaged('ffmpeg'),
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
    packaged('ffprobe'),
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
    if (/[\\/]/.test(cand) && !fs.existsSync(cand)) continue;
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
      ['-v', 'error', '-select_streams', 'v:0',
       '-show_entries', 'stream=width,height,duration,codec_name,r_frame_rate,avg_frame_rate,nb_frames',
       '-show_entries', 'format=duration',
       '-of', 'json', file],
      { timeout: 30_000, maxBuffer: 1 << 20, windowsHide: true }
    );
    const out = JSON.parse(stdout);
    const stream = out.streams?.[0];
    if (!stream) return null;
    return { ...stream, formatDuration: Number(out.format?.duration) || null };
  } catch {
    return null;
  }
}

/** "30000/1001" -> { num, den }. Anything unusable comes back as null. */
export function parseRate(text) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!num || !den) return null;
  return { num, den };
}

/**
 * What a frame-accurate timeline needs: an exact rational frame rate, a frame
 * count, and a duration.
 *
 * `avg_frame_rate` is preferred over `r_frame_rate` because r_frame_rate is the
 * smallest rate that can express every timestamp — on a file with one odd
 * timestamp it comes back as something like 1000/1, which would put a thousand
 * ticks a second on the ruler. nb_frames is missing from plenty of containers,
 * so the count falls back to duration x rate.
 */
export function videoInfo(stream) {
  if (!stream) return null;
  const rate = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
  const fps = rate ? rate.num / rate.den : 0;
  const duration = Number(stream.duration) || stream.formatDuration || 0;
  const counted = Number(stream.nb_frames);
  const frames = Number.isFinite(counted) && counted > 0 ? counted : Math.max(1, Math.round(duration * fps));
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    codec: stream.codec_name || '',
    fpsNum: rate?.num || 0,
    fpsDen: rate?.den || 0,
    fps,
    duration,
    frames,
  };
}

/** Runs ffmpeg, resolving with stderr so callers can log/report failures. */
export async function ffmpeg(args, { timeout = 30 * 60_000 } = {}) {
  const bin = await ffmpegPath();
  if (!bin) throw new Error('ffmpeg not found — set "ffmpeg" in config.json to its full path');
  return run(bin, args, { timeout, maxBuffer: 1 << 24, windowsHide: true });
}
