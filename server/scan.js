import fs from 'node:fs';
import path from 'node:path';
import { roots } from './config.js';
import { kindOf, parseFolderName, SKIP_DIRS, safeJoin } from './util.js';

// The separator is a NUL byte, built explicitly below: no filename can contain
// one, so folder names with spaces ("26024_STURDY_The Kid Laroi") round-trip.
const SEP = String.fromCharCode(0);
// A page can be built from more than one project folder — a tour whose stills
// are on the NAS and whose renders are on G:, say. The id carries the whole
// list rather than the caller passing one around, so every existing call site
// keeps working unchanged and a single-folder id is byte-for-byte what it
// always was. Primary source first: it decides the output folder and the name.
const REC = String.fromCharCode(1);

export const encodeId = (rootLabel, folder) => Buffer.from(rootLabel + SEP + folder).toString('base64url');

const raw = (id) => Buffer.from(id, 'base64url').toString('utf8');

/** Several project ids as one. Order matters; the first is the primary. */
export const mergeIds = (ids) => Buffer.from(ids.map(raw).join(REC)).toString('base64url');

const decodeOne = (part) => {
  const at = part.indexOf(SEP);
  const root = roots.find((r) => r.label === part.slice(0, at));
  const folder = part.slice(at + 1);
  if (at < 0 || !root || !folder) throw new Error('unknown project id');
  return { root, folder, dir: path.join(root.path, folder) };
};

export const decodeId = (id) => {
  const sources = raw(id).split(REC).map(decodeOne);
  // `root`/`folder`/`dir` stay the primary's, so callers that only know about
  // single-folder projects behave exactly as before.
  return { ...sources[0], sources };
};

/**
 * Assets from a secondary folder carry an `@N/` prefix naming their source, so
 * one flat `rel` stays unambiguous across folders that may hold identically
 * named files. Source 0 is never prefixed — that is what keeps saved
 * selections from before this existed still valid.
 */
export function resolveRel(decoded, rel) {
  const m = /^@(\d+)\//.exec(rel);
  const src = decoded.sources[m ? Number(m[1]) : 0];
  if (!src) throw new Error(`no such source in this project: ${rel}`);
  return safeJoin(src.dir, m ? rel.slice(m[0].length) : rel);
}

export const prefixFor = (i) => (i === 0 ? '' : `@${i}/`);

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
  const decoded = decodeId(id);
  const { root, folder, dir, sources } = decoded;
  const { jobCode, slug, title } = parseFolderName(folder);

  // Every source folder contributes; only the primary names the page.
  const assets = [];
  const docs = [];
  sources.forEach((src, i) => {
    const scanned = scanProject(src.dir);
    const at = prefixFor(i);
    for (const a of scanned.assets) assets.push({ ...a, rel: at + a.rel, dir: at + a.dir, source: i });
    for (const d of scanned.docs) docs.push({ ...d, rel: at + d.rel, source: i });
  });

  // Folder tree with counts, for the source rail.
  const byDir = new Map();
  for (const a of assets) {
    const cur = byDir.get(a.dir) || { dir: a.dir, images: 0, videos: 0, source: a.source };
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
    // What each `@N/` prefix means, so the UI can name a folder rather than
    // showing the reader a bare index.
    sources: sources.map((sc, i) => ({ index: i, root: sc.root.label, folder: sc.folder, dir: sc.dir })),
    tree: [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir)),
    assets: assets.sort((a, b) => a.rel.localeCompare(b.rel)),
    docs,
  };
}
