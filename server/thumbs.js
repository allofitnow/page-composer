import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { CACHE_DIR } from './config.js';
import { ffmpeg } from './ffmpeg.js';

const inflight = new Map();

// Opening a project fires one request per asset — and a video poster means
// decoding a frame out of a file that can be tens of gigabytes. Without a gate
// they all start at once and the whole sheet stalls; three at a time keeps the
// grid filling in steadily.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

const keyFor = (file, mtime, w) => crypto.createHash('sha1').update(`${file}|${mtime}|${w}`).digest('hex') + '.jpg';

async function build(file, kind, width, out) {
  if (kind === 'video') {
    // `-ss` BEFORE `-i` is an input seek, so this stays cheap on huge masters.
    const seek = ['-y', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out];
    const first = ['-y', '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out];
    await ffmpeg(seek, { timeout: 180_000 }).catch(() =>
      // Clips shorter than the seek point: fall back to the first frame.
      ffmpeg(first, { timeout: 180_000 })
    );
  } else {
    await sharp(file, { failOn: 'none' })
      .rotate()
      .resize(width, null, { withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(out);
  }
  return out;
}

const previewKey = (file, mtime) =>
  crypto.createHash('sha1').update(`${file}|${mtime}|preview`).digest('hex') + '.mp4';

/**
 * A web-playable proxy of a source video, cached like a thumbnail.
 *
 * Quick Look tries the original first, because a lot of what comes off the NAS
 * is already h.264 mp4 and plays instantly. This is the fallback for what a
 * webview cannot decode at all — ProRes, most .mov, HEVC — which is most of
 * what a camera actually writes. 1280 wide at CRF 28 is a preview, not a
 * deliverable; the real encode still happens in compose.
 */
export async function preview(file) {
  const st = fs.statSync(file);
  const out = path.join(CACHE_DIR, previewKey(file, st.mtimeMs));
  if (fs.existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);

  const job = (async () => {
    await acquire();
    try {
      // Written aside and renamed: a half-encoded file at the real path would
      // be served on the next request and cached as if it were complete.
      // `-f mp4` is not optional — ffmpeg picks the container from the output
      // extension, and this one ends in `.part`.
      const part = out + '.part';
      try {
        await ffmpeg(
          ['-y', '-i', file,
           '-vf', "scale='min(1280,iw)':-2",
           '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast',
           '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
           '-c:a', 'aac', '-b:a', '128k',
           '-f', 'mp4', part],
          { timeout: 900_000 }
        );
      } catch (e) {
        fs.rmSync(part, { force: true });
        throw e;
      }
      fs.renameSync(part, out);
      return out;
    } finally {
      release();
      inflight.delete(out);
    }
  })();
  inflight.set(out, job);
  return job;
}

/**
 * Cached JPEG thumbnail for a still or a video (poster frame at ~1s).
 * Concurrent requests for the same key share one render.
 */
export async function thumbnail(file, kind, width = 420) {
  const st = fs.statSync(file);
  const out = path.join(CACHE_DIR, keyFor(file, st.mtimeMs, width));
  if (fs.existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);

  const job = (async () => {
    await acquire();
    try {
      return await build(file, kind, width, out);
    } finally {
      release();
    }
  })().finally(() => inflight.delete(out));

  inflight.set(out, job);
  return job;
}
