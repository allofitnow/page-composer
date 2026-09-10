#!/usr/bin/env node
// Puts ffmpeg and ffprobe where the Tauri bundler expects sidecars, so the
// installer carries them and a fresh machine needs nothing else. The binaries
// come from the ffmpeg-static and ffprobe-static packages, which fetch the
// build for the machine they are installed on — so on a CI matrix each runner
// provisions its own platform.
//
//   node scripts/fetch-ffmpeg.mjs [--target <rust-triple>]
//
// Tauri wants `src-tauri/binaries/<name>-<triple>[.exe]` and installs them as
// plain `ffmpeg` / `ffprobe` next to the app's own executable, which is where
// src-tauri/src/media.rs looks first.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const explicit = args[args.indexOf('--target') + 1];
const triple =
  (args.includes('--target') && explicit) ||
  execSync('rustc -vV', { encoding: 'utf8' }).match(/host:\s*(\S+)/)?.[1];
if (!triple) throw new Error('could not work out the target triple — pass --target');

const exe = triple.includes('windows') ? '.exe' : '';
const out = path.join(ROOT, 'src-tauri', 'binaries');
fs.mkdirSync(out, { recursive: true });

const sources = {
  ffmpeg: require('ffmpeg-static'),
  ffprobe: require('ffprobe-static').path,
};
for (const [name, from] of Object.entries(sources)) {
  if (!from || !fs.existsSync(from)) throw new Error(`${name}: no binary at ${from} — run npm install`);
  const to = path.join(out, `${name}-${triple}${exe}`);
  fs.copyFileSync(from, to);
  if (!exe) fs.chmodSync(to, 0o755);
  console.log(`${name}: ${(fs.statSync(to).size / 1e6).toFixed(1)} MB → ${path.relative(ROOT, to)}`);
}
