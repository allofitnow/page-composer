import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { paragraphsToSlate } from './richtext.js';

const api = (p) => `${config.payload.url.replace(/\/$/, '')}/api${p}`;

/**
 * fetch with a deadline. `AbortSignal.timeout` leaves its timer pending, which
 * on Windows aborts the process if it exits while one is still live — so the
 * timer is cleared explicitly instead.
 */
async function fetchWithin(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Credentials entered through the sign-in modal, held for this process only.
 * They take precedence over config.json/env so signing in as someone else does
 * not require a restart, and signing out leaves nothing behind.
 */
const session = { email: null, password: null };

export const credentials = () => ({
  email: session.email || config.payload.email,
  password: session.password || config.payload.password,
});

export function setCredentials(email, password) {
  session.email = email || null;
  session.password = password || null;
}

export function clearCredentials() {
  session.email = null;
  session.password = null;
}

/** Exchanges a login for a JWT, or throws with Payload's own message. */
async function authenticate(email, password) {
  const res = await fetch(api('/users/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    // 401 is a wrong email/password; anything else is the server or the network.
    const why = res.status === 401 ? 'wrong email or password' : `${res.status} ${text}`;
    throw new Error(`Payload login failed: ${why}`);
  }
  const body = JSON.parse(text);
  return { token: body.token, user: body.user };
}

/**
 * Verifies a login without committing to it, so the modal can report a bad
 * password before anything is uploaded or remembered.
 */
export async function checkLogin(email, password) {
  if (!email || !password) throw new Error('email and password are both required');
  const { user } = await authenticate(email, password);
  return { email: user?.email || email, id: user?.id };
}

async function login() {
  const { email, password } = credentials();
  if (!email || !password) {
    throw new Error('not signed in to Payload — use SIGN IN, or set PAYLOAD_ADMIN_EMAIL and PAYLOAD_ADMIN_PASSWORD');
  }
  return (await authenticate(email, password)).token;
}

// The layouts the Projects collection accepts. Anything else is rejected by
// Payload's select validation, so the composer never invents one.
const LAYOUTS = new Set(['full', 'two-up', 'split-8-4', 'split-5-7', 'three-up']);

const MIME = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };

async function uploadMedia(jwt, file, alt) {
  const name = path.basename(file);
  const auth = { Authorization: `JWT ${jwt}` };

  const localSize = fs.statSync(file).size;

  // Payload keeps filenames unique, so a re-publish would pile up `-1` copies.
  //
  // But matching on the NAME alone was wrong, and quietly so. Output names are
  // positional — `..._gallery02.webp` is whatever sits second in the rail — so
  // re-composing a different image, or merely reordering the carousel, produces
  // the same filenames holding different pictures. Reusing on the name meant the
  // CMS kept serving the old file; reordering published the WRONG images under
  // the right names. Size is the discriminator: a re-encode of the same source
  // at the same settings is byte-identical, anything else differs.
  let existing = null;
  const found = await fetch(api(`/media?where[filename][equals]=${encodeURIComponent(name)}&limit=1`), { headers: auth });
  if (found.ok) {
    const j = await found.json();
    if (j.totalDocs > 0) {
      if (j.docs[0].filesize === localSize) return { id: j.docs[0].id, reused: true, filename: name };
      existing = j.docs[0].id;
    }
  }

  const fd = new FormData();
  fd.set('alt', alt || name);
  fd.set('file', new File([fs.readFileSync(file)], name, { type: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' }));

  // Replacing in place keeps the id, so every project already pointing at this
  // media doc picks the new file up too.
  const res = existing
    ? await fetch(api(`/media/${existing}`), { method: 'PATCH', headers: auth, body: fd })
    : await fetch(api('/media'), { method: 'POST', headers: auth, body: fd });
  if (!res.ok) throw new Error(`upload ${name} failed: ${res.status} ${await res.text()}`);
  if (existing) return { id: existing, reused: false, filename: name, replaced: true };
  return { id: (await res.json()).doc.id, reused: false, filename: name };
}

/**
 * Where a brand new project lands: the FRONT of the run.
 *
 * It used to be the back (highest order plus one), which was harmless while the
 * year sort came first and put new work near the top regardless. Now that
 * `order` decides the page outright, the back would bury every new project at
 * the bottom of the work grid.
 */
async function nextOrder(jwt) {
  const res = await fetch(api('/projects?limit=1&sort=order'), { headers: { Authorization: `JWT ${jwt}` } });
  if (!res.ok) return 1;
  const docs = (await res.json()).docs || [];
  // floor, so a fractional order left by a drag still yields a value below it
  return Math.floor(docs[0]?.order ?? 1) - 1;
}

/**
 * Uploads the composed assets and creates (or updates) the project.
 * Payload's afterChange hook fires the Astro rebuild on its own.
 */
export async function publish({ fields, manifestPath, onProgress = () => {} }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const outDir = manifest.outDir;
  const ok = manifest.items.filter((i) => i.status === 'done');
  if (!ok.length) throw new Error('nothing composed — run Compose first');

  onProgress({ stage: 'login', message: `authenticating with ${config.payload.url}` });
  const jwt = await login();
  const auth = { Authorization: `JWT ${jwt}`, 'Content-Type': 'application/json' };

  const media = {};
  // Gallery rows are rebuilt from the manifest: each composed tile carries the
  // row it belongs to and its slot within that row, so the arrangement made in
  // the rail survives the round trip into Payload's `{ layout, images }` shape.
  const rows = new Map();
  for (const item of ok) {
    const file = path.join(outDir, item.output);
    onProgress({ stage: 'media', message: `uploading ${item.output}` });
    const up = await uploadMedia(jwt, file, `${fields.title} — ${item.description}`);
    onProgress({ stage: 'media', message: `${up.reused ? 'reused' : 'uploaded'} ${up.filename}` });

    if (item.role === 'hero') {
      // The collection has ONE key image, used as both the work-grid thumbnail
      // and the project hero — there is no separate thumb field any more.
      media.image = up.id;
    } else if (item.role === 'thumb') {
      // Still written to disk (the crop is useful locally), but the CMS only
      // wants the one image, so it is not uploaded into a field.
    } else {
      const ri = item.row ?? rows.size;
      if (!rows.has(ri)) rows.set(ri, { layout: item.layout || 'full', slots: [] });
      rows.get(ri).slots.push({ slot: item.slot ?? rows.get(ri).slots.length, image: up.id });
    }
  }

  const gallery = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => ({
      layout: LAYOUTS.has(r.layout) ? r.layout : 'full',
      images: r.slots.sort((a, b) => a.slot - b.slot).map((s) => ({ image: s.image })),
    }));

  const { ids: serviceIds, unknown: unknownServices } = await resolveServices(fields.services);
  if (unknownServices.length) {
    onProgress({
      stage: 'project',
      message: `not in the CMS service list, skipped: ${unknownServices.join(', ')}`,
    });
  }

  // `writeup` is a Slate rich-text field. The paragraphs are held as Markdown,
  // which is how formatting survives from the doc through step 04 — see
  // server/richtext.js.
  const paragraphs = [fields.writeup?.lead, ...(fields.writeup?.body || [])]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const writeup = paragraphsToSlate(paragraphs);

  const doc = {
    title: fields.title,
    slug: fields.slug,
    code: 'TEMP', // the collection's beforeChange hook derives the real code
    status: 'published',
    year: String(fields.year),
    capabilities: fields.capabilities,
    tour: fields.tour || undefined,
    collaborator: fields.collaborator || undefined,
    summary: fields.summary || undefined,
    services: serviceIds.length ? serviceIds : undefined,
    stats: (fields.stats || []).filter((s) => s.label && s.value),
    credits: (fields.credits || []).filter((c) => c.entries?.length),
    writeup: writeup.length ? writeup : undefined,
    // Always sent, both ways, so unticking can un-feature on a re-publish.
    featured: fields.featured === true,
    featuredOrder: fields.featured === true && Number.isFinite(Number(fields.featuredOrder)) ? Number(fields.featuredOrder) : null,
    ...media,
    gallery,
  };
  if (!doc.image) throw new Error('no hero picked — the CMS requires one key image');

  const existing = await fetch(api(`/projects?where[slug][equals]=${encodeURIComponent(fields.slug)}&limit=1`), {
    headers: { Authorization: `JWT ${jwt}` },
  });
  const existingDocs = existing.ok ? (await existing.json()).docs || [] : [];

  let res;
  if (existingDocs.length) {
    onProgress({ stage: 'project', message: `updating existing project ${fields.slug}` });
    doc.order = existingDocs[0].order;
    res = await fetch(api(`/projects/${existingDocs[0].id}`), { method: 'PATCH', headers: auth, body: JSON.stringify(doc) });
  } else {
    doc.order = fields.order || (await nextOrder(jwt));
    onProgress({ stage: 'project', message: `creating project ${fields.slug} at order ${doc.order}` });
    res = await fetch(api('/projects'), { method: 'POST', headers: auth, body: JSON.stringify(doc) });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`project write failed: ${res.status} ${text}`);
  const saved = JSON.parse(text).doc;

  onProgress({ stage: 'rebuild', message: 'Payload afterChange hook fired — Astro rebuild queued' });
  return {
    unknownServices,
    id: saved.id,
    slug: saved.slug,
    code: saved.code,
    order: saved.order,
    url: `${config.payload.url.replace(/\/$/, '')}/work/${saved.slug}`,
    mediaCount: ok.length,
  };
}

/**
 * `services` is a relationship to the editable `service-categories` collection,
 * so the list has to come from the CMS rather than being hard-coded here — an
 * editor can add one at any time. Cached briefly so opening step 04 does not
 * re-fetch on every render.
 */
let serviceCache = { at: 0, list: [] };

export async function serviceCategories() {
  if (Date.now() - serviceCache.at < 5 * 60 * 1000 && serviceCache.list.length) return serviceCache.list;
  try {
    const res = await fetchWithin(api('/service-categories?limit=200&sort=label'), 4000);
    if (!res.ok) return serviceCache.list;
    const docs = (await res.json()).docs || [];
    serviceCache = { at: Date.now(), list: docs.map((d) => ({ id: d.id, label: d.label })).filter((d) => d.label) };
    return serviceCache.list;
  } catch {
    // Offline is not fatal — the picker just shows whatever was last seen.
    return serviceCache.list;
  }
}

/**
 * The composer stores services as labels: they survive a doc being re-parsed and
 * read properly in the UI. Payload wants relationship ids, so they are resolved
 * here, case-insensitively. Unknown names are reported rather than invented —
 * creating categories from a typo would quietly pollute a shared taxonomy.
 */
export async function resolveServices(names) {
  const wanted = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!wanted.length) return { ids: [], unknown: [] };
  const list = await serviceCategories();
  const byLabel = new Map(list.map((s) => [s.label.trim().toLowerCase(), s.id]));
  const ids = [];
  const unknown = [];
  for (const name of wanted) {
    const id = byLabel.get(name.toLowerCase());
    if (id) ids.push(id);
    else unknown.push(name);
  }
  return { ids, unknown };
}

// ---------------------------------------------------------------------------
// The WORK page's running order. Reading is unauthenticated -- the collection
// allows public reads -- so the screen opens before anyone signs in; writing
// needs the login.
// ---------------------------------------------------------------------------

/** Absolute url for a populated upload relation, '' when there is none. */
const imageUrl = (media) => {
  const url = media?.url;
  if (!url) return '';
  return url.startsWith('http') ? url : `${config.payload.url.replace(/\/$/, '')}${url}`;
};

/**
 * Published projects in the order the site builds them: the manual `order`
 * decides, lowest first, and the year only settles a tie between two projects
 * sharing a number. Mirrors `getProjects` in frontend/src/lib/payload.ts -- if
 * that comparator changes this has to follow, or the app would show an order
 * the site does not.
 */
export async function listWorkOrder() {
  const res = await fetch(api('/projects?limit=200&depth=1&sort=order&where[status][equals]=published'));
  if (!res.ok) throw new Error(`could not read the work page: ${res.status} ${await res.text()}`);
  const docs = (await res.json()).docs || [];
  return docs
    .map((d) => ({
      id: d.id,
      title: d.title || '',
      slug: d.slug || '',
      code: d.code || '',
      year: d.year || '',
      order: typeof d.order === 'number' ? d.order : null,
      featured: Boolean(d.featured),
      image: imageUrl(d.image),
    }))
    .sort((a, b) => {
      const oa = a.order ?? 0;
      const ob = b.order ?? 0;
      if (oa !== ob) return oa - ob;
      return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
    });
}

/**
 * Writes the planned `order` values one at a time.
 *
 * One at a time is not caution: Payload's afterChange hook runs the site build
 * SYNCHRONOUSLY, so two writes in flight would be two builds fighting over the
 * same checkout. Only `order` is sent -- a partial update leaves `data.title`
 * unset, so the collection's beforeChange hook returns early and the generated
 * project code is left alone.
 */
export async function saveWorkOrder(changes, onProgress = () => {}) {
  const jwt = await login();
  const titles = new Map((await listWorkOrder()).map((p) => [p.id, p.title]));
  const total = changes.length;
  for (let i = 0; i < total; i++) {
    const { id, order } = changes[i];
    const title = titles.get(id) || id;
    onProgress({ done: i, total, title });
    const res = await fetch(api(`/projects/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${jwt}` },
      body: JSON.stringify({ order }),
    });
    if (!res.ok) throw new Error(`${title}: ${res.status} ${await res.text()}`);
    onProgress({ done: i + 1, total, title });
  }
  // Re-read: the CMS is the thing being edited, so the screen should come back
  // showing what it actually says.
  return listWorkOrder();
}

// ---------------------------------------------------------------------------
// One published project's gallery, for rearranging in place. Nothing is
// uploaded -- every image is already in the CMS -- so a reflow is one document
// write rather than a re-compose.
// ---------------------------------------------------------------------------

/** The layouts the collection accepts; anything else is rejected by Payload. */
const GALLERY_LAYOUTS = ['full','full-16-9','full-2-1','full-3-1','full-19-5','full-27-4','two-up','split-8-4','split-5-7','three-up'];

const galleryImage = (media) => {
  // At depth 2 the relation is the media document. A project saved another way
  // can leave a bare id behind, and an entry that is only an id has no url to
  // show, so it is dropped rather than rendered as a hole.
  if (!media || typeof media !== 'object' || !media.id) return null;
  return {
    id: media.id,
    url: imageUrl(media),
    name: media.filename || '',
    video: String(media.mimeType || '').startsWith('video/'),
    width: media.width ?? null,
    height: media.height ?? null,
  };
};

/**
 * The shared half of an upload name.
 *
 * The composer writes `{base}_{role}{nn}.{ext}` -- `linkin-park-from-zero-tour`
 * plus `_gallery03.mp4` -- so everything before the first underscore groups a
 * project's files. It is not the slug: a slug is `kid-laroi` where the files
 * are `the-kid-laroi-a-perfect-world-tour`.
 */
const uploadBase = (filename) => {
  const at = String(filename || '').indexOf('_');
  return at > 0 ? String(filename).slice(0, at) : '';
};

/**
 * Everything in the CMS whose filename contains `query`. Nothing is uploaded
 * from here -- a file that is not in the CMS yet has to go through compose and
 * publish, which is a different job entirely.
 */
export async function cmsMedia(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const res = await fetch(api(`/media?limit=200&depth=0&sort=filename&where[filename][like]=${encodeURIComponent(q)}`));
  if (!res.ok) throw new Error(`could not read the media library: ${res.status}`);
  return ((await res.json()).docs || []).map(galleryImage).filter(Boolean);
}

export async function cmsProject(id) {
  const res = await fetch(api(`/projects/${encodeURIComponent(id)}?depth=2`));
  if (!res.ok) throw new Error(`could not read the project: ${res.status}`);
  const doc = await res.json();
  const gallery = (doc.gallery || [])
    .map((row) => ({
      layout: GALLERY_LAYOUTS.includes(row.layout) ? row.layout : 'full',
      images: (row.images || []).map((i) => galleryImage(i.image)).filter(Boolean),
    }))
    // A row whose images all failed to resolve would render as an empty band
    // nobody could drag out of.
    .filter((r) => r.images.length);
  // The key image first, because it is the one file a project is guaranteed to
  // have; a gallery entry is the fallback for anything odd.
  const base =
    [doc.image?.filename, ...(doc.gallery || []).flatMap((r) => (r.images || []).map((i) => i.image?.filename))]
      .map(uploadBase)
      .find(Boolean) || '';

  return {
    id: doc.id ?? id,
    title: doc.title || '',
    slug: doc.slug || '',
    year: doc.year || '',
    url: `${config.payload.url.replace(/\/$/, '')}/work/${doc.slug || ''}`,
    base,
    keyImage: doc.image?.id || '',
    gallery,
  };
}

/**
 * Writes a rearranged gallery back. Only `gallery` is sent -- a partial update
 * leaves `data.title` unset, so the collection's beforeChange hook returns early
 * and the project's generated code is left alone.
 */
export async function saveCmsGallery(id, rows) {
  const jwt = await login();
  const gallery = (rows || [])
    .filter((r) => (r.images || []).length)
    .map((r) => ({
      layout: GALLERY_LAYOUTS.includes(r.layout) ? r.layout : 'full',
      images: r.images.map((image) => ({ image })),
    }));
  const res = await fetch(api(`/projects/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${jwt}` },
    body: JSON.stringify({ gallery }),
  });
  if (!res.ok) throw new Error(`gallery write failed: ${res.status} ${await res.text()}`);
  // Read it back rather than trusting the request.
  return cmsProject(id);
}

export async function payloadStatus() {
  const { email, password } = credentials();
  const who = { url: config.payload.url, credentials: Boolean(email && password), email: email || '' };
  try {
    const res = await fetchWithin(api('/projects?limit=1'), 4000);
    return { reachable: res.ok, ...who };
  } catch {
    return { reachable: false, ...who };
  }
}
