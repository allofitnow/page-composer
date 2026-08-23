import path from 'node:path';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.bmp']);
export const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.webm']);
// Copy docs only — `.txt` is deliberately excluded, because After Effects
// litters project folders with `NotchLC-log.txt` and auto-save logs that would
// otherwise register as the project's write-up.
export const DOC_EXT = new Set(['.docx', '.md', '.markdown']);

// Machine droppings, never assets. RAW/master folders are NOT skipped — the
// composer transcodes anyway, and silently hiding a source is worse than a long
// list you can filter in the UI.
export const SKIP_DIRS = new Set(['.cache', 'node_modules', '_web', '.git', 'Adobe After Effects Auto-Save', 'Logs']);

export const kindOf = (file) => {
  const e = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (DOC_EXT.has(e)) return 'doc';
  return null;
};

export function slugify(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // MorganWallen -> Morgan-Wallen
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * `26013_peso-dinastia` -> { jobCode: '26013', slug: 'peso-dinastia' }
 * `26002_MG26_Martin Garrix` -> { jobCode: '26002', slug: 'martin-garrix' }
 * The result is only a DEFAULT — the UI lets you edit the name base before
 * anything is written.
 */
export function parseFolderName(folder) {
  const m = folder.match(/^(\d{4,6})[_\-\s]+(.*)$/);
  const jobCode = m ? m[1] : '';
  const rest = m ? m[2] : folder;
  const segs = rest.split('_').map((s) => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1] || rest;
  const chosen = segs.length > 1 && last.replace(/[^A-Za-z0-9]/g, '').length >= 4 ? last : segs.join('-');
  const slug = slugify(chosen);
  // Title comes off the slug so `MorganWallen` reads as "MORGAN WALLEN".
  return { jobCode, slug, title: slug.replace(/-/g, ' ') };
}

export const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/**
 * The AOIN asset convention: project-name-tour_description##
 * The index is only appended when a description is shared by more than one
 * asset, so a lone hero stays `..._hero.webp`.
 */
export function buildName(base, description, index, groupSize, ext) {
  const desc = slugify(description) || 'asset';
  const suffix = groupSize > 1 ? pad2(index + 1) : '';
  return `${slugify(base)}_${desc}${suffix}.${ext}`;
}

/** Guard against `..` escaping the project folder. */
export function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (full !== normRoot && !full.startsWith(normRoot + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return full;
}

export const bytes = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
};
