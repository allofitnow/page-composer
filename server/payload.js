import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { paragraphsToSlate, slateToParagraphs } from './richtext.js';

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
 * Puts freshly composed files into the CMS and hands back what a gallery row
 * needs to show them.
 *
 * `publish` does this too, but as one leg of a much bigger job: it rebuilds the
 * whole project document from the manifest — hero, write-up, services, the
 * entire gallery — which is exactly what must not happen here. The page is
 * already up and only wants two more pictures on the end, so this uploads and
 * stops; the rows are arranged on screen and written by `saveCmsGallery`, which
 * touches the gallery field alone.
 *
 * Nothing is overwritten: `plan` numbered these past the end of what is already
 * published, so every filename is new to the collection.
 */
export async function uploadComposed({ manifestPath, alt, onProgress = () => {} }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ok = (manifest.items || []).filter((i) => i.status === 'done');
  if (!ok.length) throw new Error('nothing composed — every file failed to convert');

  onProgress({ stage: 'login', message: `authenticating with ${config.payload.url}` });
  const jwt = await login();

  const out = [];
  for (const item of ok) {
    const file = path.join(manifest.outDir, item.output);
    onProgress({ stage: 'upload', message: `uploading ${item.output}` });
    const up = await uploadMedia(jwt, file, `${alt} — ${item.description || 'asset'}`);
    onProgress({ stage: 'upload', message: `${up.reused ? 'reused' : up.replaced ? 'replaced' : 'uploaded'} ${up.filename}` });

    // uploadMedia hands back an id, not the document, and a row needs the url
    // and the mime type to draw itself — so the doc is read back. It also
    // confirms the file really landed, which a returned id alone does not.
    const res = await fetch(api(`/media/${encodeURIComponent(up.id)}?depth=0`), {
      headers: { Authorization: `JWT ${jwt}` },
    });
    if (!res.ok) throw new Error(`uploaded ${up.filename} but could not read it back: ${res.status}`);
    const row = galleryImage(await res.json());
    if (!row) throw new Error(`uploaded ${up.filename} but the CMS did not return it`);
    out.push(row);
  }
  onProgress({ stage: 'done', message: `${out.length} uploaded` });
  return out;
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
 *
 * This does NOT rebuild the site. Since 2026-09-07 the projects collection
 * has no afterChange hook (Payload drafts are on, and a per-document save is
 * treated as work in progress); the only thing that rebuilds Astro is the
 * site-wide publish -- `deploy/publish.sh` on .245, or the MCP `publish` tool.
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
    // An explicit pick on step 04 wins; blank means "as stored", which for a new
    // project is published and for an existing one is whatever the update branch
    // below puts back -- so re-publishing never silently re-lists an unlisted page.
    visibility: fields.visibility || 'published',
    // The collection has Payload drafts enabled, and its `_status` defaults to
    // 'draft' on create. A composer publish is a finished page, so say so --
    // otherwise a new project lands in the admin as an unpublished draft.
    _status: 'published',
    year: String(fields.year),
    capabilities: fields.capabilities,
    tour: fields.tour || undefined,
    collaborator: fields.collaborator || undefined,
    summary: fields.summary || undefined,
    services: serviceIds.length ? serviceIds : undefined,
    stats: (fields.stats || []).filter((s) => s.label && s.value),
    credits: (fields.credits || []).filter((c) => c.entries?.length),
    writeup: writeup.length ? writeup : undefined,
    // Only meaningful on a create -- the update branch below puts the stored
    // values back, because this form has no idea what they are.
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
    // Same reasoning as `order`: the form cannot know the document's visibility,
    // and `unlisted` is a deliberate editorial choice (the page builds, but nothing
    // on the site links to it). Forcing 'published' here would quietly undo that
    // every time the project was re-published. Archive is carried over for the
    // same reason.
    doc.visibility = fields.visibility || existingDocs[0].visibility || 'published';
    // The publish form is built from the asset folder and the copy doc, never
    // from the document, so the Featured box reads unticked whatever the CMS
    // holds. Sending that back would drop the project off the home marquee as
    // a side effect of re-publishing it -- so an unticked box carries the
    // stored values over instead, the same as `order` directly above. Ticking
    // still features, because that one the operator actually meant. Removing a
    // project from the marquee is a CMS-side edit now.
    if (fields.featured !== true) {
      doc.featured = Boolean(existingDocs[0].featured);
      doc.featuredOrder =
        typeof existingDocs[0].featuredOrder === 'number' ? existingDocs[0].featuredOrder : null;
    }
    res = await fetch(api(`/projects/${existingDocs[0].id}`), { method: 'PATCH', headers: auth, body: JSON.stringify(doc) });
  } else {
    doc.order = fields.order || (await nextOrder(jwt));
    onProgress({ stage: 'project', message: `creating project ${fields.slug} at order ${doc.order}` });
    res = await fetch(api('/projects'), { method: 'POST', headers: auth, body: JSON.stringify(doc) });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`project write failed: ${res.status} ${text}`);
  const saved = JSON.parse(text).doc;

  onProgress({ stage: 'rebuild', message: 'project saved — the site shows it after the next site-wide publish' });
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
  const res = await fetch(api('/projects?limit=200&depth=1&sort=order&where[visibility][equals]=published'));
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
      // Needed to diff: without it the screen cannot tell an already-correct
      // marquee position from one that has never been written.
      featuredOrder: typeof d.featuredOrder === 'number' ? d.featuredOrder : null,
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
 * One at a time so the progress report is per document. (Until 2026-09-07 it
 * was also the only safe way: every write ran a full site build, and two in
 * flight fought over one checkout. Writes are quick now -- nothing rebuilds
 * until the site-wide publish.) Only `order` is sent -- a partial update leaves `data.title`
 * unset, so the collection's beforeChange hook returns early and the generated
 * project code is left alone.
 */
