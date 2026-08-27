import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Env wins over config.json so credentials never have to live on disk.
export const config = {
  ...raw,
  port: Number(process.env.PORT || raw.port || 4545),
  payload: {
    url: process.env.PAYLOAD_URL || raw.payload.url,
    email: process.env.PAYLOAD_ADMIN_EMAIL || raw.payload.email,
    password: process.env.PAYLOAD_ADMIN_PASSWORD || raw.payload.password,
  },
};

/**
 * Asset roots — local drives, mapped drives, or UNC shares on the project NAS
 * (`\\\\nas\\projects\\...`). Other modules hold a reference to THIS array, so
 * it is always mutated in place rather than reassigned.
 */
export const roots = [];

export const reachable = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Only roots that resolve right now — a NAS being offline must not be fatal.
 *
 *  Entries SHARING A LABEL are alternates of one logical root, not separate roots:
 *  the same share addressed as a Windows UNC path and as a macOS /Volumes mount.
 *  The first alternate that resolves on THIS machine wins, so one config.json can
 *  be carried between the two boxes unedited. That matters because a label is part
 *  of every project id — renaming a duplicate to make it unique (the old behaviour)
 *  would have silently changed every id the moment the file was opened on a Mac. */
export function applyRoots(list) {
  const normalised = list
    .map((r, i) => {
      const p = String(r.path || '').trim().replace(/[\\/]+$/, '');
      const label = String(r.label || '').trim() || path.basename(p) || `ROOT ${i + 1}`;
      return { label, path: p };
    })
    .filter((r) => r.path);

  // Every entry is kept in `config.roots` — including the ones that do not resolve
  // here — so saving the config from either machine preserves the other's paths.
  config.roots = normalised;

  roots.length = 0;
  const resolved = new Set();
  for (const r of normalised) {
    if (resolved.has(r.label)) continue; // an alternate of a root already resolved
    if (!reachable(r.path)) continue;
    resolved.add(r.label);
    roots.push(r);
  }
  return normalised;
}

export function saveConfig() {
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  onDisk.roots = config.roots;
  // Credentials are never written as a side effect of saving roots — only
  // saveCredentials() below can do that, and only when explicitly asked.
  onDisk.payload = { ...onDisk.payload, url: config.payload.url };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2) + '\n');
}

/**
 * Writes the CMS login to config.json so it survives a restart. This is opt-in
 * per sign-in ("remember me on this device") because the password is stored in
 * PLAIN TEXT — config.json is local-only and never committed, but it is not a
 * keychain, and the UI says so where you tick the box.
 *
 * Passing null for the password remembers only the address, which is the
 * default: it saves retyping without leaving a secret on disk.
 */
export function saveCredentials(email, password) {
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  onDisk.payload = {
    ...onDisk.payload,
    email: email || '',
    password: password || '',
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2) + '\n');
}

applyRoots(raw.roots || []);

export const CACHE_DIR = path.join(ROOT_DIR, '.cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
