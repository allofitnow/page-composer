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