export async function saveWorkOrder(changes, onProgress = () => {}) {
  const jwt = await login();
  const titles = new Map((await listWorkOrder()).map((p) => [p.id, p.title]));
  const total = changes.length;
  for (let i = 0; i < total; i++) {
    const { id, order, featured, featuredOrder } = changes[i];
    const title = titles.get(id) || id;
    onProgress({ done: i, total, title });
    // `order` and the marquee fields ride in ONE patch per document, never two.
    // One write per decision keeps the version history readable (every PATCH is
    // a version now that drafts are on). Only the keys actually present are sent, which keeps this a
    // partial update: `data.title` stays unset, so the collection's beforeChange
    // hook returns early and the generated code is left alone.
    const body = {};
    if (order !== undefined) body.order = order;
    if (featured !== undefined) body.featured = featured;
    if (featuredOrder !== undefined) body.featuredOrder = featuredOrder;
    if (!Object.keys(body).length) {
      onProgress({ done: i + 1, total, title });
      continue;
    }
    const res = await fetch(api(`/projects/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${jwt}` },
      body: JSON.stringify(body),
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

/** A focal-point percentage as the CMS stores it; anything unset is the centre. */
const focusPct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50);

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
      images: (row.images || [])
        .map((i) => {
          const im = galleryImage(i?.image);
          // The focal point lives on the gallery entry, not the media doc:
          // the same file can sit in two slots and be cropped differently.
          return im ? { ...im, focusX: focusPct(i?.focusX), focusY: focusPct(i?.focusY) } : null;
        })
        .filter(Boolean),
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
      images: r.images.map((im) => {
        const it = im && typeof im === 'object' ? im : { id: im };
        return { image: it.id, focusX: focusPct(it.focusX), focusY: focusPct(it.focusY) };
      }),
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
  const who = { url: config.payload.url, credentials: Boolean(email && password), email: email || '', publishToken: Boolean(config.payload.publishToken) };
  try {
    const res = await fetchWithin(api('/projects?limit=1'), 4000);
    return { reachable: res.ok, ...who };
  } catch {
    return { reachable: false, ...who };
  }
}

// ---------------------------------------------------------------------------
// Editing a project that is ALREADY in the CMS.
//
// The rest of this module builds a project up from an asset folder and a copy
// doc. These three go the other way: list what the CMS holds, read one back into
// the shape step 04 edits, and write just the fields that changed. That is what
// lets the composer edit a live page without an asset folder in the picture.
// ---------------------------------------------------------------------------

/** Every project in the CMS, newest running order first, for the step 01 list. */
export async function cmsProjects() {
  const res = await fetch(api('/projects?limit=200&depth=1&sort=order'));
  if (!res.ok) throw new Error(`could not read the CMS: ${res.status} ${await res.text()}`);
  return ((await res.json()).docs || [])
    .map((d) => ({
      id: d.id,
      title: d.title || '',
      slug: d.slug || '',
      code: d.code || '',
      year: d.year || '',
      visibility: d.visibility || 'published',
      order: typeof d.order === 'number' ? d.order : null,
      featured: Boolean(d.featured),
      image: imageUrl(d.image),
      // Shown in the list so it is obvious which pages carry a write-up. The
      // node COUNT is not the test: an empty rich-text field is stored as one
      // blank paragraph, not as an empty array, and 18 of the live projects are
      // in exactly that state -- they would every one have advertised a write-up
      // that is not there.
      hasWriteup: slateToParagraphs(d.writeup).paragraphs.length > 0,
    }))
    .sort((a, b) => {
      const oa = a.order ?? 0;
      const ob = b.order ?? 0;
      if (oa !== ob) return oa - ob;
      return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
    });
}

/**
 * One CMS project read back into the `fields` shape step 04 edits.
 *
 * `services` come back as LABELS, not ids, because that is what the form holds
 * and what resolveServices() expects on the way in. `writeup` is converted to
 * the plain paragraph list -- and the original Slate is returned alongside it as
 * `writeupOriginal`, because the conversion cannot represent an `upload` node
 * (an image or clip dropped into the prose from the Payload admin). When the
 * operator has not touched the write-up, publish sends the original back
 * verbatim rather than the converted text, so those blocks survive. See
 * `writeupDropped` for how many would otherwise be lost.
 */
export async function cmsProjectFields(id) {
  const res = await fetch(api(`/projects/${encodeURIComponent(id)}?depth=2`));
  if (!res.ok) throw new Error(`could not read the project: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  const { paragraphs, dropped } = slateToParagraphs(doc.writeup);

  return {
    id: doc.id ?? id,
    fields: {
      title: doc.title || '',
      slug: doc.slug || '',
      year: doc.year || '',
      tour: doc.tour || '',
      collaborator: doc.collaborator || '',
      summary: doc.summary || '',
      capabilities: Array.isArray(doc.capabilities) ? doc.capabilities : [],
      // At depth 2 a service is the populated category document.
      services: (doc.services || [])
        .map((v) => (v && typeof v === 'object' ? v.label : v))
        .filter((v) => typeof v === 'string' && v),
      stats: (doc.stats || []).map((s) => ({ label: s?.label || '', value: s?.value || '' })),
      credits: (doc.credits || []).map((g) => ({
        title: g?.title || '',
        entries: (g?.entries || []).map((e) => ({ title: e?.title || '', name: e?.name || '', url: e?.url || '' })),
      })),
      writeup: { lead: '', body: paragraphs },
      writeupColumns: doc.writeupColumns === '2' ? '2' : '1',
      visibility: doc.visibility || 'published',
      featured: Boolean(doc.featured),
      featuredOrder: typeof doc.featuredOrder === 'number' ? doc.featuredOrder : null,
    },
    writeupOriginal: Array.isArray(doc.writeup) ? doc.writeup : [],
    writeupDropped: dropped,
    order: typeof doc.order === 'number' ? doc.order : null,
    code: doc.code || '',
    keyImage: doc.image?.id || '',
    keyImageUrl: imageUrl(doc.image),
    url: `${config.payload.url.replace(/\/$/, '')}/work/${doc.slug || ''}`,
  };
}

/** Fields this function is willing to write. Anything else is ignored rather
 *  than passed through, so a stray key in the form state cannot reach the CMS. */
const EDITABLE = new Set([
  'title', 'slug', 'year', 'tour', 'collaborator', 'summary',
  'capabilities', 'services', 'stats', 'credits',
  'writeup', 'writeupColumns', 'visibility', 'featured', 'featuredOrder',
]);

/**
 * Writes back ONLY the keys named in `changed` -- a partial update, the same
 * shape saveCmsGallery uses and for the same reason: leaving `data.title` unset
 * makes the collection's beforeChange hook return early, so the generated code
 * is left alone. Sending the whole document would also mean sending fields this
 * form never loaded, which is how re-publishing used to wipe things.
 *
 * `writeupSlate`, when given, is sent verbatim instead of converting the
 * paragraph list -- that is the untouched-write-up path that preserves inline
 * media (see cmsProjectFields).
 */
export async function saveCmsFields(id, fields, changed, writeupSlate) {
  // A blank visibility means "keep what is stored": the CMS only takes one of
  // its three values, and would refuse the empty string.
  const keys = (changed || []).filter((k) => EDITABLE.has(k) && !(k === 'visibility' && !fields?.visibility));
  if (!keys.length) return { id, written: [] };

  const jwt = await login();
  const doc = {};
  for (const k of keys) {
    if (k === 'writeup') {
      if (Array.isArray(writeupSlate)) {
        doc.writeup = writeupSlate;
      } else {
        const paragraphs = [fields.writeup?.lead, ...(fields.writeup?.body || [])]
          .map((t) => String(t || '').trim())
          .filter(Boolean);
        doc.writeup = paragraphsToSlate(paragraphs);
      }
      continue;
    }
    if (k === 'services') {
      const { ids } = await resolveServices(fields.services);
      doc.services = ids;
      continue;
    }
    if (k === 'stats') {
      doc.stats = (fields.stats || []).filter((s) => s.label && s.value);
      continue;
    }
    if (k === 'credits') {
      doc.credits = (fields.credits || []).filter((c) => c.entries?.length);
      continue;
    }
    if (k === 'featuredOrder') {
      doc.featuredOrder = Number.isFinite(Number(fields.featuredOrder)) ? Number(fields.featuredOrder) : null;
      continue;
    }
    doc[k] = fields[k];
  }

  const res = await fetch(api(`/projects/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${jwt}` },
    body: JSON.stringify(doc),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`field write failed: ${res.status} ${text}`);
  return { id, written: keys, doc: JSON.parse(text).doc };
}
