import fs from 'node:fs';
import path from 'node:path';
import { roots } from './config.js';
import { kindOf, parseFolderName, SKIP_DIRS } from './util.js';

// The separator is a NUL byte, built explicitly below: no filename can contain
// one, so folder names with spaces ("26024_STURDY_The Kid Laroi") round-trip.
const SEP = String.fromCharCode(0);
export const encodeId = (rootLabel, folder) => Buffer.from(rootLabel + SEP + folder).toString('base64url');
export const decodeId = (id) => {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  const at = decoded.indexOf(SEP);
  const root = roots.find((r) => r.label === decoded.slice(0, at));
  const folder = decoded.slice(at + 1);
  if (at < 0 || !root || !folder) throw new Error('unknown project id');
  return { root, folder, dir: path.join(root.path, folder) };
};

/** Depth-limited walk that skips scratch/RAW folders and our own output. */
function walk(dir, base = '', depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), rel, depth + 1, out);
    } else if (e.isFile()) {
      const kind = kindOf(e.name);
      if (!kind) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, e.name));
      } catch {
        continue;
      }
      out.push({
        rel,
        name: e.name,
        dir: base || '/',
        kind,
        size: st.size,
        mtime: st.mtimeMs,
        ext: path.extname(e.name).toLowerCase(),
      });
    }
  }
  return out;
}

const cache = new Map();
// Some folders hold thousands of stills; re-walking every one on each picker
// load is the slow path. Compose invalidates its own project on write.
const TTL = 5 * 60_000;

export function scanProject(dir) {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const files = walk(dir);
  const value = {
    assets: files.filter((f) => f.kind !== 'doc'),
    docs: files.filter((f) => f.kind === 'doc'),
  };
  cache.set(dir, { at: Date.now(), value });
  return value;
}

export const invalidate = (dir) => cache.delete(dir);
export const invalidateAll = () => cache.clear();

export function listProjects() {
  const out = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root.path, e.name);
      const { jobCode, slug, title } = parseFolderName(e.name);
      const { assets, docs } = scanProject(dir);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {}
      out.push({
        id: encodeId(root.label, e.name),
        root: root.label,
        folder: e.name,
        jobCode,
        slug,
        title: title.toUpperCase(),
        stills: assets.filter((a) => a.kind === 'image').length,
        videos: assets.filter((a) => a.kind === 'video').length,
        copyDoc: docs[0]?.rel || null,
        mtime,
      });
    }
  }
  return out.sort((a, b) => (a.jobCode === b.jobCode ? a.folder.localeCompare(b.folder) : b.jobCode.localeCompare(a.jobCode)));
}

export function getProject(id) {
  const { root, folder, dir } = decodeId(id);
  const { assets, docs } = scanProject(dir);
  const { jobCode, slug, title } = parseFolderName(folder);

  // Folder tree with counts, for the source rail.
  const byDir = new Map();
  for (const a of assets) {
    const cur = byDir.get(a.dir) || { dir: a.dir, images: 0, videos: 0 };
    cur[a.kind === 'image' ? 'images' : 'videos']++;
    byDir.set(a.dir, cur);
  }

  return {
    id,
    root: root.label,
    folder,
    dir,
    jobCode,
    slug,
    title: title.toUpperCase(),
    tree: [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
    assets: assets.sort((a, b) => a.rel.localeCompare(b.rel)),
    docs,
  };
}
