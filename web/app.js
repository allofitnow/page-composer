// AOIN page composer — front end.
// One state object, one render pass per change. Text inputs commit on `change`
// (blur/enter) rather than `input`, so re-rendering never eats a keystroke.

import { rpc, thumbImg, cmsThumbImg, mediaSrc, previewSrc, probeMedia, onComposeProgress, onPublishProgress, onReorderProgress, notify, pickFolder, openExternal, isTauri } from '/transport.js';
import { createTimeline, spanSeconds, frameOf, timecode } from '/timeline.js';

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    // `draggable`, `contenteditable`, `spellcheck` and every `aria-*` are
    // *enumerated* attributes, not boolean ones: the empty string is an invalid
    // value and falls back to the default, so `draggable: true` silently became
    // `draggable=""` — i.e. not draggable at all. They need the literal "true".
    // A <textarea> has no `value` attribute — its content is a child text node,
    // so setAttribute silently does nothing and the box renders empty on every
    // re-render, losing what was typed from view while state kept it.
    else if (k === 'value' && t === 'textarea') el.textContent = String(v);
    else if (v === true && /^(draggable|contenteditable|spellcheck|aria-)/.test(k)) el.setAttribute(k, 'true');
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}


// ------------------------------------------------------------------ naming
const slugify = (s) =>
  String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const bytes = (n) =>
  n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(1) + ' KB' : n < 1024 ** 3 ? (n / 1024 ** 2).toFixed(1) + ' MB' : (n / 1024 ** 3).toFixed(2) + ' GB';

// The gallery is a list of ROWS, and each row picks one of ten layouts. This
// mirrors the Payload `gallery` field exactly (`{ layout, images: [...] }`), so
// what the rail shows is what the CMS stores — no translation at publish time.
//
// The layouts are the site's, not ours: the geometry below is lifted from
// frontend/src/components/project/ProjectPage.astro on `integration`. A layout
// carries BOTH the widths (spans) and the heights (aspects), which is why
// changing a row's height means moving it to a different layout — there is no
// free-form height the CMS could store.
const COLS = 12;
const LAYOUTS = {
  // Four full-width heights. The aspects here must match ProjectPage.astro's
  // CSS exactly or previz lies about what will publish — `full` used to be
  // `null` here while the site cropped it to 16/7, which is precisely the trap.
  'full-16-9': { slots: 1, spans: [12], aspects: ['16 / 9'], label: 'FULL 16:9' },
  'full-2-1': { slots: 1, spans: [12], aspects: ['2 / 1'], label: 'FULL 2:1' },
  full: { slots: 1, spans: [12], aspects: ['16 / 7'], label: 'FULL 16:7' },
  'full-3-1': { slots: 1, spans: [12], aspects: ['3 / 1'], label: 'FULL 3:1' },
  'full-19-5': { slots: 1, spans: [12], aspects: ['19 / 5'], label: 'FULL 3.8:1' },
  'full-27-4': { slots: 1, spans: [12], aspects: ['27 / 4'], label: 'FULL 27:4' },
  'two-up': { slots: 2, spans: [6, 6], aspects: ['4 / 3', '4 / 3'], label: 'TWO-UP' },
  'split-8-4': { slots: 2, spans: [8, 4], aspects: ['16 / 9', '1 / 1'], alignEnd: [false, true], label: 'SPLIT 8·4' },
  'split-5-7': { slots: 2, spans: [5, 7], aspects: ['4 / 3', '16 / 9'], alignEnd: [false, true], label: 'SPLIT 5·7' },
  'three-up': { slots: 3, spans: [4, 4, 4], aspects: ['4 / 3', '4 / 3', '4 / 3'], label: 'THREE-UP' },
};
const DEFAULT_LAYOUT = 'full';

// Dragging the seam changes the ratio, but it can only land on a layout the CMS
// actually has. Ordered by the width of the left slot (5 → 6 → 8), so dragging
// right widens the left image exactly as a free-form seam would.
const SEAM_ORDER = ['split-5-7', 'two-up', 'split-8-4'];

// Which layout to grow into when a row gains an image.
const GROW = { full: 'two-up', 'full-16-9': 'two-up', 'full-2-1': 'two-up', 'full-3-1': 'two-up', 'full-19-5': 'two-up', 'full-27-4': 'two-up', 'two-up': 'three-up', 'split-8-4': 'three-up', 'split-5-7': 'three-up' };
// ...and shrink into when it loses one.
const SHRINK = { 'three-up': 'two-up', 'two-up': 'full', 'split-8-4': 'full', 'split-5-7': 'full' };

const layoutOf = (row) => (row && LAYOUTS[row.layout] ? row.layout : DEFAULT_LAYOUT);
const slotsFor = (layout) => LAYOUTS[layout]?.slots || 1;
const spansFor = (layout) => LAYOUTS[layout]?.spans || [12];
const aspectFor = (layout, slot) => LAYOUTS[layout]?.aspects?.[slot] ?? null;
const alignEndFor = (layout, slot) => Boolean(LAYOUTS[layout]?.alignEnd?.[slot]);
const layoutLabel = (layout) => LAYOUTS[layout]?.label || String(layout).toUpperCase();
/** Just the ratio: 'FULL 16:9' → '16:9'. */
const heightLabel = (layout) => layoutLabel(layout).replace(/^FULL /, '');

// ---- heights ------------------------------------------------------------
// Full width is the only family the CMS gives more than one height, so it is
// the only place a height CONTROL can go. Ordered tallest first, which is what
// makes dragging the row's bottom edge downward make the row taller.
const HEIGHT_ORDER = ['full-16-9', 'full-2-1', 'full', 'full-3-1', 'full-19-5', 'full-27-4'];

// The rail is a miniature of the page, so a row's height has to come off the
// same numbers the site uses: a slot is (span/12) of the width, and its height
// is that divided by its aspect. RAIL_W is a stand-in page width, picked so
// `full` (16/7) lands on the 62px the rail has always been — every other layout
// is then honestly proportional to it, and a 27:4 row really does read as a
// band rather than as another 62px block.
const RAIL_W = 142;
// Under this a row stops being something you can grab, so it is floored and the
// slots are scaled to match. Only 27:4 hits it (21px raw).
const MIN_STRIP = 24;

const ratioOf = (aspect) => {
  const [w, h] = String(aspect || '1 / 1').split('/').map(Number);
  return h > 0 ? w / h : 1;
};
/** A slot's height in rail pixels, before the row-level floor. */
const slotHeightRaw = (layout, slot) =>
  ((RAIL_W * (spansFor(layout)[slot] || COLS)) / COLS) / ratioOf(aspectFor(layout, slot));
/** The row's height: the tallest slot, floored. */
const stripHeight = (layout) =>
  Math.max(MIN_STRIP, Math.round(Math.max(...spansFor(layout).map((_, s) => slotHeightRaw(layout, s)))));

// The heights the drag can land on, in the same order as HEIGHT_ORDER.
const HEIGHT_STEPS = HEIGHT_ORDER.map(stripHeight);
/** Which legal height is nearest a dragged pixel height. */
const nearestHeightIndex = (px) =>
  HEIGHT_STEPS.reduce((best, h, i) => (Math.abs(h - px) < Math.abs(HEIGHT_STEPS[best] - px) ? i : best), 0);

/**
 * Rows are the source of truth, but selections saved before layouts existed are
 * a flat list of tiles carrying a `span`. Fold those into rows by packing to 12
 * and snapping each row to the layout with the same slot count, so nobody's
 * saved carousel is lost.
 */
const SPAN_SNAP = { '8,4': 'split-8-4', '5,7': 'split-5-7', '6,6': 'two-up', '4,4,4': 'three-up', 12: 'full' };

function normaliseGallery(gallery) {
  if (!Array.isArray(gallery)) return [];
  // Already rows.
  if (gallery.length && gallery[0] && Array.isArray(gallery[0].items)) {
    return gallery
      .map((r) => ({ layout: layoutOf(r), items: r.items.filter(Boolean).slice(0, slotsFor(layoutOf(r))) }))
      .filter((r) => r.items.length);
  }
  // Legacy flat tiles: pack by span, then snap.
  const rows = [];
  let row = [];
  let spans = [];
  let width = 0;
  for (const it of gallery) {
    const span = Number.isFinite(it?.span) && it.span > 0 ? Math.min(COLS, it.span) : 12;
    if ((width + span > COLS && row.length) || row.length >= 3) {
      rows.push({ row, spans });
      row = [];
      spans = [];
      width = 0;
    }
    row.push({ rel: it.rel, description: it.description || 'gallery' });
    spans.push(span);
    width += span;
  }
  if (row.length) rows.push({ row, spans });
  return rows.map(({ row: items, spans: sp }) => ({
    layout: SPAN_SNAP[sp.join(',')] || (items.length === 3 ? 'three-up' : items.length === 2 ? 'two-up' : 'full'),
    items,
  }));
}

/** Every tile in reading order, with the row and slot it belongs to. */
/**
 * A carousel tile's identity. A clip can be in the carousel more than once,
 * each time as its own CUT with its own trim; the file path alone stops being
 * enough then. The first placement keeps the bare path as its key so nothing
 * already saved changes meaning; extra cuts get `path#cN`. Trims are keyed on
 * this, never on the path.
 */
const keyOf = (it) => (it.cut ? `${it.rel}#${it.cut}` : it.rel);
const cutOf = (key) => (key.includes('#') ? key.slice(key.indexOf('#') + 1) : '');
const relOfKey = (key) => (key.includes('#') ? key.slice(0, key.indexOf('#')) : key);

/** How a cut reads in the UI: '' for the first placement, 'CUT 2' for the next. */
function cutLabel(rel, key) {
  if (!cutOf(key)) return '';
  const cuts = flatTiles(state.gallery).filter((t) => t.rel === rel).map(keyOf);
  const i = cuts.indexOf(key);
  return i >= 0 ? `CUT ${i + 1}` : 'CUT';
}

function flatTiles(rows) {
  const out = [];
  rows.forEach((r, ri) => r.items.forEach((it, si) => out.push({ ...it, row: ri, slot: si, layout: layoutOf(r) })));
  return out;
}

const galleryCount = (rows) => rows.reduce((n, r) => n + r.items.length, 0);

/** Mirrors server/util.js buildName — the UI must predict the real filename. */
function outName(base, description, index, groupSize, ext) {
  const desc = slugify(description) || 'asset';
  return `${slugify(base)}_${desc}${groupSize > 1 ? pad2(index + 1) : ''}.${ext}`;
}

function plannedNames(state) {
  const items = selectedItems(state);
  const groups = new Map();
  for (const it of items) groups.set(it.description, (groups.get(it.description) || 0) + 1);
  const seen = new Map();
  return items.map((it) => {
    const i = seen.get(it.description) || 0;
    seen.set(it.description, i + 1);
    const asset = state.project.assets.find((a) => a.rel === it.rel);
    const ext = asset?.kind === 'video' ? 'mp4' : 'webp';
    return { ...it, asset, output: outName(state.base, it.description, i, groups.get(it.description), ext) };
  });
}

/**
 * hero, then thumb, then the carousel in order.
 *
 * The thumb is ALWAYS the hero — you pick one image and get two outputs from it:
 * the full-width hero and a 1200x800 cover crop for the work grid. There is no
 * separate thumb to choose.
 */
function selectedItems(state) {
  const out = [];
  if (state.hero) {
    out.push({ rel: state.hero, role: 'hero', description: 'hero' });
    out.push({ rel: state.hero, role: 'thumb', description: 'thumb' });
  }
  // Carries the row's layout and the slot within it, so compose can record the
  // arrangement in the manifest and publish can rebuild the Payload rows.
  flatTiles(state.gallery).forEach((t) =>
    out.push({
      rel: t.rel,
      role: 'gallery',
      description: t.description || 'gallery',
      layout: t.layout,
      row: t.row,
      slot: t.slot,
      // Stills ignore it, but sending a trim for one would put a seek in front
      // of an image conversion and read as a bug in the manifest.
      trim: kindOf(t.rel) === 'video' ? state.trims[keyOf(t)] : undefined,
    })
  );
  return out;
}

// ------------------------------------------------------------------- state
const state = {
  screen: 'pick',
  status: null,
  projects: [],
  rootFilter: null,
  search: '',
  selectedProjectId: null,
  // Ordered, because the first folder picked is the primary: it names the page
  // and receives the composed output. Shift/ctrl-click builds it up.
  pickedIds: [],
  project: null,
  kindFilter: 'all',
  dirFilter: null,
  mode: 'gallery',
  hero: null,
  view: 'grid',
  collapsed: new Set(),
  gallery: [],
  // In/out points per asset, keyed by rel rather than by row and slot, so a
  // trim survives the tile being moved, split, pulled out and put back.
  trims: {},
  base: '',
  baseTouched: false,
  outDir: '',
  copy: null,
  fields: null,
  validation: null,
  job: null,
  jobSteps: [],
  jobLog: [],
  manifestPath: null,
  publishing: false,
  publishResult: null,
  toast: null,
  drag: null,
  settingsOpen: false,
  // ---- Editing a page that is already in the CMS ----
  //
  // The composer's original job is 0 -> publish: an asset folder and a copy doc
  // become a new page. This is the other errand -- open a page the CMS already
  // holds and change it. `cmsMode` is which list step 01 is showing; `cmsDoc` is
  // the opened document, and its presence is what tells the rest of the app it
  // is editing rather than composing (there is no asset folder, no manifest, and
  // steps 02/03 do not apply).
  cmsMode: false,
  cmsProjects: null,
  cmsLoading: false,
  cmsDoc: null, // { id, baseline, writeupOriginal, writeupDropped, code, url, keyImageUrl }
  // The WORK page's running order, loaded from the CMS on demand rather than at
  // boot: it is a separate errand from composing a page and costs a request.
  workOrderOpen: false,
  workOrder: null, // { items, ids, saving, touched } while the reorder screen is up
  // One published project's gallery, opened by clicking it in the run. Kept
  // beside the running order rather than replacing it, so going back does not
  // lose an arrangement that has not been saved yet.
  cmsGalleryFor: null,
  cmsGallery: null, // { project, rows, was, saving }
  site: null, // { phase: 'running' | 'live' | 'failed', since, seconds, log, error, at }
  serviceFilter: '',
  login: null, // { email, password, remember, busy, error } while the sign-in modal is open
  loading: null, // { label, detail, since } while a slow backend call is in flight
  settings: null,
  browse: null,
  browseFor: null,
};

const storeKey = (id) => `aoin-composer:${id}`;
function persist() {
  if (!state.project) return;
  localStorage.setItem(
    storeKey(state.project.id),
    JSON.stringify({
      hero: state.hero,
      gallery: state.gallery,
      trims: state.trims,
      base: state.baseTouched ? state.base : '',
      outDir: state.outDir,
      fields: state.fields,
    })
  );
}
function restore(id) {
  try {
    return JSON.parse(localStorage.getItem(storeKey(id)) || 'null');
  } catch {
    return null;
  }
}

let toastTimer;
function toast(message, kind = 'ok') {
  state.toast = { message, kind };
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, kind === 'error' ? 7000 : 3200);
}

const set = (patch) => {
  Object.assign(state, patch);
  persist();
  render();
};

// ------------------------------------------------------------------- icons
const svg = (d, w = 12, sw = 1.6) =>
  h('span', {
    style: { display: 'flex', flex: '0 0 auto' },
    html: `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`,
  });
const IC = {
  folder: () => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 13),
  check: () => svg('<path d="M4 12.5l5 5L20 6.5"/>', 12, 2.4),
  img: () => svg('<rect x="3" y="4" width="18" height="16"/><path d="M3 16l5-5 4 4 3-3 6 6"/>'),
  vid: () => svg('<rect x="3" y="5" width="13" height="14"/><path d="M16 10l5-3v10l-5-3z"/>'),
  doc: () => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  grip: () => svg('<path d="M4 8h16M4 16h16"/>', 11, 2),
  x: () => svg('<path d="M6 6l12 12M18 6L6 18"/>', 11, 2),
  search: () => svg('<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>', 14, 1.8),
  gear: () => svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"/>', 14),
  server: () => svg('<rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/><path d="M7 7.5h.01M7 16.5h.01"/>', 13),
  user: () => svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>', 13),
  up: () => svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 12, 2),
  chev: () => svg('<path d="M9 6l6 6-6 6"/>', 10, 2.2),
  chevD: () => svg('<path d="M6 9l6 6 6-6"/>', 10, 2.2),
  grid: () => svg('<rect x="3" y="4" width="7" height="7"/><rect x="14" y="4" width="7" height="7"/><rect x="3" y="15" width="7" height="5"/><rect x="14" y="15" width="7" height="5"/>', 13),
};

/**
 * An <img> for an asset. The mtime rides along so a re-exported asset busts the
 * cache (and so a stale cached response for an old URL can never stick). On the
 * Tauri build the file is generated on demand and the src fills in after.
 */
const thumb = (rel, w = 420, attrs = {}, key = rel) => {
  const mt = state.project.assets.find((a) => a.rel === rel)?.mtime || 0;
  // A trimmed clip's poster is its IN point: the tile then shows the frame
  // the encode will start on, which is the only proof a trim took that does
  // not mean opening the clip again.
  const at = state.trims[key]?.in;
  return thumbImg(state.project.id, rel, w, { ...attrs, 'data-mtime': Math.round(mt), 'data-at': at > 0 ? at.toFixed(3) : undefined });
};

/**
 * 'IN → OUT · kept' for a trim, or '' when the whole clip goes out. Takes the
 * trim itself rather than looking one up, because an export row carries its
 * own — the very object the plan sent, or the desktop backend's echo of it,
 * which knows seconds (`start`) but not frames.
 */
function trimText(t) {
  if (!t) return '';
  const start = Number(t.in ?? t.start ?? 0);
  const end = t.out == null ? null : Number(t.out);
  const kept = end == null ? 'TO THE END' : `${(end - start).toFixed(2)}S`;
  if (t.inFrame === undefined || !t.fps) return `${start.toFixed(2)}S → ${end == null ? 'END' : `${end.toFixed(2)}S`} · ${kept}`;
  return `${timecode(t.inFrame, t.fps)} → ${timecode(t.outFrame, t.fps)} · ${kept}`;
}

// ------------------------------------------------------------------ chrome
const STEPS = [
  ['pick', '01', 'PICK'],
  ['compose', '02', 'COMPOSE'],
  ['previz', '03', 'PREVIZ'],
  ['copy', '04', 'COPY'],
  ['export', '05', 'EXPORT'],
];

function topBar() {
  // Writing the running order cannot be abandoned halfway: the PATCHes are
  // already in flight and each one holds the CMS through a whole site build, so
  // leaving would only lose sight of them. The bar holds until it is finished.
  const held = Boolean(state.workOrder?.saving || state.cmsGallery?.saving);
  return h(
    'div.bar',
    {},
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
      h('span.bar__mark', {}, 'AOIN'),
      h('span.bar__sep'),
      h('span.ov', {}, 'Page Composer')
    ),
    state.project
      ? h(
          'div.bar__proj',
          {},
          IC.folder(),
          h('span', {}, state.project.folder.toUpperCase()),
          h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, state.project.root)
        )
      : h('span'),
    h(
      'div.steps',
      {},
      (() => {
        const p = state.status?.payload;
        const signedIn = Boolean(p?.credentials);
        return h(
          'button.step',
          {
            title: signedIn
              ? `Signed in to ${p.url} as ${p.email} — click to sign out`
              : `Not signed in to ${p?.url || 'the CMS'} — publishing needs a login`,
            'aria-current': String(signedIn),
            onClick: () => (signedIn ? signOut() : openLogin()),
            style: { marginRight: '10px' },
          },
          IC.user ? IC.user() : IC.gear(),
          h('span', {}, signedIn ? 'SIGNED IN' : 'SIGN IN')
        );
      })(),
      h(
        'button.step',
        { title: 'Asset roots and CMS target', 'aria-current': String(state.settingsOpen), disabled: held, onClick: openSettings },
        IC.gear(),
        h('span', {}, 'ROOTS')
      ),
      // Two things live in this bar and they are not the same kind of thing.
      // Left of the rule: signing in and where the assets are. Right of it: the
      // 01-05 run that builds ONE page, and then — behind a rule of its own,
      // because it is a different job on a different subject — the work page
      // itself, which is about every project at once.
      h('span.bar__sep', { style: { margin: '0 12px' } }),
      STEPS.map(([id, n, label]) =>
        h(
          'button.step',
          {
            'aria-current': String(state.screen === id),
            // A CMS page counts as open, but only for the steps that apply to it:
            // 02/03 act on an asset folder and its composed output, neither of
            // which exists when the document came from the CMS.
            disabled:
              held ||
              (id !== 'pick' && !state.project && !state.cmsDoc) ||
              (state.cmsDoc && (id === 'compose' || id === 'previz')),
            // Picking a step also leaves the roots panel: it sits over the whole
            // screen, so without this the click looked like it did nothing and
            // the panel had to be closed by hand first.
            onClick: () => {
              workThumbs.clear();
              set({ screen: id, settingsOpen: false, workOrderOpen: false, workOrder: null, cmsGallery: null, cmsGalleryFor: null });
            },
          },
          h('span', {}, n),
          h('span', {}, label)
        )
      ),
      h('span.bar__sep', { style: { margin: '0 12px' } }),
      h(
        'button.step.step--mode',
        {
          title: held ? 'Writing the running order — this finishes first' : 'Arrange the work page and the galleries on it',
          'aria-current': String(state.workOrderOpen),
          disabled: held,
          onClick: () => (state.workOrderOpen ? closeWorkOrder() : openWorkOrder()),
        },
        IC.grid(),
        h('span', {}, 'WORK PAGE')
      )
    )
  );
}

// ------------------------------------------------------------------ loading
/**
 * Scanning a project NAS is slow — tens of seconds for a big share, and longer
 * when it is cold. Without a sign of life an empty table reads as "broken", so
 * anything that reaches across the network says what it is doing and how long
 * it has been at it. The elapsed count is the point: an indeterminate bar alone
 * cannot distinguish "working" from "hung".
 */
let loadingTimer = null;

function startLoading(label, detail, inline) {
  // Where it shows is stated, not inferred: the project scan sits inside the
  // empty table, everything else takes an overlay. Guessing from the current
  // screen meant "open project" showed nothing at all, because that runs while
  // step 01 is still up and its table is not empty.
  state.loading = { label, detail: detail || '', since: Date.now(), inline: Boolean(inline) };
  clearInterval(loadingTimer);
  // Re-render once a second purely to move the elapsed counter on.
  loadingTimer = setInterval(() => state.loading && touchLoader(), 1000);
  render();
}

function stopLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
  state.loading = null;
}

/**
 * The loader changes once a second, and again on every progress event — but a
 * full render() rebuilds the entire screen behind the overlay, and on the
 * desktop build every rebuilt tile issues a fresh thumbnail request. A publish
 * that reports thirty steps was firing thirty full rebuilds of a screen nobody
 * can see behind the modal. Only two bits of text ever change, so patch those
 * and leave the rest of the document alone; fall back to a real render when the
 * shape has to change (the clock appearing for the first time, say).
 */
function touchLoader() {
  const l = state.loading;
  const box = document.querySelector('.loader');
  if (!l || !box) return render();
  const detail = box.querySelector('.loader__detail');
  if (detail) detail.textContent = l.detail || '';
  else if (l.detail) return render();
  const secs = Math.floor((Date.now() - l.since) / 1000);
  const clock = box.querySelector('.loader__secs');
  if (!clock) return secs >= 2 ? render() : undefined;
  clock.textContent = `${secs}S`;
}

/** Runs an async call with the loader up, and takes it down whatever happens. */
async function withLoading(label, detail, fn, opts = {}) {
  startLoading(label, detail, opts.inline);
  try {
    return await fn();
  } finally {
    stopLoading();
    render();
  }
}

function loader(label, detail, since) {
  const secs = since ? Math.floor((Date.now() - since) / 1000) : 0;
  return h(
    'div.loader',
    {},
    h('div.loader__bar', {}, h('span')),
    h(
      'div.loader__text',
      {},
      h('span.loader__label.m', {}, label),
      // Only start showing the clock once it is slow enough to worry about.
      secs >= 2 ? h('span.loader__secs.m', {}, `${secs}S`) : null
    ),
    detail ? h('span.loader__detail.m.dimmer', {}, detail) : null
  );
}

/** The whole-screen version, for a step change that has to finish first. */
function loadingOverlay() {
  const l = state.loading;
  return h('div.modal.modal--quiet', {}, h('div.modal__box', {}, loader(l.label, l.detail, l.since)));
}

// ------------------------------------------------------------- CMS sign-in
/**
 * Signing in to Payload from inside the app, so publishing does not depend on
 * environment variables being set before launch. The password is verified
 * against the CMS before anything is stored, and it only ever reaches this
 * machine's own backend, which forwards it straight to Payload.
 */
function openLogin(reason) {
  set({
    login: {
      email: state.status?.payload?.email || '',
      password: '',
      remember: false,
      busy: false,
      error: null,
      reason: reason || null,
    },
  });
}

const setLogin = (patch) => set({ login: { ...state.login, ...patch } });

async function submitLogin() {
  const { email, password, remember } = state.login;
  if (!email.trim() || !password) {
    setLogin({ error: 'Email and password are both required.' });
    return;
  }
  setLogin({ busy: true, error: null });
  try {
    const res = await rpc.payloadLogin({ email: email.trim(), password, remember });
    // Re-read status so the badge and the Publish button agree immediately.
    state.status = await rpc.status();
    set({ login: null });
    toast(`Signed in to the CMS as ${res.email}${res.remembered ? ' — remembered on this device' : ''}`);
  } catch (err) {
    setLogin({ busy: false, error: err.message });
  }
}

async function signOut() {
  try {
    await rpc.payloadLogout();
    state.status = await rpc.status();
    set({});
    toast('Signed out of the CMS');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function loginModal() {
  const l = state.login;
  const close = () => set({ login: null });

  return h(
    'div.modal',
    {
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      },
    },
    h(
      'form.modal__box',
      {
        onSubmit: (e) => {
          e.preventDefault();
          if (!l.busy) submitLogin();
        },
      },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        h('span.ov', {}, 'Sign in to the CMS'),
        h(
          'span.m.dimmer',
          { style: { fontSize: '9.5px', letterSpacing: '0.12em' } },
          (state.status?.payload?.url || '').replace(/^https?:\/\//, '').toUpperCase()
        )
      ),
      l.reason ? h('div.modal__note.m', {}, l.reason) : null,
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'Email'),
        h('input.field', {
          id: 'login-email',
          type: 'email',
          autocomplete: 'username',
          value: l.email,
          disabled: l.busy || undefined,
          onInput: (e) => {
            state.login.email = e.target.value;
          },
        })
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'Password'),
        h('input.field', {
          id: 'login-password',
          type: 'password',
          autocomplete: 'current-password',
          value: l.password,
          disabled: l.busy || undefined,
          onInput: (e) => {
            state.login.password = e.target.value;
          },
        })
      ),
      h(
        'label.check',
        {},
        h('input', {
          type: 'checkbox',
          checked: l.remember || undefined,
          disabled: l.busy || undefined,
          onChange: (e) => {
            state.login.remember = e.target.checked;
            render();
          },
        }),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
          h('span.m', { style: { fontSize: '10px', letterSpacing: '0.1em' } }, 'Remember my login on this device'),
          h(
            'span.m.dimmer',
            { style: { fontSize: '8.5px', letterSpacing: '0.08em', lineHeight: 1.5 } },
            l.remember
              ? 'Stored in plain text in config.json on this machine. Untick to keep it for this session only.'
              : 'Otherwise the password is kept only until this app closes.'
          )
        )
      ),
      l.error ? h('div.modal__err.m', {}, l.error) : null,
      h(
        'div',
        { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' } },
        h('button.btn.btn--ghost', { type: 'button', onClick: close, disabled: l.busy || undefined }, 'CANCEL'),
        h('button.btn', { type: 'submit', disabled: l.busy || undefined }, l.busy ? 'SIGNING IN…' : 'SIGN IN')
      )
    )
  );
}

// ----------------------------------------------------------------- settings
// ------------------------------------------------------------------ site publish
//
// Writing to the CMS no longer builds anything: since 2026-09-07 the only
// thing that turns the CMS into pages is the site-wide publish, which the
// team's MCP server runs on the CMS host. This button is that, from here.
// One state for the whole app, because there is one site and one build.

const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The clock in the panel ticks without a full render: the whole screen
// re-rendering every second would fight a drag in progress.
setInterval(() => {
  if (state.site?.phase !== 'running') return;
  const el = document.getElementById('site-elapsed');
  if (el) el.textContent = fmtElapsed(Date.now() - state.site.since);
}, 1000);

async function runSitePublish() {
  if (state.site?.phase === 'running') return;
  if (!state.status?.payload?.publishToken) {
    toast('Add the site publish token under ROOTS first', 'error');
    openSettings();
    return;
  }
  state.site = { phase: 'running', since: Date.now() };
  render();
  try {
    const r = await rpc.publishSite();
    state.site = { phase: r.success ? 'live' : 'failed', since: state.site.since, seconds: r.seconds, log: r.log || '', at: Date.now() };
    if (r.success) {
      toast(`Site published in ${fmtElapsed(r.seconds * 1000)}`, 'ok');
      notify('Site published', `Live after ${fmtElapsed(r.seconds * 1000)}`);
    } else {
      toast('The site build failed — see the log in the panel', 'error');
      notify('Site build failed', (r.log || '').slice(-160));
    }
  } catch (err) {
    state.site = { phase: 'failed', since: state.site.since, error: err.message, at: Date.now() };
    toast(err.message, 'error');
  }
  render();
}

/**
 * The PUBLISH SITE block for a right-hand pane. `hold` is the reason it is
 * not the moment — unsaved changes, a write in flight — shown in place of
 * the button's readiness.
 */
function sitePublishPanel(hold = '') {
  const s = state.site || { phase: 'idle' };
  const running = s.phase === 'running';
  const hasToken = Boolean(state.status?.payload?.publishToken);
  const line = (k, v, id) =>
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--rule)' } },
      h('span.m.dim', { style: { fontSize: '9px', letterSpacing: '0.18em' } }, k),
      h('span.m', { id, style: { fontSize: '9.5px', letterSpacing: '0.06em', fontVariantNumeric: 'tabular-nums' } }, v)
    );
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '16px', borderTop: '1px solid var(--rule)' } },
    h('span.ov', {}, 'Site'),
    h(
      'p.m.dimmer',
      { style: { margin: 0, fontSize: '9px', lineHeight: 1.8, letterSpacing: '0.1em' } },
      'THE CMS DOES NOT REBUILD THE SITE ON ITS OWN. THIS RUNS THE SITE-WIDE PUBLISH ON THE CMS HOST — EVERYTHING SAVED, BY ANYONE — AND WAITS FOR IT. A MINUTE OR TWO.'
    ),
    running
      ? h('div', { style: { borderTop: '1px solid var(--rule)' } }, line('BUILDING', fmtElapsed(Date.now() - s.since), 'site-elapsed'))
      : s.phase === 'live'
        ? h('div', { style: { borderTop: '1px solid var(--rule)' } }, line('LIVE', `${fmtElapsed((s.seconds || 0) * 1000)} · ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`))
        : s.phase === 'failed'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px', border: '1px solid var(--cw45)', padding: '10px 12px' } },
              h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, 'PUBLISH FAILED'),
              h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.06em', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '160px', overflow: 'auto' } }, s.error || (s.log || '').slice(-600) || 'no detail came back')
            )
          : null,
    h(
      'button.btn',
      {
        disabled: running || Boolean(hold),
        title: hold || (hasToken ? 'Rebuild the whole site from what the CMS holds now' : 'Needs the site publish token — it opens the settings'),
        onClick: runSitePublish,
      },
      running ? 'PUBLISHING…' : 'PUBLISH SITE'
    ),
    hold ? h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.14em', lineHeight: 1.7 } }, hold.toUpperCase()) : null
  );
}

async function openSettings() {
  try {
    const s = await rpc.getSettings();
    workThumbs.clear();
    set({ settingsOpen: true, workOrderOpen: false, workOrder: null, cmsGallery: null, cmsGalleryFor: null, settings: s, browse: null, browseFor: null });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function browseTo(dir) {
  try {
    state.browse = await rpc.browse(dir);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

const editRoot = (i, patch) => {
  state.settings.roots = state.settings.roots.map((r, j) => (j === i ? { ...r, ...patch } : r));
  render();
};

async function saveSettings() {
  try {
    const s = await rpc.saveSettings({
      roots: state.settings.roots,
      payloadUrl: state.settings.payload.url,
      // Only sent when typed: undefined keeps whatever is stored.
      publishToken: state.settings.publishTokenNew,
    });
    state.settings = s;
    state.status = await rpc.status();
    await withLoading('RESCANNING THE ROOTS', s.roots.map((r) => r.path).join('  '), async () => {
      state.projects = await rpc.listProjects();
    });
    // The open project may have come from a root that just went away.
    if (state.project && !state.projects.some((p) => p.id === state.project.id)) {
      Object.assign(state, { project: null, screen: 'pick' });
    }
    set({ settingsOpen: false, browse: null, browseFor: null });
    const off = s.roots.filter((r) => !r.online).length;
    toast(off ? `Saved — ${off} root${off > 1 ? 's' : ''} unreachable` : `Saved — ${state.projects.length} projects`, off ? 'error' : 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function settingsPanel() {
  const s = state.settings;
  if (!s) return h('div.empty', {}, 'Loading');

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.scroll',
      { style: { padding: '38px 40px', gap: '24px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, h('span.ov', {}, 'Settings'), h('h1', { style: { margin: 0, fontWeight: 500, fontSize: '46px', lineHeight: 1 } }, 'Asset roots')),
        h('button.chip', { onClick: () => set({ settingsOpen: false }) }, 'CLOSE')
      ),
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '10px', lineHeight: 1.75, letterSpacing: '0.06em', maxWidth: '640px' } },
        'Each root is a folder holding project folders. A local drive, a mapped drive, or a UNC share on the NAS — \\\\server\\share\\projects. Roots are scanned in order; an unreachable one is skipped rather than failing the app.'
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        s.roots.map((r, i) =>
          h(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center', border: '1px solid var(--rule)', padding: '10px 12px' } },
            h('span', { style: { color: r.online ? 'var(--cw)' : 'var(--cw35)', display: 'flex' } }, IC.server()),
            h('input.field', {
              id: `root-label-${i}`,
              value: r.label || '',
              placeholder: 'LABEL',
              style: { width: '110px', border: 0, padding: '4px 0', letterSpacing: '0.16em' },
              onChange: (e) => editRoot(i, { label: e.target.value }),
            }),
            h('input.field', {
              id: `root-path-${i}`,
              value: r.path || '',
              placeholder: '\\\\nas\\projects  or  A:\\...',
              style: { flex: '1 1 auto', border: 0, padding: '4px 0' },
              onChange: (e) => editRoot(i, { path: e.target.value }),
            }),
            h('span.m', { style: { fontSize: '8.5px', letterSpacing: '0.18em', color: r.online ? 'var(--cw)' : 'var(--cw35)' } }, r.online ? 'ONLINE' : 'UNREACHABLE'),
            h(
              'button.chip',
              {
                onClick: async () => {
                  // The desktop build gets the real Windows dialog, which knows
                  // about network locations and mapped drives; the web build
                  // falls back to the in-app browser.
                  if (isTauri) {
                    const chosen = await pickFolder(r.path);
                    if (chosen) editRoot(i, { path: chosen });
                    return;
                  }
                  state.browseFor = i;
                  browseTo(r.path || '');
                },
              },
              isTauri ? 'CHOOSE…' : 'BROWSE'
            ),
            h('button.railrow__x', { title: 'Remove', onClick: () => { state.settings.roots = s.roots.filter((_, j) => j !== i); render(); } }, IC.x())
          )
        ),
        h(
          'button.chip',
          { style: { alignSelf: 'flex-start' }, onClick: () => { state.settings.roots = [...s.roots, { label: '', path: '', online: false }]; render(); } },
          '+ ADD ROOT'
        )
      ),
      state.browse ? browsePanel() : null,
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px', paddingTop: '20px', borderTop: '1px solid var(--rule)', maxWidth: '520px' } },
        h('span.ov', {}, 'CMS target'),
        h('input.field', { id: 'payload-url', value: s.payload.url || '', onChange: (e) => { state.settings.payload = { ...s.payload, url: e.target.value }; render(); } }),
        h(
          'span.m.dimmer',
          { style: { fontSize: '8.5px', letterSpacing: '0.14em' } },
          s.payload.credentials ? 'CREDENTIALS LOADED FROM ENVIRONMENT' : 'NO CREDENTIALS — SET PAYLOAD_ADMIN_EMAIL AND PAYLOAD_ADMIN_PASSWORD'
        ),
        h('span.ov', { style: { paddingTop: '14px' } }, 'Site publish token'),
        h('input.field', {
          id: 'publish-token',
          type: 'password',
          autocomplete: 'off',
          spellcheck: false,
          placeholder: s.payload.publishToken ? 'SET — LEAVE BLANK TO KEEP, TYPE TO REPLACE' : 'MCP_BEARER_TOKEN FROM /etc/aoin-mcp.env ON THE CMS HOST',
          value: state.settings.publishTokenNew || '',
          onInput: (e) => { state.settings.publishTokenNew = e.target.value; },
        }),
        h(
          'span.m.dimmer',
          { style: { fontSize: '8.5px', letterSpacing: '0.14em', lineHeight: 1.7 } },
          'WHAT THE PUBLISH SITE BUTTON SIGNS IN WITH. IT IS THE TEAM MCP SERVER’S BEARER TOKEN, AND LIKE A REMEMBERED PASSWORD IT IS KEPT IN PLAIN TEXT IN CONFIG.JSON ON THIS MACHINE ONLY.'
        ),
        s.payload.publishToken
          ? h('button.chip', { style: { alignSelf: 'flex-start' }, onClick: () => { state.settings.publishTokenNew = ''; saveSettings(); } }, 'FORGET THE TOKEN')
          : null
      ),
      h('div.grow'),
      h(
        'div',
        { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '16px' } },
        h('button.btn.btn--ghost', { onClick: () => set({ settingsOpen: false }) }, 'CANCEL'),
        h('button.btn', { onClick: saveSettings }, 'SAVE AND RESCAN')
      )
    )
  );
}

function browsePanel() {
  const b = state.browse;
  return h(
    'div',
    { style: { border: '1px solid var(--cw)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '340px' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('span.ov', {}, 'Browse'),
      h('span.m.trunc.grow', { style: { fontSize: '10px', color: b.online ? 'var(--cw)' : 'var(--cw35)' } }, b.path || 'Type a path above, then Browse'),
      b.parent ? h('button.chip', { onClick: () => browseTo(b.parent) }, h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, IC.up(), 'UP')) : null,
      h(
        'button.chip',
        {
          'aria-pressed': 'true',
          onClick: () => {
            editRoot(state.browseFor, { path: b.path });
            set({ browse: null, browseFor: null });
          },
        },
        'USE THIS FOLDER'
      )
    ),
    !b.online
      ? h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.12em' } }, 'NOT REACHABLE FROM THIS MACHINE — CHECK THE SHARE IS MOUNTED')
      : h(
          'div.scroll',
          { style: { display: 'flex', flexDirection: 'column' } },
          b.dirs.length
            ? b.dirs.map((d) =>
                h('button.treerow', { onClick: () => browseTo(d.path) }, IC.folder(), h('span.trunc.grow', {}, d.name))
              )
            : h('span.m.dimmer', { style: { fontSize: '9.5px', padding: '8px 0' } }, 'NO SUBFOLDERS')
        )
  );
}

// ------------------------------------------------------------- 01 · picker
// ------------------------------------------------- editing a CMS page
//
// Opening a project from the CMS instead of an asset folder. The form is filled
// from the document, so unlike the compose path it KNOWS the stored values --
// which is why publishing from here can send only what actually changed.

/** The CMS project list for step 01, fetched once per visit to that tab. */
async function loadCmsProjects() {
  if (state.cmsLoading) return;
  set({ cmsLoading: true });
  try {
    set({ cmsProjects: await rpc.cmsProjects(), cmsLoading: false });
  } catch (err) {
    set({ cmsLoading: false });
    toast(err.message, 'error');
  }
}

/**
 * Loads one CMS project into the step 04 form and jumps there. `baseline` is a
 * deep copy of what was loaded: publish diffs against it so an untouched field
 * is never sent, which is what keeps a partial edit from overwriting the rest of
 * the document.
 */
async function openCmsProject(id) {
  startLoading('OPENING FROM THE CMS', '');
  try {
    const doc = await rpc.cmsFields(id);
    stopLoading();
    set({
      cmsDoc: {
        id: doc.id,
        baseline: JSON.parse(JSON.stringify(doc.fields)),
        writeupOriginal: doc.writeupOriginal || [],
        writeupDropped: doc.writeupDropped || 0,
        code: doc.code || '',
        url: doc.url || '',
        keyImageUrl: doc.keyImageUrl || '',
      },
      fields: doc.fields,
      // An asset-folder project and a CMS document are mutually exclusive: the
      // compose steps read `state.project` and would otherwise show the leftovers
      // of whatever was open before.
      project: null,
      pickedIds: [],
      gallery: [],
      hero: null,
      manifestPath: null,
      job: null,
      jobSteps: [],
      publishResult: null,
      screen: 'copy',
    });
    revalidate();
  } catch (err) {
    stopLoading();
    toast(err.message, 'error');
  }
}

/** Which editable fields differ from what was loaded. Empty means nothing to save. */
function cmsChangedKeys() {
  const base = state.cmsDoc?.baseline;
  const f = state.fields;
  if (!base || !f) return [];
  const EDITABLE = ['title', 'slug', 'year', 'tour', 'collaborator', 'summary',
    'capabilities', 'services', 'stats', 'credits',
    'writeup', 'writeupColumns', 'visibility', 'featured', 'featuredOrder'];
  // Deep compare by serialisation: every one of these is plain JSON, and it
  // catches a reordered array (which IS a change) without a bespoke comparator.
  return EDITABLE.filter((k) => JSON.stringify(f[k] ?? null) !== JSON.stringify(base[k] ?? null))
    // A blank visibility means "keep what is stored", which is not a change to
    // send: the CMS only takes one of its three values.
    .filter((k) => !(k === 'visibility' && !f.visibility));
}

/**
 * Writes the changed fields back. Only the diff is sent; the write-up is sent as
 * its ORIGINAL Slate when untouched, so inline images and clips dropped into the
 * prose from the Payload admin are not converted away.
 */
async function runCmsSave() {
  if (!state.status?.payload?.credentials) {
    openLogin('Saving needs a CMS login. Sign in and the save will continue.');
    return;
  }
  const changed = cmsChangedKeys();
  if (!changed.length) {
    toast('Nothing changed');
    return;
  }
  set({ publishing: true });
  startLoading('SAVING TO THE CMS', state.cmsDoc?.url || '');
  try {
    const untouchedWriteup = !changed.includes('writeup');
    const res = await rpc.saveCmsFields(
      state.cmsDoc.id,
      state.fields,
      changed,
      untouchedWriteup ? state.cmsDoc.writeupOriginal : undefined
    );
    stopLoading();
    // The saved document becomes the new baseline, so a second save sends only
    // what changed after this one rather than repeating the whole diff.
    set({
      publishing: false,
      cmsDoc: { ...state.cmsDoc, baseline: JSON.parse(JSON.stringify(state.fields)) },
      publishResult: { slug: state.fields.slug, mediaCount: 0, url: state.cmsDoc.url, fields: res.written },
    });
    const summary = `${state.fields.slug} — ${res.written.length} field${res.written.length === 1 ? '' : 's'} — publish the site to go live`;
    toast(`Saved ${summary}`);
    notify('Saved to the CMS', summary);
  } catch (err) {
    stopLoading();
    set({ publishing: false });
    toast(err.message, 'error');
    notify('Save failed', err.message);
  }
}

/** The CMS project list on step 01 — the pages that already exist. */
function cmsPickList() {
  const q = state.search.trim().toLowerCase();
  const all = state.cmsProjects || [];
  const list = all.filter(
    (p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q) || (p.code || '').toLowerCase().includes(q)
  );

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '13px' } },
    h(
      'label',
      { style: { display: 'flex', alignItems: 'center', gap: '11px', border: '1px solid var(--rule)', padding: '11px 14px' } },
      IC.search(),
      h('input.m', {
        id: 'q',
        value: state.search,
        placeholder: 'FILTER BY NAME, SLUG OR CODE',
        style: { flex: '1 1 auto', fontSize: '11px', letterSpacing: '0.1em', outline: 'none' },
        onInput: (e) => {
          state.search = e.target.value;
          render();
        },
      })
    ),
    h(
      'div',
      {},
      h(
        'div.prow.m',
        { style: { fontSize: '9px', letterSpacing: '0.22em', color: 'var(--cw45)', borderBottom: '1px solid var(--cw)', padding: '0 16px 10px' } },
        h('span', {}, 'CODE'),
        h('span', {}, 'PROJECT'),
        h('span', {}, 'YEAR'),
        h('span', {}, 'VISIBILITY'),
        h('span', {}, 'WRITE-UP'),
        h('span', {}, 'ORDER')
      ),
      state.cmsLoading
        ? h('span.m.dimmer', { style: { display: 'block', padding: '18px 16px', fontSize: '9.5px', letterSpacing: '0.18em' } }, 'READING THE CMS…')
        : list.length
          ? list.map((p) =>
              h(
                'button.prow',
                { title: `Open ${p.slug} for editing`, onClick: () => openCmsProject(p.id) },
                h('span.m', { style: { fontSize: '11px', letterSpacing: '0.12em' } }, p.code || '—'),
                h('span.prow__name.trunc', {}, p.title),
                h('span.m', { style: { fontSize: '11px' } }, p.year || '—'),
                h(
                  'span.m',
                  {
                    style: {
                      fontSize: '9.5px',
                      letterSpacing: '0.16em',
                      // Unlisted and archive are the ones worth spotting in a long
                      // run; published is the norm and stays quiet.
                      color: p.visibility === 'published' ? 'var(--cw45)' : 'var(--cw)',
                    },
                  },
                  (p.visibility || '').toUpperCase()
                ),
                p.hasWriteup
                  ? h('span.m', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9.5px', letterSpacing: '0.16em' } }, IC.check(), 'YES')
                  : h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, 'NONE'),
                h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.12em' } }, p.order ?? '—')
              )
            )
          : h('span.m.dimmer', { style: { display: 'block', padding: '18px 16px', fontSize: '9.5px', letterSpacing: '0.18em' } }, all.length ? 'NOTHING MATCHES THAT FILTER' : 'NO PAGES IN THE CMS')
    )
  );
}

function screenPick() {
  const roots = state.status?.roots || [];
  const q = state.search.trim().toLowerCase();
  const list = state.projects.filter(
    (p) =>
      (!state.rootFilter || p.root === state.rootFilter) &&
      (!q || p.folder.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.jobCode.includes(q))
  );
  const sel = list.find((p) => p.id === state.selectedProjectId) || list[0];

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.pick.scroll',
      {},
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          h('span.ov', {}, 'Step 01'),
          h('h1', {}, state.cmsMode ? 'Edit a live page' : 'Select a project')
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '5px' } },
          // Which list this step is showing. An asset folder builds a page from
          // scratch; a CMS page is one that already exists and is being changed.
          h('button.chip', { 'aria-pressed': String(!state.cmsMode), onClick: () => set({ cmsMode: false }) }, 'ASSET FOLDERS'),
          h(
            'button.chip',
            {
              'aria-pressed': String(state.cmsMode),
              onClick: () => {
                set({ cmsMode: true });
                if (!state.cmsProjects) loadCmsProjects();
              },
            },
            'LIVE PAGES'
          ),
          state.cmsMode
            ? null
            : roots.map((r) =>
                h('button.chip', { 'aria-pressed': String(state.rootFilter === r.label), onClick: () => set({ rootFilter: state.rootFilter === r.label ? null : r.label }) }, r.label)
              )
        )
      ),
      state.cmsMode ? cmsPickList() : null,
      !state.cmsMode && (state.status?.offline || []).length
        ? h(
            'button',
            { style: { display: 'flex', alignItems: 'center', gap: '11px', border: '1px solid var(--cw45)', padding: '11px 14px', textAlign: 'left' }, onClick: openSettings },
            IC.server(),
            h('span.m.grow', { style: { fontSize: '9.5px', letterSpacing: '0.14em', color: 'var(--cw80)' } }, `${state.status.offline.length} ROOT${state.status.offline.length > 1 ? 'S' : ''} UNREACHABLE — ${state.status.offline.map((r) => r.label).join(', ')}`),
            h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.18em' } }, 'OPEN SETTINGS')
          )
        : null,
      state.cmsMode ? null : h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '11px', border: '1px solid var(--rule)', padding: '11px 14px' } },
        IC.search(),
        h('input.m', {
          id: 'q',
          value: state.search,
          placeholder: 'FILTER BY NAME OR JOB CODE',
          style: { flex: '1 1 auto', fontSize: '11px', letterSpacing: '0.1em', outline: 'none' },
          onInput: (e) => {
            state.search = e.target.value;
            render();
          },
        })
      ),
      state.cmsMode ? null : h(
        'div',
        {},
        h(
          'div.prow.m',
          { style: { fontSize: '9px', letterSpacing: '0.22em', color: 'var(--cw45)', borderBottom: '1px solid var(--cw)', padding: '0 16px 10px' } },
          h('span', {}, 'JOB'),
          h('span', {}, 'PROJECT'),
          h('span', {}, 'STILLS'),
          h('span', {}, 'VIDEO'),
          h('span', {}, 'COPY DOC'),
          h('span', {}, 'MODIFIED')
        ),
        list.length
          ? list.map((p) =>
              h(
                'button.prow',
                {
                  'aria-selected': String(sel?.id === p.id || state.pickedIds.includes(p.id)),
                  'data-picked': state.pickedIds.length > 1 && state.pickedIds.includes(p.id) ? String(state.pickedIds.indexOf(p.id) + 1) : null,
                  title: 'Shift or Ctrl-click to build a page from more than one folder',
                  onClick: (e) => pickProject(p.id, list, e),
                  onDblclick: () => openPicked([p.id]),
                },
                h('span.m', { style: { fontSize: '11px', letterSpacing: '0.12em' } }, p.jobCode || '—'),
                h('span.prow__name.trunc', {}, p.title),
                h('span.m', { style: { fontSize: '11px' } }, p.stills),
                h('span.m', { style: { fontSize: '11px' } }, p.videos),
                p.copyDoc
                  ? h('span.m', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '9.5px', letterSpacing: '0.16em' } }, IC.check(), 'FOUND')
                  : h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, p.stills + p.videos ? 'MISSING' : 'EMPTY'),
                h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.12em' } }, new Date(p.mtime).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase())
              )
            )
          : state.loading?.inline
            ? loader(state.loading.label, state.loading.detail, state.loading.since)
            : h('div.empty', {}, 'No projects match')
      )
    ),
    h(
      'div.pane.pane--r',
      { style: { width: '390px', padding: '38px 30px', gap: '22px' } },
      h('span.ov', {}, 'Preview'),
      // The preview describes an ASSET FOLDER — its stills, clips and default
      // name. None of that applies to a live page, and leaving it up showed the
      // last-picked folder beside an unrelated list, which read as a selection.
      state.cmsMode
        ? h(
            'span.m.dimmer',
            { style: { fontSize: '9.5px', letterSpacing: '0.14em', lineHeight: 1.7 } },
            'PICK A PAGE TO OPEN IT FOR EDITING.'
          )
        : sel
        ? [
            h(
              'div',
              { style: { borderRadius: '12px', overflow: 'hidden', aspectRatio: '16/9', background: '#111' } },
              // `__first` lets the picker preview a project before it is opened.
              thumbImg(sel.id, '__first', 700, { style: 'width:100%;height:100%;object-fit:cover;display:block' })
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('h2', { style: { margin: 0, fontWeight: 500, fontSize: '30px', lineHeight: 1, letterSpacing: '0.02em' } }, sel.title),
              h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.14em' } }, sel.folder.toUpperCase())
            ),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--rule)' } },
              [
                ['STILLS', sel.stills],
                ['VIDEO', sel.videos],
                ['COPY DOC', sel.copyDoc ? sel.copyDoc.split('/').pop().toUpperCase() : 'NOT FOUND'],
                ['DEFAULT NAME', slugify(sel.title)],
              ].map(([k, v]) =>
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--rule)' } },
                  h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, k),
                  h('span.m.trunc', { style: { fontSize: '10px', letterSpacing: '0.06em' } }, String(v))
                )
              )
            ),
            h('div.grow'),
            state.pickedIds.length > 1
              ? h(
                  'span.m.dimmer',
                  { style: { fontSize: '9px', letterSpacing: '0.14em', lineHeight: 1.6 } },
                  `${state.pickedIds.length} FOLDERS \u00b7 ${(state.projects.find((x) => x.id === state.pickedIds[0])?.folder || '').toUpperCase()} IS PRIMARY`
                )
              : null,
            h(
              'button.btn',
              { onClick: () => openPicked(state.pickedIds.length ? state.pickedIds : [sel.id]) },
              state.pickedIds.length > 1 ? `OPEN ${state.pickedIds.length} FOLDERS TOGETHER` : 'OPEN IN COMPOSER'
            ),
          ]
        : h('div.empty', {}, 'Nothing selected')
    )
  );
}

/**
 * Click selects; shift extends a range; ctrl/cmd toggles one. The order is
 * kept because the first folder picked is the primary — it names the page and
 * receives the composed output, so "which one did I click first" is meaningful
 * rather than incidental.
 */
function pickProject(id, list, e) {
  if (e.shiftKey && state.pickedIds.length) {
    const anchor = list.findIndex((p) => p.id === state.pickedIds[0]);
    const to = list.findIndex((p) => p.id === id);
    if (anchor >= 0 && to >= 0) {
      const [a, b] = anchor <= to ? [anchor, to] : [to, anchor];
      const span = list.slice(a, b + 1).map((p) => p.id);
      // The anchor stays first whichever direction the range was dragged.
      const primary = list[anchor].id;
      set({ pickedIds: [primary, ...span.filter((x) => x !== primary)], selectedProjectId: id });
      return;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    const next = state.pickedIds.includes(id)
      ? state.pickedIds.filter((x) => x !== id)
      : [...(state.pickedIds.length ? state.pickedIds : [state.selectedProjectId].filter(Boolean)), id];
    set({ pickedIds: next, selectedProjectId: id });
    return;
  }
  set({ pickedIds: [], selectedProjectId: id });
}

/** One folder or several — several are merged into a single composite id. */
async function openPicked(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  if (unique.length === 1) return openProject(unique[0]);
  try {
    const merged = await withLoading('MERGING FOLDERS', `${unique.length} SOURCES`, () => rpc.mergeIds(unique), { inline: true });
    await openProject(merged);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openProject(id) {
  const summary = state.projects.find((p) => p.id === id);
  const project = await withLoading(
    'READING THE PROJECT FOLDER',
    summary ? `${summary.folder}  ${(summary.stills || 0) + (summary.videos || 0)} ASSETS` : '',
    () => rpc.getProject(id)
  );
  const saved = restore(id) || {};
  const known = new Set(project.assets.map((a) => a.rel));
  set({
    project,
    selectedProjectId: id,
    screen: 'compose',
    hero: known.has(saved.hero) ? saved.hero : null,
    // Selections saved before layouts existed are a flat list of spans;
    // normaliseGallery folds those into rows so nobody's carousel is lost.
    gallery: normaliseGallery(saved.gallery)
      .map((r) => ({ ...r, items: r.items.filter((it) => known.has(it.rel)) }))
      .filter((r) => r.items.length)
      .map((r) => ({ ...r, layout: r.items.length === slotsFor(r.layout) ? r.layout : (layoutsForCount(r.items.length)[0] || DEFAULT_LAYOUT) })),
    // Trims for assets that are no longer in the project would linger in
    // storage forever and badge nothing; drop them on the way back in.
    trims: Object.fromEntries(Object.entries(saved.trims || {}).filter(([key]) => known.has(relOfKey(key)))),
    base: saved.base || project.slug,
    baseTouched: Boolean(saved.base),
    outDir: saved.outDir || '',
    fields: normaliseWriteup(saved.fields) || null,
    copy: null,
    job: null,
    jobSteps: [],
    jobLog: [],
    manifestPath: null,
    publishResult: null,
    dirFilter: null,
    kindFilter: 'all',
    collapsed: new Set(),
  });
  if (project.docs.length) loadCopy();
}

// ------------------------------------------------------------ 02 · compose
/** The kind ('still' | 'video') of an asset in the open project. */
const kindOf = (rel) => state.project?.assets.find((a) => a.rel === rel)?.kind;

function pickAsset(rel) {
  if (state.mode === 'hero') {
    // `image` is the key image: the project hero AND the work-grid thumbnail.
    // A video there renders as a broken tile on the site, so it is refused here
    // rather than at publish, where it would be far more annoying to discover.
    if (kindOf(rel) === 'video') {
      toast('The hero must be a still — it is also the work-grid thumbnail', 'error');
      return;
    }
    // Clicking the current hero clears it, so it can be moved to the carousel.
    set({
      hero: state.hero === rel ? null : rel,
      gallery: withoutRel(state.gallery, rel),
    });
    return;
  }
  const found = findRel(state.gallery, rel);
  if (found) set({ gallery: removeTile(state.gallery, found.row, found.slot) });
  else set({ gallery: appendTile(state.gallery, rel), hero: state.hero === rel ? null : state.hero });
}

/** The assets the contact sheet is showing right now, in its own order. */
function visibleAssets() {
  const p = state.project;
  if (!p) return [];
  return p.assets.filter(
    (a) => (state.kindFilter === 'all' || a.kind === state.kindFilter) && inFolder(a.dir, state.dirFilter)
  );
}

// ------------------------------------------------------- 02b · quick look
//
// Finder's Quick Look, for the contact sheet: space opens whatever is under the
// cursor, space or escape closes it, the arrows walk the sheet. A 420px thumb
// is enough to recognise a shot and nowhere near enough to judge one, and a
// video had no preview at all — the tile was a single frozen frame.
//
// The overlay is built by hand and lives on <body>, deliberately NOT in the
// render tree: render() calls replaceChildren on #app, so a <video> in there
// would be torn down and rebuilt — restarting playback — every time anything
// else in the app changed state, including adding the very asset being watched.
let hoverRel = null;
let peek = null; // { rel, node, stage, bar } while the overlay is up

function openPeek(rel, key = rel) {
  if (!rel || !state.project) return;
  if (peek) return showPeek(rel, key);
  const stage = h('div.peek__stage');
  const trim = h('div.peek__trim');
  const bar = h('div.peek__bar');
  const node = h(
    'div.peek',
    {
      // Only a click on the backdrop itself closes — not one that lands on the
      // picture, and not one on the scrub bar of a video.
      onClick: (e) => {
        if (e.target === e.currentTarget || e.target === stage) closePeek();
      },
    },
    stage,
    trim,
    bar
  );
  document.body.append(node);
  peek = { rel: null, key: null, node, stage, trim, bar, head: null, video: null, blob: null, info: null, timeline: null };
  showPeek(rel, key);
}

/** A blob URL is held by the process until it is revoked; the proxy is a few
 *  megabytes, so leaking one per clip previewed adds up over an afternoon. */
function releaseBlob() {
  if (peek?.blob) {
    URL.revokeObjectURL(peek.blob);
    peek.blob = null;
  }
}

function closePeek() {
  if (!peek) return;
  releaseBlob();
  peek.timeline?.destroy();
  // Stop the download as well as the sound: a paused <video> that is still
  // buffering a 300MB source keeps pulling it over the network.
  peek.node.querySelector('video')?.pause();
  peek.node.remove();
  peek = null;
}

async function showPeek(rel, key = rel) {
  if (!peek) return;
  const asset = state.project.assets.find((a) => a.rel === rel);
  if (!asset) return;
  releaseBlob();
  peek.timeline?.destroy();
  peek.timeline = null;
  peek.info = null;
  peek.rel = rel;
  // Which cut of the clip the trim marks belong to. Opened from the contact
  // sheet it is the first placement; from a rail cell, that cell's own cut.
  peek.key = key;
  peek.head = null;
  peek.video = null;
  peek.stage.replaceChildren(h('div.peek__wait.m', {}, 'LOADING…'));
  peek.trim.replaceChildren();
  paintPeekBar();

  let src;
  try {
    src = await mediaSrc(state.project.id, rel);
  } catch (e) {
    if (peek?.rel === rel) peek.stage.replaceChildren(h('div.peek__wait.m', {}, String(e.message || e)));
    return;
  }
  // Arrowing quickly means several of these are in flight at once; only the
  // one still being asked for is allowed to paint.
  if (peek?.rel !== rel) return;

  if (asset.kind === 'video') {
    mountVideo(rel, src, false);
    // Probed in parallel with the file loading — the timeline needs the frame
    // rate, and waiting for it before showing the picture would make every
    // clip feel slow for the sake of a ruler.
    probeMedia(state.project.id, rel)
      .then((info) => {
        if (peek?.rel !== rel) return;
        peek.info = info;
        buildTimeline(rel);
      })
      .catch((e) => {
        if (peek?.rel === rel) peek.trim.replaceChildren(h('div.tl__warn.m', {}, 'NO FRAME RATE — ' + String(e.message || e)));
      });
  } else {
    peek.stage.replaceChildren(h('img.peek__media', { src, alt: asset.name }));
  }
}

/**
 * The original first, a transcoded proxy second.
 *
 * Plenty of what comes off the NAS is already h.264 mp4 and plays outright.
 * The rest — ProRes, most .mov, HEVC, which is most of what a camera writes —
 * the webview cannot decode at all, and says so with a `error` event and
 * MEDIA_ERR_SRC_NOT_SUPPORTED rather than by failing to load. That is the
 * signal to go and make a preview, which is a real transcode and takes as long
 * as it takes.
 */
function mountVideo(rel, src, isProxy) {
  // No native controls: the timeline IS the scrub surface, and a second one
  // under the picture would disagree with it about where a frame starts.
  const video = h('video.peek__media', {
    src,
    loop: true,
    playsinline: true,
    onClick: (e) => {
      e.stopPropagation();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    },
  });
  peek.video = video;
  // The PLAY / PAUSE chip in the bar reads the element's state, so it has to
  // be repainted whenever that state changes — including a click on the
  // picture, a key, or autoplay being refused.
  video.addEventListener('play', paintPeekBar);
  video.addEventListener('pause', paintPeekBar);

  video.addEventListener('error', async () => {
    if (peek?.rel !== rel || isProxy) {
      // The proxy failed too — there is nothing else to try.
      if (peek?.rel === rel) peek.stage.replaceChildren(h('div.peek__wait.m', {}, 'THIS FILE CANNOT BE PREVIEWED'));
      return;
    }
    peek.stage.replaceChildren(
      h('div.peek__wait.m', {}, 'MAKING A PREVIEW — A CAMERA MASTER TAKES A MOMENT…')
    );
    try {
      const proxy = await previewSrc(state.project.id, rel);
      if (peek?.rel !== rel) {
        if (proxy.startsWith('blob:')) URL.revokeObjectURL(proxy);
        return;
      }
      if (proxy.startsWith('blob:')) peek.blob = proxy;
      mountVideo(rel, proxy, true);
    } catch (e) {
      if (peek?.rel === rel) peek.stage.replaceChildren(h('div.peek__wait.m', {}, String(e.message || e)));
    }
  });

  const show = () => {
    if (peek?.rel !== rel) return;
    peek.stage.replaceChildren(video);
    peek.timeline?.repaint();
    // Autoplay with sound is blocked until the page has been interacted with;
    // fall back to muted rather than not playing at all.
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  };

  if (isProxy) {
    // A detached <video> still loads, so the "making a preview" line can stay
    // up for the whole transcode instead of being replaced by a black box.
    video.addEventListener('loadeddata', show, { once: true });
  } else {
    show();
  }

  // The proxy arrives after the probe did, so the timeline has to be told the
  // video element changed underneath it.
  video.addEventListener('loadedmetadata', () => {
    if (peek?.rel !== rel) return;
    if (peek.info) buildTimeline(rel);
    const t = trimOf(peek.key);
    if (t?.inFrame !== undefined && peek.info) peek.timeline?.goTo(t.inFrame);
  }, { once: true });
}

/** The stored trim for an asset, or null when it is untrimmed. */
const trimOf = (rel) => state.trims[rel] || null;

/**
 * Stores a trim as FRAMES, and derives the seconds the encoder needs.
 *
 * Both are kept: the frames are the truth an editor set and what the timeline
 * redraws from, the seconds are what compose puts in front of ffmpeg. Deriving
 * the seconds here — once, next to the frame rate they belong to — is what
 * stops the two drifting apart.
 */
function setTrim(rel, next, fps) {
  const trims = { ...state.trims };
  const rate = fps || trims[rel]?.fps || 0;
  const whole = next && rate > 0 && next.inFrame <= 0 && next.outFrame >= (peek?.info?.frames ?? 0) - 1;

  // A trim that keeps the whole clip is deleted, not stored — otherwise every
  // clip ever opened would carry one and the rail would badge all of them.
  if (!next || !rate || whole) delete trims[rel];
  else {
    const secs = spanSeconds(next.inFrame, next.outFrame, rate);
    trims[rel] = { inFrame: next.inFrame, outFrame: next.outFrame, fps: rate, in: secs.in, out: secs.out };
  }
  set({ trims });
}

/**
 * The timeline, once ffprobe has said what the frame rate is.
 *
 * It is built from `info` and not from the <video>: the element may be playing
 * a transcoded proxy, and even when it is not, a video element cannot tell you
 * its frame rate. The two agree because the proxy is encoded at the source's
 * own rate.
 */
function buildTimeline(rel) {
  if (!peek || peek.rel !== rel || !peek.info || !peek.video) return;
  const { fps, frames } = peek.info;

  // A trim stored before the timeline existed only has seconds. Recover the
  // frames from them now that the rate is known, rather than dropping it.
  const stored = trimOf(peek.key);
  if (stored && stored.inFrame === undefined) {
    setTrim(peek.key, { inFrame: frameOf(stored.in, fps), outFrame: Math.max(0, frameOf(stored.out, fps) - 1) }, fps);
  }

  peek.timeline?.destroy();
  peek.timeline = createTimeline({
    mount: peek.trim,
    video: peek.video,
    info: peek.info,
    getTrim: () => {
      const t = trimOf(peek.key);
      return t && t.inFrame !== undefined ? { inFrame: t.inFrame, outFrame: t.outFrame } : null;
    },
    onTrim: (next) => setTrim(peek.key, next, fps),
    onFrame: () => {},
  });

  // The playhead comes from requestVideoFrameCallback where it exists, because
  // its mediaTime is the presentation time of the frame actually on screen —
  // currentTime during playback is wherever the clock has got to, which is up
  // to a frame ahead of the picture. timeupdate is the fallback, at ~4Hz.
  const onFrameShown = (_now, meta) => {
    if (!peek || peek.rel !== rel) return;
    const f = frameOf(meta.mediaTime, fps);
    peek.timeline?.setFrame(f);
    // Loop the kept span — but only while PLAYING. Doing it whenever the frame
    // changed meant scrubbing past the out point snapped straight back to the
    // in point, which makes it impossible to look at the rest of the clip in
    // order to decide where the marks should go.
    const t = trimOf(peek.key);
    if (t && t.inFrame !== undefined && f > t.outFrame && !peek.video?.paused) peek.timeline?.goTo(t.inFrame);
    peek.video?.requestVideoFrameCallback?.(onFrameShown);
  };
  if (peek.video.requestVideoFrameCallback) peek.video.requestVideoFrameCallback(onFrameShown);
  else
    peek.video.addEventListener('timeupdate', () => {
      if (!peek || peek.rel !== rel) return;
      peek.timeline?.setFrame(frameOf(peek.video.currentTime, fps));
    });

  if (frames <= 1) peek.trim.append(h('div.tl__warn.m', {}, 'ONE FRAME — NOTHING TO TRIM'));
}

function stepPeek(delta) {
  if (!peek) return;
  const list = visibleAssets();
  if (!list.length) return;
  const i = list.findIndex((a) => a.rel === peek.rel);
  showPeek(list[(i + delta + list.length) % list.length].rel);
}

/**
 * Puts the clip in the carousel again as a new cut, starting from the trim of
 * the cut it was made from (so a second cut is usually 'the same, but later'),
 * and returns its key.
 */
function addCut(rel, fromKey = rel) {
  const used = flatTiles(state.gallery).filter((t) => t.rel === rel).map((t) => Number((t.cut || 'c1').slice(1)) || 1);
  const cut = `c${Math.max(1, ...used) + 1}`;
  const key = `${rel}#${cut}`;
  const trims = { ...state.trims };
  if (trims[fromKey]) trims[key] = { ...trims[fromKey] };
  set({
    gallery: [...state.gallery, { layout: DEFAULT_LAYOUT, items: [{ rel, cut, description: 'gallery' }] }],
    trims,
    hero: state.hero === rel ? null : state.hero,
  });
  return key;
}

function togglePeekPlay() {
  const v = peek?.video;
  if (!v) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}

function paintPeekBar() {
  if (!peek) return;
  const rel = peek.rel;
  const asset = state.project.assets.find((a) => a.rel === rel);
  if (!asset) return;
  const list = visibleAssets();
  const at = list.findIndex((a) => a.rel === rel);
  const placed = roleOf(rel);

  peek.bar.replaceChildren(
    h(
      'div.peek__id',
      {},
      h('span.m.peek__name', {}, cutOf(peek.key) ? `${asset.name}  ·  ${cutLabel(rel, peek.key)}` : asset.name),
      h(
        'span.m.dimmer',
        { style: { fontSize: '9px', letterSpacing: '0.16em' } },
        `${asset.kind.toUpperCase()} · ${bytes(asset.size)}${at >= 0 ? ` · ${at + 1} OF ${list.length}` : ''}`
      )
    ),
    h(
      'div.peek__acts',
      {},
      asset.kind !== 'video' &&
        h(
          'button.chip',
          {
            'aria-pressed': String(state.hero === rel),
            onClick: () => {
              set({ hero: state.hero === rel ? null : rel, gallery: withoutRel(state.gallery, rel) });
              paintPeekBar();
            },
          },
          state.hero === rel ? 'HERO ✓' : 'SET HERO'
        ),
      h(
        'button.chip',
        {
          'aria-pressed': String(Boolean(placed) && placed !== 'hero'),
          onClick: () => {
            pickAsset(rel);
            paintPeekBar();
          },
        },
        placed && placed !== 'hero' ? `IN CAROUSEL ${placed} — REMOVE` : 'ADD TO CAROUSEL'
      ),
      asset.kind === 'video' && placed
        ? h(
            'button.chip',
            {
              title: 'Put this clip in the carousel again, with its own in and out points',
              onClick: () => {
                const key = addCut(rel, peek.key);
                peek.key = key;
                if (peek.info) buildTimeline(rel);
                paintPeekBar();
                toast(`${cutLabel(rel, key)} added — set its in and out points`);
              },
            },
            'ANOTHER CUT'
          )
        : null,
      asset.kind === 'video'
        ? h(
            'button.chip',
            { 'aria-pressed': String(Boolean(peek.video && !peek.video.paused)), onClick: togglePeekPlay, title: 'Space, K or P' },
            peek.video && !peek.video.paused ? 'PAUSE  SPACE' : 'PLAY  SPACE'
          )
        : null,
      h('button.chip', { onClick: closePeek }, 'CLOSE  ESC')
    )
  );
}

// ------------------------------------------------------- the asset menu
//
// Two rows, because the two things you do with an asset are different in kind:
// the top row PLACES it, the bottom row OPENS it. Lives on <body> for the same
// reason the overlay does — render() replaces #app, and a menu that vanished
// the moment its own button changed the state would be unusable.
let menuNode = null;

function closeMenu() {
  menuNode?.remove();
  menuNode = null;
}

function openAssetMenu(rel, x, y) {
  closeMenu();
  const asset = state.project?.assets.find((a) => a.rel === rel);
  if (!asset) return;
  const placed = roleOf(rel);
  const inPage = Boolean(placed) && placed !== 'hero';

  const row = (...kids) => h('div.menu__row', {}, kids.filter(Boolean));
  const item = (label, title, fn) =>
    h('button.menu__btn', { title, onClick: () => { closeMenu(); fn(); } }, label);

  menuNode = h(
    'div.menu',
    { style: { left: x + 'px', top: y + 'px' } },
    h('div.menu__name.m', { title: rel }, asset.name),
    row(
      item(inPage ? `IN PAGE ${placed} — REMOVE` : 'ADD TO PAGE', 'Add or remove the carousel tile', () => pickAsset(rel)),
      asset.kind !== 'video' &&
        item(state.hero === rel ? 'HERO ✓ — CLEAR' : 'SET HERO', 'The key image, and the work-grid thumbnail', () =>
          set({ hero: state.hero === rel ? null : rel, gallery: withoutRel(state.gallery, rel) })
        )
    ),
    row(
      item(asset.kind === 'video' ? 'TRIM…' : 'PREVIEW', 'Open it full size  (space)', () => openPeek(rel)),
      asset.kind === 'video' && inPage && item('ANOTHER CUT', 'The same clip again, with its own in and out points', () => openPeek(rel, addCut(rel))),
      asset.kind === 'video' && trimOf(rel) && item('CLEAR TRIM', 'Encode the whole clip again', () => setTrim(rel, null))
    )
  );
  document.body.append(menuNode);

  // Nudge back on screen if it opened near an edge.
  const box = menuNode.getBoundingClientRect();
  if (box.right > innerWidth - 8) menuNode.style.left = Math.max(8, innerWidth - box.width - 8) + 'px';
  if (box.bottom > innerHeight - 8) menuNode.style.top = Math.max(8, innerHeight - box.height - 8) + 'px';
}

window.addEventListener('pointerdown', (e) => {
  if (menuNode && !(e.target instanceof HTMLElement && e.target.closest('.menu'))) closeMenu();
});
window.addEventListener('blur', closeMenu);

// A file dropped anywhere but the write-up would otherwise navigate the webview
// to it — the window goes blank and everything unsaved on the form is gone. This
// runs after the drop zone's own handler has bubbled up, so a hit is already
// dealt with and a miss is simply swallowed.
for (const kind of ['dragover', 'drop']) {
  window.addEventListener(kind, (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });
}

// One listener for the whole app. Space is the whole point, so it has to be
// taken before the browser scrolls the sheet — or, on a focused tile, before
// it fires the button's click and silently adds the asset.
window.addEventListener('keydown', (e) => {
  const el = e.target;
  if (el instanceof HTMLElement && el.closest('input, textarea, [contenteditable="true"]')) return;

  if (menuNode && e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
    return;
  }

  if (peek) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePeek();
    } else if (e.key === ' ') {
      // Space is the transport on a clip, the way it is in every player and
      // NLE; on a still there is nothing to play, so it closes as before.
      e.preventDefault();
      if (peek.video) togglePeekPlay();
      else closePeek();
    } else if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && !peek.timeline)) {
      e.preventDefault();
      stepPeek(1);
    } else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && !peek.timeline)) {
      e.preventDefault();
      stepPeek(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickAsset(peek.rel);
      paintPeekBar();
    } else if (peek.timeline) {
      // With a timeline up, the arrows belong to FRAMES — walking the contact
      // sheet moves to up/down. The letters are the NLE ones, because that is
      // what anyone reaching for a trim already has in their hands.
      const k = e.key.toLowerCase();
      const jump = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight') { e.preventDefault(); peek.timeline.step(jump); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); peek.timeline.step(-jump); }
      else if (k === 'i') { e.preventDefault(); peek.timeline.markIn(); }
      else if (k === 'o') { e.preventDefault(); peek.timeline.markOut(); }
      else if (k === 'f') { e.preventDefault(); peek.timeline.fit(); }
      else if (k === 'k' || k === 'p') {
        e.preventDefault();
        togglePeekPlay();
      }
    }
    return;
  }

  if (e.key !== ' ' || state.screen !== 'compose') return;
  // The cursor wins over focus, the way Finder works — you point at a frame and
  // hit space. Focus is the fallback for anyone driving it from the keyboard.
  const rel = hoverRel || (el instanceof HTMLElement ? el.closest('.tile')?.dataset.rel : null);
  if (!rel) return;
  e.preventDefault();
  openPeek(rel);
});

/** Where a given asset sits in the rows, if it is in the carousel at all. */
function findRel(rows, rel) {
  for (let r = 0; r < rows.length; r++) {
    const slot = rows[r].items.findIndex((it) => it.rel === rel);
    if (slot >= 0) return { row: r, slot };
  }
  return null;
}

function withoutRel(rows, rel) {
  const found = findRel(rows, rel);
  return found ? removeTile(rows, found.row, found.slot) : rows;
}

/**
 * A newly clicked tile always starts its own full-width row.
 *
 * This used to pair each new tile with a lone row above it, alternating 8·4 and
 * 5·7 to reproduce the site's rhythm automatically. It read as the tool
 * fighting you: every second click silently swallowed the image into a split
 * you had not asked for, and undoing it meant dragging back out. The rail is a
 * stack — one click, one row — and splits are made deliberately, by dragging a
 * tile onto another row or cycling a row's layout.
 */
function appendTile(rows, rel) {
  return [...rows, { layout: DEFAULT_LAYOUT, items: [{ rel, description: 'gallery' }] }];
}

function roleOf(rel) {
  if (state.hero === rel) return 'hero';
  const found = findRel(state.gallery, rel);
  if (!found) return null;
  // The badge shows the tile's place in reading order, which rows have to be
  // walked to work out — it is no longer just an index into a flat list.
  return pad2(rowOffsetOf(state.gallery, found.row) + found.slot + 1);
}

/**
 * The flat `dir` list the backend returns is a set of full relative paths, which
 * reads as a mess in a rail. Rebuild it as the real folder hierarchy, with each
 * parent carrying the totals of everything beneath it.
 */
function buildTree(flat) {
  const root = { name: 'ALL FOLDERS', path: '', depth: -1, children: [], images: 0, videos: 0 };
  const index = new Map([['', root]]);

  const ensure = (path, depth) => {
    if (index.has(path)) return index.get(path);
    const name = path.split('/').pop();
    const node = { name, path, depth, children: [], images: 0, videos: 0 };
    index.set(path, node);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    ensure(parentPath, depth - 1).children.push(node);
    return node;
  };

  for (const entry of flat) {
    // Assets sitting directly in the project folder report a dir of "/".
    const parts = entry.dir === '/' ? [] : entry.dir.split('/');
    root.images += entry.images;
    root.videos += entry.videos;
    let path = '';
    for (let i = 0; i < parts.length; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i];
      const node = ensure(path, i);
      node.images += entry.images;
      node.videos += entry.videos;
    }
  }

  const sort = (node) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** A folder filter matches its own assets and everything nested beneath it. */
const inFolder = (assetDir, filter) => !filter || assetDir === filter || assetDir.startsWith(filter + '/');

/** `@1` -> the name of the folder that source really is. */
function sourceName(name) {
  const m = /^@(\d+)$/.exec(String(name));
  if (!m) return String(name);
  const src = state.project?.sources?.[Number(m[1])];
  return src ? src.folder : name;
}

function treeRows(node, out = []) {
  for (const child of node.children) {
    const total = child.images + child.videos;
    const expanded = !state.collapsed.has(child.path);
    const hasKids = child.children.length > 0;
    out.push(
      h(
        'button.treerow',
        {
          'aria-pressed': String(state.dirFilter === child.path),
          style: { paddingLeft: `${child.depth * 12}px` },
          title: child.path,
          onClick: () => set({ dirFilter: state.dirFilter === child.path ? null : child.path }),
        },
        hasKids
          ? h(
              'span.treerow__twist',
              {
                title: expanded ? 'Collapse' : 'Expand',
                onClick: (e) => {
                  e.stopPropagation();
                  const next = new Set(state.collapsed);
                  next.has(child.path) ? next.delete(child.path) : next.add(child.path);
                  set({ collapsed: next });
                },
              },
              expanded ? IC.chevD() : IC.chev()
            )
          : h('span.treerow__twist'),
        child.videos > child.images ? IC.vid() : IC.img(),
        // A secondary source arrives as a folder literally named "@1". Show the
        // folder it actually is, or the rail asks the reader to decode indexes.
        h('span.trunc.grow', {}, sourceName(child.name).toUpperCase()),
        h('span.dimmer', { style: { fontSize: '9.5px' } }, total)
      )
    );
    if (expanded && hasKids) treeRows(child, out);
  }
  return out;
}

function screenCompose() {
  const p = state.project;
  const assets = visibleAssets();
  const names = plannedNames(state);
  const heroName = names.find((n) => n.role === 'hero');
  const thumbName = names.find((n) => n.role === 'thumb');
  const galleryNames = names.filter((n) => n.role === 'gallery');
  // Rows are the model, but planned names are one flat list in reading order,
  // so the rail needs a row/slot -> name lookup (and the running tile number).
  const rowOffsets = [];
  state.gallery.reduce((n, row, i) => {
    rowOffsets[i] = n;
    return n + row.items.length;
  }, 0);
  const nameAt = (row, slot) => {
    const n = (rowOffsets[row] ?? 0) + slot;
    return { ...(galleryNames[n] || {}), n };
  };
  const tree = buildTree(p.tree);

  return h(
    'div.screen',
    {},
    // ---- source rail
    h(
      'div.pane.pane--l',
      { style: { width: '240px', padding: '20px 18px', gap: '16px' } },
      h('span.ov', {}, 'Source'),
      h(
        'div',
        { style: { display: 'flex', gap: '5px' } },
        [['all', 'ALL'], ['image', 'STILLS'], ['video', 'VIDEO']].map(([k, label]) =>
          h('button.chip', { 'aria-pressed': String(state.kindFilter === k), onClick: () => set({ kindFilter: k }) }, label)
        )
      ),
      h(
        'div.scroll',
        { style: { display: 'flex', flexDirection: 'column' } },
        h(
          'button.treerow',
          { 'aria-pressed': String(!state.dirFilter), onClick: () => set({ dirFilter: null }) },
          h('span.treerow__twist'),
          IC.folder(),
          h('span.trunc.grow', {}, 'ALL FOLDERS'),
          h('span.dimmer', { style: { fontSize: '9.5px' } }, p.assets.length)
        ),
        treeRows(tree)
      ),
      h(
        'div',
        { style: { borderTop: '1px solid var(--rule)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('span.ov', {}, 'Copy Doc'),
        p.docs.length
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              IC.doc(),
              h('span.m.trunc.grow', { style: { fontSize: '9.5px' } }, p.docs[0].name.toUpperCase()),
              IC.check()
            )
          : h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.12em' } }, 'DROP A .DOCX OR .MD IN THE PROJECT FOLDER'),
        state.validation &&
          h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.12em' } }, `${state.validation.required - state.validation.missing.length} / ${state.validation.required} FIELDS MAPPED`)
      )
    ),

    // ---- contact sheet
    h(
      'div.pane.pane--main',
      { style: { padding: '20px 24px', gap: '14px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px', flex: '0 0 auto' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          h('span.ov', {}, 'Contact Sheet'),
          h(
            'span.m.dimmer',
            { style: { fontSize: '9.5px', letterSpacing: '0.16em' } },
            state.mode === 'hero' ? 'CLICK A TILE TO SET THE HERO — THE THUMB IS CROPPED FROM IT' : 'CLICK TO ADD OR REMOVE FROM THE CAROUSEL'
          )
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
          h('span.m.dim', { style: { fontSize: '10px', letterSpacing: '0.16em' } }, `${assets.length} ASSETS / ${names.length} SELECTED`),
          h(
            'div',
            { style: { display: 'flex', gap: '4px' } },
            [['grid', 'GRID'], ['list', 'LIST']].map(([k, label]) =>
              h('button.chip', { 'aria-pressed': String(state.view === k), onClick: () => set({ view: k }) }, label)
            )
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '4px' } },
            [['gallery', 'GALLERY'], ['hero', 'HERO']].map(([k, label]) =>
              h('button.chip', { 'aria-pressed': String(state.mode === k), onClick: () => set({ mode: k }) }, label)
            )
          )
        )
      ),
      assets.length
        ? state.view === 'list'
          ? assetList(assets)
          : h(
              'div.sheet.scroll',
              { id: 'sheet' },
              assets.map((a) => {
                const badge = roleOf(a.rel);
                return h(
                  'button.tile',
                  {
                    'data-rel': a.rel,
                    'data-on': badge ? '1' : '0',
                    'data-role': state.hero === a.rel ? 'hero' : '',
                    'data-blocked': state.mode === 'hero' && a.kind === 'video' ? '1' : '0',
                    onClick: () => pickAsset(a.rel),
                    title:
                      state.mode === 'hero' && a.kind === 'video'
                        ? a.rel + ' — a video cannot be the hero'
                        : a.rel + '\nclick to add · drag to place it exactly',
                    // Clicking appends to the end; dragging says WHERE. Same
                    // drop sites the rail already has, so a tile can go
                    // straight into a split or between two rows without being
                    // added and then moved.
                    // Quick Look follows the cursor, so the sheet has to say
                    // what is under it.
                    onMouseenter: () => {
                      hoverRel = a.rel;
                    },
                    onContextmenu: (e) => {
                      e.preventDefault();
                      openAssetMenu(a.rel, e.clientX, e.clientY);
                    },
                    onMouseleave: () => {
                      if (hoverRel === a.rel) hoverRel = null;
                    },
                    draggable: true,
                    onDragstart: (e) => {
                      state.drag = { from: 'source', rel: a.rel };
                      e.dataTransfer.effectAllowed = 'copy';
                      // Set directly, not through render(): re-rendering mid-drag
                      // replaces the element being dragged and Chromium cancels it.
                      markDragging(true);
                    },
                    onDragend: () => {
                      state.drag = null;
                      markDragging(false);
                    },
                  },
                  // An <img> is a drag source in its own right, so without this
                  // the browser drags the photo and the drop never fires.
                  thumb(a.rel, 420, { loading: 'lazy', alt: a.name, draggable: 'false' }),
                  badge && h('span.tile__badge', {}, badge === 'hero' ? 'HERO' : badge),
                  a.kind === 'video' && h('span.tile__vid.m', {}, a.ext.replace('.', '').toUpperCase()),
                  h('span.tile__name', {}, a.name)
                );
              })
            )
        : h('div.empty', {}, 'No assets in this filter'),
      h('div', { style: { flex: '0 0 auto', height: '1px' } })
    ),

    // ---- carousel rail
    h(
      'div.pane.pane--r',
      { style: { width: '330px', padding: '20px 18px', gap: '13px' } },
      h('span.ov', {}, 'Page Order'),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        h(
          'div',
          {
            class: 'herodrop',
            style: { position: 'relative', aspectRatio: '16/9', borderRadius: '12px', overflow: 'hidden', background: '#111', outline: state.hero ? '2px solid #fff' : '1px solid var(--rule)', outlineOffset: '-2px' },
            // The hero is a drop site too, so setting the key image does not
            // mean switching the grid into HERO mode first.
            onDragover: (e) => {
              if (state.drag?.from !== 'source') return;
              e.preventDefault();
              e.currentTarget.dataset.over = kindOf(state.drag.rel) === 'video' ? 'no' : 'yes';
            },
            onDragleave: (e) => e.currentTarget.removeAttribute('data-over'),
            onDrop: (e) => {
              e.preventDefault();
              e.currentTarget.removeAttribute('data-over');
              const from = state.drag;
              state.drag = null;
              markDragging(false);
              if (from?.from !== 'source') return;
              // Same refusal as clicking: the hero doubles as the work-grid
              // thumbnail, and a video there renders as a broken tile.
              if (kindOf(from.rel) === 'video') {
                toast('The hero must be a still — it is also the work-grid thumbnail', 'error');
                return;
              }
              set({ hero: from.rel, gallery: withoutRel(state.gallery, from.rel) });
            },
          },
          state.hero
            ? [thumb(state.hero, 640, { style: 'width:100%;height:100%;object-fit:cover;display:block' }), h('span.tile__badge', { style: { background: '#fff' } }, 'HERO')]
            : h('div.empty', { style: { fontSize: '9px' } }, 'No hero set')
        ),
        h('span.m', { style: { fontSize: '9.5px', color: 'var(--cw80)' } }, heroName?.output || '—'),
        state.hero && h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.14em' } }, `FROM ${state.hero.split('/').pop().toUpperCase()}`)
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)' } },
        h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, 'THUMB'),
        h(
          'span.m.trunc',
          { style: { fontSize: '9.5px', color: 'var(--cw80)' }, title: 'Always cropped from the hero — 1200x800 for the work grid' },
          thumbName?.output || '—'
        )
      ),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
        h('span.ov', {}, 'Gallery'),
        h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, `${galleryCount(state.gallery)} IN CAROUSEL`)
      ),
      state.gallery.length
        ? h(
            'div.scroll.rows',
            // Marked while a tile is in flight so the seams can show themselves
            // and widen their hit area. Paint and pointer-events only: see the
            // note on .rowgap for why this must never change the layout.
            { 'data-dragging': state.drag !== null ? '1' : '0' },
            // Dropping ON a tile adds it to that row (growing the layout);
            // dropping BETWEEN rows moves it to its own row, so reordering is
            // still possible without changing any arrangement.
            state.gallery
              .flatMap((row, r) => [rowGap(r), railRow(row, r, nameAt)])
              .concat(rowGap(-1))
          )
        : // An empty rail still has to accept the first drop, so the empty state
          // IS the drop site — one element, in normal flow. It used to be an
          // absolutely positioned overlay on top of it, which had no positioned
          // ancestor to size against, so it covered the whole viewport and ate
          // every click in the app the moment a project was opened.
          h(
            'div.railempty',
            {
              onDragover: (e) => {
                if (state.drag === null) return;
                e.preventDefault();
                e.currentTarget.dataset.over = '1';
              },
              onDragleave: (e) => e.currentTarget.removeAttribute('data-over'),
              onDrop: (e) => {
                e.preventDefault();
                e.currentTarget.removeAttribute('data-over');
                const from = state.drag;
                state.drag = null;
                markDragging(false);
                if (from === null) return;
                set(dropPatch(from, { kind: 'gap', at: -1 }));
              },
            },
            h('div.empty', { style: { fontSize: '9px', pointerEvents: 'none' } }, 'Click or drag tiles to build the carousel')
          ),
      h(
        'div',
        { style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '9px', paddingTop: '12px', borderTop: '1px solid var(--rule)' } },
        h('span.ov', {}, 'Name Base'),
        h('input.field', { id: 'base', value: state.base, onChange: (e) => set({ base: slugify(e.target.value), baseTouched: true }) }),
        h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.1em' } }, 'PROJECT-NAME-TOUR_DESCRIPTION##'),
        h('button.btn', { disabled: !names.length, onClick: () => set({ screen: 'previz' }) }, `PREVIZ ${names.length} ASSETS`)
      )
    )
  );
}

/**
 * Text-only asset list. No thumbnails at all, so it stays instant on a folder of
 * thousands over the NAS — and it shows the folder each asset came from, which
 * the grid has no room for.
 */
function assetList(assets) {
  return h(
    'div.scroll',
    { style: { display: 'flex', flexDirection: 'column' } },
    h(
      'div.lrow.m',
      { style: { fontSize: '8.5px', letterSpacing: '0.22em', color: 'var(--cw45)', borderBottom: '1px solid var(--cw)' } },
      h('span'),
      h('span', {}, 'FILE'),
      h('span', {}, 'FOLDER'),
      h('span', {}, 'TYPE'),
      h('span', {}, 'SIZE')
    ),
    assets.map((a) => {
      const badge = roleOf(a.rel);
      return h(
        'button.lrow',
        { 'data-on': badge ? '1' : '0', 'data-blocked': state.mode === 'hero' && a.kind === 'video' ? '1' : '0', onClick: () => pickAsset(a.rel), title: state.mode === 'hero' && a.kind === 'video' ? a.rel + ' — a video cannot be the hero' : a.rel },
        h('span.lrow__badge.m', {}, badge ? (badge === 'hero' ? 'H' : badge) : ''),
        h('span.trunc.m', { style: { fontSize: '10.5px' } }, a.name),
        h('span.trunc.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.08em' } }, a.dir === '/' ? '—' : a.dir),
        h('span.m.dim', { style: { fontSize: '9px', letterSpacing: '0.14em' } }, a.ext.replace('.', '').toUpperCase()),
        h('span.m.dim', { style: { fontSize: '9px' } }, bytes(a.size))
      );
    })
  );
}

/** Removes one tile, shrinking its row's layout - an empty row disappears. */
function removeTile(rows, ri, si) {
  const next = rows.map((r) => ({ layout: r.layout, items: [...r.items] }));
  next[ri].items.splice(si, 1);
  if (!next[ri].items.length) {
    next.splice(ri, 1);
    return next;
  }
  next[ri].layout = SHRINK[next[ri].layout] || DEFAULT_LAYOUT;
  return next;
}

/**
 * Inserts a tile into a row, growing the layout to make room. A three-up row is
 * as wide as the CMS goes, so a tile dropped on one gets its own row rather
 * than silently falling out of the arrangement.
 */
function insertIntoRow(rows, ri, slot, tile) {
  const next = rows.map((r) => ({ layout: r.layout, items: [...r.items] }));
  const row = next[ri];
  const grown = GROW[layoutOf(row)];
  if (!grown || row.items.length >= slotsFor('three-up')) {
    next.splice(ri + 1, 0, { layout: DEFAULT_LAYOUT, items: [tile] });
    return next;
  }
  row.items.splice(Math.max(0, Math.min(slot, row.items.length)), 0, tile);
  row.layout = grown;
  return next;
}

/**
 * Moves a tile onto a row (splitting it) or into the seam between rows
 * (reordering). Removing the tile first can delete its old row, which shifts
 * every row below it up by one - hence the index fix-ups.
 */
/**
 * Takes the dragged tile out of wherever it came from and reports where that
 * was, because removing a row shifts every index below it.
 *
 * A drag starts in one of two places now: a tile already in the rail, or an
 * asset in the grid. `fromRow: Infinity` is what says "nothing was removed" —
 * a grid asset that is not in the rail yet shifts nothing.
 */
function liftTile(from, rows = state.gallery) {
  const lift = (row, slot) => {
    const tile = rows[row]?.items[slot];
    if (!tile) return null;
    return {
      tile,
      rows: removeTile(rows, row, slot),
      collapses: rows[row].items.length === 1,
      fromRow: row,
    };
  };

  if (from?.from === 'source') {
    // An asset already in the rail MOVES rather than duplicating — the grid
    // tile and the rail tile are the same picture, and two copies of one image
    // in a gallery is never what the drag meant.
    const found = findRel(rows, from.rel);
    if (found) return lift(found.row, found.slot);
    return {
      tile: { rel: from.rel, description: 'gallery' },
      rows: rows.map((r) => ({ layout: r.layout, items: [...r.items] })),
      collapses: false,
      fromRow: Infinity,
    };
  }
  return lift(from.row, from.slot);
}

/**
 * `rows` defaults to the composer's own rail, which is what every caller in the
 * compose flow means. The CMS gallery editor rearranges a DIFFERENT set of rows
 * with the same rules, and passes them in.
 */
function moveTile(from, target, rows0 = state.gallery) {
  const lifted = liftTile(from, rows0);
  if (!lifted) return rows0;
  const { tile, rows, collapses, fromRow } = lifted;

  if (target.kind === 'gap') {
    let at = target.at < 0 ? rows.length : target.at;
    if (collapses && fromRow < at) at -= 1;
    rows.splice(Math.max(0, Math.min(rows.length, at)), 0, { layout: DEFAULT_LAYOUT, items: [tile] });
    return rows;
  }

  let ri = target.row;
  if (collapses && fromRow < ri) ri -= 1;
  if (ri < 0 || ri >= rows.length) {
    rows.push({ layout: DEFAULT_LAYOUT, items: [tile] });
    return rows;
  }
  return insertIntoRow(rows, ri, target.slot + (target.side === 'right' ? 1 : 0), tile);
}

/**
 * The whole state patch a drop produces. Dragging the hero into the gallery has
 * to clear the hero as well, the same way clicking it does — otherwise the same
 * asset is both the key image and a carousel tile.
 */
function dropPatch(from, target) {
  const patch = { gallery: moveTile(from, target) };
  if (from?.from === 'source' && state.hero === from.rel) patch.hero = null;
  return patch;
}

/** Changes only the layout of one row, leaving its images alone. */
function setLayout(rows, ri, layout) {
  const next = rows.map((r) => ({ layout: r.layout, items: [...r.items] }));
  next[ri].layout = layout;
  return next;
}

/** The layouts a row with this many images can legally use. */
const layoutsForCount = (n) => Object.keys(LAYOUTS).filter((l) => slotsFor(l) === n);

/** Opens the drop seams while a tile is in flight. See the rail container. */
function markDragging(on) {
  const rail = document.querySelector('.rows');
  if (rail) rail.dataset.dragging = on ? '1' : '0';
}

/**
 * The seam between two rows. Dropping here moves the dragged tile to its own
 * row at that position - the reorder half of the tab metaphor.
 * `rowIndex` of -1 means the end of the list.
 */
function rowGap(rowIndex) {
  return h('div.rowgap', {
    onDragover: (e) => {
      if (state.drag === null) return;
      e.preventDefault();
      e.currentTarget.dataset.over = '1';
    },
    onDragleave: (e) => e.currentTarget.removeAttribute('data-over'),
    onDrop: (e) => {
      e.preventDefault();
      e.currentTarget.removeAttribute('data-over');
      const from = state.drag;
      state.drag = null;
      markDragging(false);
      if (from === null) return;
      set(dropPatch(from, { kind: 'gap', at: rowIndex }));
    },
  });
}

function railRow(row, rowIndex, nameAt) {
  const layout = layoutOf(row);
  const spans = spansFor(layout);
  const alts = layoutsForCount(row.items.length);
  const cells = [];

  // Every slot at its true height, so a split shows its short tile sitting on
  // the baseline exactly as the page does, instead of a stretched rectangle
  // that hides which way the picture will be cropped. `k` only bites on the one
  // layout short enough to hit the floor.
  const rawH = spans.map((_, s) => slotHeightRaw(layout, s));
  const stripH = stripHeight(layout);
  const k = stripH / Math.max(...rawH);

  row.items.forEach((it, slot) => {
    const flat = nameAt(rowIndex, slot);
    if (slot > 0) cells.push(divider(rowIndex, layout));
    cells.push(
      h(
        'div.cell',
        {
          style: {
            flexGrow: spans[slot] || 1,
            flexBasis: 0,
            height: Math.round(rawH[slot] * k) + 'px',
            alignSelf: alignEndFor(layout, slot) ? 'flex-end' : 'flex-start',
          },
          draggable: true,
          // Double-click opens Quick Look on THIS cut, so its own marks are
          // what the timeline shows and sets.
          onDblclick: () => openPeek(it.rel, keyOf(it)),
          title:
            (flat?.output || it.rel) +
            (it.cut ? `  ·  ${cutLabel(it.rel, keyOf(it))}` : '') +
            '\n' +
            layoutLabel(layout) +
            ' \u00b7 ' +
            (aspectFor(layout, slot) || '?').replace(/\s/g, '') +
            ' \u00b7 slot ' +
            (slot + 1) +
            ' of ' +
            row.items.length,
          onDragstart: (e) => {
            state.drag = { from: 'rail', row: rowIndex, slot };
            e.dataTransfer.effectAllowed = 'move';
            e.currentTarget.classList.add('dragging');
            // Set directly rather than through render(): re-rendering mid-drag
            // replaces the element being dragged and the browser cancels it.
            markDragging(true);
          },
          onDragenter: (e) => {
            // Chromium fires drop on the inner <img>, and dragend does not
            // always follow a drop, so the mark is cleared on every exit path.
            if (state.drag !== null) e.preventDefault();
          },
          onDragend: (e) => {
            markDragging(false);
            e.currentTarget.classList.remove('dragging');
            document.querySelectorAll('.cell').forEach((n) => n.removeAttribute('data-drop'));
          },
          onDragover: (e) => {
            if (state.drag === null || (state.drag.row === rowIndex && state.drag.slot === slot)) return;
            e.preventDefault();
            // Which half of the tile the pointer is over decides which side the
            // incoming tile lands on - the rectangle preview shows it.
            const box = e.currentTarget.getBoundingClientRect();
            e.currentTarget.dataset.drop = e.clientX - box.left < box.width / 2 ? 'left' : 'right';
          },
          onDragleave: (e) => e.currentTarget.removeAttribute('data-drop'),
          onDrop: (e) => {
            e.preventDefault();
            const side = e.currentTarget.dataset.drop || 'right';
            e.currentTarget.removeAttribute('data-drop');
            const from = state.drag;
            state.drag = null;
            markDragging(false);
            if (from === null) return;
            set(dropPatch(from, { kind: 'cell', row: rowIndex, slot, side }));
          },
        },
        // An <img> is a drag source in its own right, so without this the browser
        // drags the photo instead of the tile and the split never fires.
        thumb(it.rel, 320, { alt: '', draggable: 'false' }, keyOf(it)),
        h('span.cell__num.m', {}, pad2((flat?.n ?? 0) + 1)),
        h('span.cell__span.m', {}, spans[slot] === COLS ? 'FULL' : spans[slot] + '/' + COLS),
        state.trims[keyOf(it)] &&
          h(
            'span.cell__trim.m',
            {
              title: (() => {
                const t = state.trims[keyOf(it)];
                if (t.inFrame === undefined) return 'TRIMMED';
                return `TRIMMED ${timecode(t.inFrame, t.fps)} → ${timecode(t.outFrame, t.fps)} · ${t.outFrame - t.inFrame + 1} FRAMES`;
              })(),
            },
            `${it.cut ? cutLabel(it.rel, keyOf(it)) + ' · ' : ''}TRIM ${(state.trims[keyOf(it)].out - state.trims[keyOf(it)].in).toFixed(1)}S`
          ),
        h(
          'button.cell__x',
          {
            title: 'Remove',
            onClick: (e) => {
              e.stopPropagation();
              // A cut's trim goes with it; the first placement keeps its own,
              // so putting the clip back finds the marks where they were left.
              const trims = { ...state.trims };
              if (it.cut) delete trims[keyOf(it)];
              set({ gallery: removeTile(state.gallery, rowIndex, slot), trims });
            },
          },
          IC.x()
        )
      )
    );
  });

  return h(
    'div.railrow2',
    {
      'data-partial': '0',
      title: layoutLabel(layout) + ' \u2014 ' + row.items.length + ' image' + (row.items.length > 1 ? 's' : ''),
    },
    h('div.railrow2__strip', { style: { height: stripH + 'px' } }, cells, heightGrip(rowIndex, layout)),
    h(
      'div.railrow2__meta.m',
      {},
      h('span', {}, 'ROW ' + pad2(rowIndex + 1)),
      alts.length > 1
        ? // Every layout fills all 12 columns, so there is nothing to "fill" -
          // the only choice a row offers is which of the CMS's arrangements it
          // uses. Clicking cycles through the ones its image count allows.
          h(
            'button.railrow2__fill',
            {
              title:
                layoutLabel(layout) +
                (HEIGHT_ORDER.includes(layout)
                  ? ' - click to cycle the full-width heights, or drag the row\'s bottom edge'
                  : ' - click to cycle the layouts for ' + row.items.length + ' images'),
              onClick: () => {
                const i = alts.indexOf(layout);
                set({ gallery: setLayout(state.gallery, rowIndex, alts[(i + 1) % alts.length]) });
              },
            },
            layoutLabel(layout)
          )
        : h('span.dimmer', {}, layoutLabel(layout))
    )
  );
}

/**
 * The bottom edge of a row, dragged to change its HEIGHT — the horizontal twin
 * of the seam. Same constraint: a free-form height has nowhere to go in the
 * CMS, so it snaps to the heights that exist. Only full width has more than
 * one, so on every other layout the grip is inert and says why rather than
 * disappearing, which would read as a missing feature.
 */
function heightGrip(rowIndex, layout) {
  const at = HEIGHT_ORDER.indexOf(layout);

  return h('div.hgrip', {
    'data-fixed': at < 0 ? '1' : '0',
    title:
      at < 0
        ? layoutLabel(layout) + ' - this layout has only one height'
        : heightLabel(layout) + ' - drag to change height (' + HEIGHT_ORDER.map(heightLabel).join(' / ') + ')',
    onPointerdown: (e) => {
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;

      // Measured from where the drag STARTED, for the same reason the seam is:
      // each change re-renders the rail and detaches these nodes.
      const startH = HEIGHT_STEPS[at];
      let lastAt = at;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}

      const move = (ev) => {
        // Down is taller, so the pixel delta adds — HEIGHT_ORDER runs tallest
        // first, so a taller row is a LOWER index.
        const best = nearestHeightIndex(startH + (ev.clientY - startY));
        if (best === lastAt) return;
        lastAt = best;
        set({ gallery: setLayout(state.gallery, rowIndex, HEIGHT_ORDER[best]) });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
  });
}

// A free-form ratio has nowhere to go in the CMS, so the seam snaps to the
// layouts that exist: dragging right widens the left image 5 -> 6 -> 8 columns,
// which is split-5-7, two-up, split-8-4.
const SEAM_LEFT = SEAM_ORDER.map((l) => spansFor(l)[0]);

function divider(rowIndex, layout) {
  const at = SEAM_ORDER.indexOf(layout);
  const spans = spansFor(layout);

  return h('div.divider', {
    title:
      at < 0
        ? spans.join('/') + ' - this layout has no other ratio'
        : spans[0] + '/' + spans[1] + ' - drag to change ratio (' + SEAM_LEFT.join(' / ') + ' columns)',
    onPointerdown: (e) => {
      if (at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const strip = e.currentTarget.parentElement;
      const colPx = strip.getBoundingClientRect().width / COLS;
      const startX = e.clientX;

      // Measured from where the drag STARTED, never from the current layout:
      // each change re-renders the rail and detaches these nodes, so anything
      // read from them afterwards would be stale.
      const startLeft = SEAM_LEFT[at];
      let lastAt = at;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}

      const move = (ev) => {
        const wanted = startLeft + (ev.clientX - startX) / colPx;
        // Snap to whichever legal ratio is nearest the pointer.
        let best = 0;
        SEAM_LEFT.forEach((left, i) => {
          if (Math.abs(left - wanted) < Math.abs(SEAM_LEFT[best] - wanted)) best = i;
        });
        if (best === lastAt) return;
        lastAt = best;
        set({ gallery: setLayout(state.gallery, rowIndex, SEAM_ORDER[best]) });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
  });
}

// ------------------------------------------------------------- 03 · previz
/** How many tiles come before a row, so a tile can show its reading-order number. */
const rowOffsetOf = (rows, ri) => rows.slice(0, ri).reduce((n, r) => n + r.items.length, 0);


function screenPreviz() {
  const names = plannedNames(state);
  const gallery = names.filter((n) => n.role === 'gallery');
  const hero = names.find((n) => n.role === 'hero');
  const rows = state.gallery;
  // Every layout fills all 12 columns by construction, so a part-row is now
  // impossible - the only thing worth counting is how the rows are arranged.
  const used = rows.reduce((m, r) => m.set(layoutOf(r), (m.get(layoutOf(r)) || 0) + 1), new Map());

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--l.scroll',
      { style: { width: '290px', padding: '26px 24px', gap: '24px' } },
      h('span.ov', {}, 'Grid'),
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '9.5px', lineHeight: 1.65, letterSpacing: '0.06em' } },
        'Clicking a tile adds it as its own row. Drag one onto another row to split them, drag it into the gap between rows to pull it back out, drag the seam to change the ratio, or click a row\u2019s layout name to cycle it.'
      ),
      h(
        'div',
        {},
        Object.keys(LAYOUTS).map((key) =>
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--rule)' } },
            h(
              'span',
              { style: { flex: '0 0 auto', display: 'flex', gap: '2px', width: '104px' } },
              spansFor(key).map((sp) =>
                h('span', {
                  style: {
                    flexGrow: sp,
                    flexBasis: 0,
                    height: '15px',
                    border: '1px solid var(--cw45)',
                    background: used.get(key) ? 'var(--cw14)' : 'none',
                  },
                })
              )
            ),
            h(
              'span.m',
              { style: { fontSize: '9.5px', letterSpacing: '0.12em', color: 'var(--cw80)' } },
              layoutLabel(key) + '  ' + spansFor(key).join('\u00b7')
            )
          )
        )
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
        h('span.ov', {}, 'This page'),
        [
          ['TILES', gallery.length],
          ['ROWS', rows.length],
          ['LAYOUTS', [...used.keys()].length],
          ['GRID', '12 COL / 80PX GAP'],
        ].map(([k, v]) =>
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--rule)' } },
            h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.14em' } }, k),
            h('span.m', { style: { fontSize: '10px' } }, String(v))
          )
        )
      ),
      h('div.grow'),
      h('p.m.dimmer', { style: { margin: 0, fontSize: '9px', lineHeight: 1.7, letterSpacing: '0.1em', textTransform: 'uppercase' } }, 'Geometry only. No type, colour or motion.')
    ),
    h(
      'div.pane.pane--main.scroll',
      { style: { alignItems: 'center', padding: '34px 0 60px', gap: '20px' } },
      h(
        'div',
        { style: { width: '800px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, h('span.ov', {}, 'Layout Previz'), h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, `/WORK/${slugify(state.fields?.slug || state.base).toUpperCase()}`)),
        h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, `${gallery.length} TILES / ${rows.length} ROWS`)
      ),
      h(
        'div.previz',
        {},
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: '4px' } },
          h('span', { style: { fontWeight: 500, fontSize: '26px', letterSpacing: '0.02em' } }, (state.fields?.title || state.project.title).toUpperCase()),
          h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.2em' } }, (state.fields?.tour || '').toUpperCase())
        ),
        hero
          ? h('div.ptile', { style: { height: '300px', borderRadius: '12px' } }, thumb(hero.rel, 1200), h('span.ptile__tag.m', {}, 'HERO / 95% W / 82SVH'))
          : h('div.ptile', { style: { height: '300px', borderRadius: '12px' } }, h('div.empty', {}, 'No hero set')),
        gallery.length
          ? h(
              'div.pgrid',
              {},
              rows.flatMap((row, ri) => {
                const layout = layoutOf(row);
                const spans = spansFor(layout);
                return row.items.map((cell, slot) =>
                  h(
                    'div.ptile',
                    {
                      style: {
                        gridColumn: `span ${spans[slot]}`,
                        // A full-width row uses the page's fixed band height;
                        // every other slot takes the aspect its layout gives it.
                        ...(aspectFor(layout, slot)
                          ? { aspectRatio: aspectFor(layout, slot) }
                          : { height: '150px' }),
                        // The wide-right slots sit on the row's baseline, which
                        // is what split-8-4 and split-5-7 do on the site.
                        alignSelf: alignEndFor(layout, slot) ? 'end' : 'start',
                      },
                    },
                    thumb(cell.rel, 900, { loading: 'lazy' }),
                    h(
                      'span.ptile__tag.m',
                      {},
                      pad2((rowOffsetOf(rows, ri) + slot) + 1) + ' / ' + layoutLabel(layout) + ' / ' + spans[slot] + ' COL'
                    )
                  )
                );
              })
            )
          : h('div.empty', { style: { padding: '40px 0' } }, 'No gallery tiles yet')
      ),
      h(
        'div',
        { style: { width: '800px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h(
          'span.m.dimmer',
          { style: { fontSize: '9px', letterSpacing: '0.16em' } },
          rows.length ? `${rows.length} ROWS \u2014 ${[...used.entries()].map(([k, n]) => `${n}\u00d7 ${layoutLabel(k)}`).join(', ')}` : 'NO GALLERY ROWS'
        ),
        h('button.btn', { onClick: () => set({ screen: 'copy' }) }, 'CONTINUE TO COPY')
      )
    )
  );
}

// --------------------------------------------------------------- 04 · copy
async function loadCopy(rel) {
  try {
    // No doc in the folder: HTTP answers with nulls, Tauri with null outright.
    const res = (await rpc.readCopyDoc(state.project.id, rel)) || { fields: null, blocks: [], validation: null };
    state.copy = res.fields ? res : null;
    // Anything already filled in wins — edits must never be clobbered by a
    // re-read. But `state.fields || res.fields` discarded the WHOLE parse the
    // moment any saved state existed, so a doc that parses better than it did
    // last time silently did nothing. Merge per field instead.
    state.fields = normaliseWriteup(mergeParsed(state.fields, res.fields));
    state.validation = res.validation;
    syncBase();
    set({});
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** True for a field that has nothing worth keeping. */
const isEmptyValue = (v) =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && !v.length);

/**
 * Fills gaps from the parsed doc without touching anything already set. Called
 * on every doc read, so improving the parser fixes existing projects too.
 */
function mergeParsed(saved, parsed) {
  if (!parsed) return saved;
  if (!saved) return parsed;
  const out = { ...saved };
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'writeup') continue;
    if (isEmptyValue(out[k]) && !isEmptyValue(v)) out[k] = v;
  }
  const savedParas = [saved.writeup?.lead, ...(saved.writeup?.body || [])].filter((t) => String(t || '').trim());
  if (!savedParas.length && parsed.writeup) out.writeup = parsed.writeup;
  return out;
}

/**
 * Replaces every field with what the doc says, discarding edits. The merge above
 * cannot fix a value that is present but WRONG — a slug left over from a worse
 * parse, say — so this is the way to start again from the document.
 */
function reloadFromDoc() {
  const parsed = state.copy?.fields;
  if (!parsed) return toast('No copy doc parsed for this project', 'error');
  state.fields = normaliseWriteup(JSON.parse(JSON.stringify(parsed)));
  state.baseTouched = false;
  syncBase();
  revalidate();
  toast('Fields reloaded from the copy doc');
}

/**
 * The convention is `project-name-tour_description##`, so the tour belongs in
 * the base — but only until someone types their own base, after which we leave
 * it alone.
 */
function syncBase() {
  if (state.baseTouched || !state.project) return;
  const tour = slugify(state.fields?.tour || '');
  state.base = tour ? `${state.project.slug}-${tour}` : state.project.slug;
}

const setField = (k, v) => {
  state.fields = { ...(state.fields || {}), [k]: v };
  if (k === 'tour') syncBase();
  revalidate();
};

async function revalidate() {
  persist();
  try {
    state.validation = await rpc.validateFields(state.fields || {});
  } catch {}
  render();
}

function screenCopy() {
  const f = state.fields || {};
  const tax = state.status?.taxonomy || [];
  const v = state.validation;

  // Step 04 deliberately mirrors the Payload admin form: same fields, same
  // order, same helper text — so whoever fills this in recognises the CMS they
  // are filling in, and nothing silently exists in one and not the other. The
  // gallery is the one exception: it is built on steps 02/03 instead.
  const fieldLabel = (label, required) =>
    h(
      'span.ov',
      { style: { fontSize: '8.5px', letterSpacing: '0.22em' } },
      label,
      required ? h('span', { style: { color: '#ff9b9b', paddingLeft: '4px' } }, '*') : null
    );

  const desc = (text) =>
    text
      ? h(
          'span.m.dimmer',
          { style: { fontSize: '8.5px', letterSpacing: '0.06em', lineHeight: 1.6 } },
          text
        )
      : null;

  const textField = (label, key, opts = {}) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
      fieldLabel(label, opts.required),
      opts.area
        ? h('textarea.field', { rows: opts.rows || 3, value: f[key] || '', onChange: (e) => setField(key, e.target.value) })
        : h('input.field', { value: f[key] || '', onChange: (e) => setField(key, e.target.value) }),
      desc(opts.desc)
    );

  const checkField = (label, key, description) =>
    h(
      'label.check',
      { style: { alignItems: 'center' } },
      h('input', {
        type: 'checkbox',
        checked: f[key] === true || undefined,
        onChange: (e) => setField(key, e.target.checked),
      }),
      h(
        'span',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        fieldLabel(label),
        desc(description)
      )
    );

  // The only <select> on this form. `h()` sets everything with setAttribute, and
  // a <select> has no `value` attribute — the same trap the <textarea> note in
  // h() describes — so the current choice is carried by `selected` on the option.
  const selectField = (label, key, options, opts = {}) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
      fieldLabel(label, opts.required),
      h(
        'select.field',
        { onChange: (e) => setField(key, e.target.value) },
        options.map(([value, text]) =>
          h('option', { value, selected: (f[key] || '') === value || undefined }, text)
        )
      ),
      desc(opts.desc)
    );

  // The key image is not typed here — it is the hero picked on step 02. Showing
  // it keeps the form honest about what will actually publish, since `image` is
  // required by the collection and there is nowhere else on this screen to see it.
  // No asset folder means no planned output names; the CMS branch below never
  // reads this, but it must not throw on the way past.
  const heroName = state.cmsDoc ? null : plannedNames(state).find((n) => n.role === 'hero');
  const imageField = () =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
      fieldLabel('Image', true),
      // A page opened from the CMS already HAS a key image, and this form has no
      // way to change it -- swapping the hero is a compose-side job. Show what is
      // on the document instead of the "no hero picked" alarm, which would be
      // both wrong and unactionable here.
      state.cmsDoc
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '14px', border: '1px solid var(--rule)', padding: '10px' } },
            state.cmsDoc.keyImageUrl
              ? h('span', { style: { flex: '0 0 auto', width: '96px', height: '64px', overflow: 'hidden' } },
                  h('img', { src: state.cmsDoc.keyImageUrl, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }))
              : null,
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 } },
              h('span.m.trunc', { style: { fontSize: '10px' } }, 'The key image already on the page'),
              h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.12em' } }, 'UNCHANGED BY THIS EDIT')
            )
          )
        : state.hero
        ? h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: '14px',
                border: '1px solid var(--rule)', padding: '10px',
              },
            },
            h('span', { style: { flex: '0 0 auto', width: '96px', height: '64px', overflow: 'hidden' } }, thumb(state.hero, 320, { alt: '' })),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 } },
              h('span.m.trunc', { style: { fontSize: '10px' } }, heroName?.output || state.hero),
              h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.12em' } }, `FROM ${state.hero.toUpperCase()}`)
            ),
            h('div.grow'),
            h('button.chip', { type: 'button', onClick: () => set({ screen: 'compose' }) }, 'CHANGE')
          )
        : h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', border: '1px solid #ff9b9b', padding: '12px' } },
            h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.12em', color: '#ffb4b4' } }, 'NO HERO PICKED — PUBLISH WILL BE REFUSED'),
            h('div.grow'),
            h('button.chip', { type: 'button', onClick: () => set({ screen: 'compose' }) }, 'PICK ONE')
          ),
      desc('Key image \u2014 used as both the work-list thumbnail and the project hero.')
    );

  return h(
    'div.screen',
    {},
    // A page opened from the CMS has no copy doc behind it -- the document IS the
    // source. The left pane shows what was loaded and what has been touched
    // instead of a parser report there is nothing to report on.
    state.cmsDoc
    ? h(
      'div.pane.pane--l.scroll',
      { style: { width: '600px', padding: '28px 30px', gap: '18px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
        h('span.ov', {}, 'Live Page'),
        h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.14em' } }, (state.cmsDoc.code || '').toUpperCase())
      ),
      h(
        'div',
        { style: { border: '1px solid var(--rule)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('p.m.dimmer', { style: { margin: 0, fontSize: '9.5px', lineHeight: 1.7, letterSpacing: '0.08em' } },
          'Loaded from the CMS. Change anything below and step 05 writes back only the fields you touched \u2014 the gallery, the key image and the running order are left alone.'),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          // Images are not fields, so they do not go through the step 05 diff --
          // the gallery editor writes its own partial update. Same document,
          // different errand, so it is reachable from here rather than only from
          // the work-page screen.
          h('button.chip', { type: 'button', onClick: () => openCmsGallery(state.cmsDoc.id) }, 'EDIT GALLERY & IMAGES'),
          state.cmsDoc.url
            ? h('button.chip', { type: 'button', onClick: () => openExternal(state.cmsDoc.url) }, 'VIEW THE PAGE')
            : null
        )
      ),
      state.cmsDoc.writeupDropped > 0
        ? h(
            'div',
            { style: { border: '1px solid #ff9b9b', padding: '13px 15px' } },
            h('p.m', { style: { margin: 0, fontSize: '9px', letterSpacing: '0.12em', lineHeight: 1.7, color: '#ff9b9b' } },
              `THE WRITE-UP HOLDS ${state.cmsDoc.writeupDropped} INLINE IMAGE${state.cmsDoc.writeupDropped === 1 ? '' : 'S'} OR CLIP${state.cmsDoc.writeupDropped === 1 ? '' : 'S'} THAT THIS TEXT EDITOR CANNOT SHOW. THEY ARE STILL ON THE PAGE. EDIT THE WRITE-UP AND THEY GO \u2014 LEAVE IT ALONE AND THEY STAY.`)
          )
        : null,
      h(
        'div',
        {},
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '128px 1fr', gap: '14px', padding: '0 0 8px', borderBottom: '1px solid var(--cw)' } },
          h('span.m.dim', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'FIELD'),
          h('span.m.dim', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'STATE')
        ),
        (() => {
          const changed = cmsChangedKeys();
          return changed.length
            ? changed.map((k) =>
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: '128px 1fr', gap: '14px', padding: '11px 0', borderBottom: '1px solid var(--rule)' } },
                  h('span.m', { style: { fontSize: '8.5px', letterSpacing: '0.16em', color: 'var(--cw)' } }, k),
                  h('span.m', { style: { fontSize: '10.5px', color: 'var(--cw80)' } }, 'changed')
                )
              )
            : h('span.m.dimmer', { style: { display: 'block', padding: '14px 0', fontSize: '9.5px', letterSpacing: '0.16em' } }, 'NOTHING CHANGED YET');
        })()
      )
    )
    : h(
      'div.pane.pane--l.scroll',
      { style: { width: '600px', padding: '28px 30px', gap: '18px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
        h('span.ov', {}, 'Source Doc'),
        h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.14em' } }, state.project.folder.toUpperCase())
      ),
      state.project.docs.length
        ? h(
            'select.field',
            { onChange: (e) => loadCopy(e.target.value) },
            state.project.docs.map((d) => h('option', { value: d.rel, selected: state.copy?.rel === d.rel }, d.rel))
          )
        : h(
            'div',
            { style: { border: '1px solid var(--rule)', padding: '14px' } },
            h('p.m.dimmer', { style: { margin: 0, fontSize: '9.5px', lineHeight: 1.7, letterSpacing: '0.08em' } }, 'No .docx or .md found. Export the Google Doc into the project folder and reopen the project — headings drive the field mapping.')
          ),
      state.copy?.blocks?.length
        ? h(
            'div',
            {},
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '128px 1fr', gap: '14px', padding: '0 0 8px', borderBottom: '1px solid var(--cw)' } },
              h('span.m.dim', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'MAPS TO'),
              h('span.m.dim', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'DOCUMENT')
            ),
            state.copy.blocks.map((b) =>
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '128px 1fr', gap: '14px', padding: '11px 0', borderBottom: '1px solid var(--rule)', alignItems: 'start' } },
                h('span.m', { style: { fontSize: '8.5px', letterSpacing: '0.16em', paddingTop: '3px', color: b.tag ? 'var(--cw45)' : 'rgba(217,225,234,0.18)' } }, b.tag || 'unmapped'),
                h('span.m', { style: { fontSize: '10.5px', lineHeight: 1.75, color: b.type === 'heading' ? 'var(--cw)' : 'var(--cw80)', letterSpacing: b.type === 'heading' ? '0.08em' : '0.02em' } }, b.text)
              )
            )
          )
        : null
    ),
    h(
      'div.pane.pane--main.scroll',
      { style: { padding: '28px 34px', gap: '18px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, h('span.ov', {}, 'Payload Fields'), h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.14em' } }, 'EDIT ANYTHING THE PARSER GOT WRONG')),
        state.copy?.fields
          ? h(
              'button.chip',
              {
                type: 'button',
                title: 'Replace every field with what the copy doc says, discarding edits',
                onClick: reloadFromDoc,
              },
              'RELOAD FROM DOC'
            )
          : null,
        v &&
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', border: `1px solid ${v.ok ? 'var(--cw)' : 'var(--cw45)'}`, padding: '6px 12px 5px' } },
            v.ok ? IC.check() : null,
            h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.16em', color: v.ok ? 'var(--cw)' : 'var(--cw45)' } }, v.ok ? `${v.required} / ${v.required} REQUIRED` : `MISSING ${v.missing.join(', ').toUpperCase()}`)
          )
      ),
      textField('Title', 'title', { required: true }),
      textField('Tour', 'tour', { desc: 'Secondary line under the title, e.g. WORLD TOUR' }),
      imageField(),
      textField('Year', 'year', { required: true }),
      textField('Collaborator', 'collaborator', {
        desc: 'Partner name only, e.g. PHNTM \u2014 the site adds the "ALL OF IT NOW X" prefix automatically. Leave empty for solo AOIN work.',
      }),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        fieldLabel('Capabilities', true),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          tax.map((t) =>
            h(
              'button.chip',
              {
                type: 'button',
                'aria-pressed': String((f.capabilities || []).includes(t)),
                onClick: () => {
                  const cur = f.capabilities || [];
                  setField('capabilities', cur.includes(t) ? cur.filter((c) => c !== t) : [...cur, t]);
                },
              },
              t
            )
          )
        ),
        desc('Indexing only \u2014 drives the work-grid filters, tile tags, and list chips. Not shown on the project page (see services).')
      ),
      (() => {
        // `services` is what actually prints in the project page's meta block,
        // while `capabilities` above only drives the work-grid filters. It is a
        // relationship to an editable collection, so the options come from the
        // CMS rather than a constant here — and stay labels until publish,
        // which is the only place that knows the ids.
        const all = state.status?.services || [];
        const chosen = f.services || [];
        const q = (state.serviceFilter || '').trim().toLowerCase();
        const shown = q ? all.filter((sv) => sv.label.toLowerCase().includes(q)) : all;
        const toggle = (label) =>
          setField('services', chosen.includes(label) ? chosen.filter((c) => c !== label) : [...chosen, label]);

        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' } },
            fieldLabel('Services'),
            h(
              'span.m.dimmer',
              { style: { fontSize: '8.5px', letterSpacing: '0.14em' } },
              all.length ? `${chosen.length} OF ${all.length} SELECTED` : 'CMS UNREACHABLE — LIST UNAVAILABLE'
            )
          ),
          all.length > 12
            ? h('input.field', {
                id: 'service-filter',
                placeholder: 'Filter services',
                value: state.serviceFilter || '',
                onInput: (e) => {
                  state.serviceFilter = e.target.value;
                  render();
                },
              })
            : null,
          h(
            'div',
            {
              style: {
                display: 'flex', gap: '6px', flexWrap: 'wrap',
                maxHeight: '132px', overflowY: 'auto',
                padding: all.length ? '2px 0' : '0',
              },
            },
            shown.map((sv) =>
              h(
                'button.chip',
                {
                  type: 'button',
                  'aria-pressed': String(chosen.includes(sv.label)),
                  onClick: () => toggle(sv.label),
                },
                sv.label
              )
            )
          ),
          // A doc can name a service the CMS has never heard of. Say so here
          // rather than dropping it silently at publish.
          desc(
            'Shown in the project-page meta block. Pick from the Services list — to add a category, create it in the CMS first. (The capabilities field and the /services page stay fixed at the original four.)'
          ),
          chosen.filter((c) => all.length && !all.some((sv) => sv.label.toLowerCase() === c.toLowerCase())).length
            ? h(
                'span.m',
                { style: { fontSize: '8.5px', letterSpacing: '0.1em', color: '#ffb4b4', lineHeight: 1.6 } },
                `NOT IN THE CMS LIST, WILL BE SKIPPED: ${chosen
                  .filter((c) => !all.some((sv) => sv.label.toLowerCase() === c.toLowerCase()))
                  .join(', ')
                  .toUpperCase()}`
              )
            : null
        );
      })(),
      textField('Summary', 'summary', { area: true, rows: 2, desc: 'Short lede beside the meta block.' }),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' } },
        pairEditor('Stats', f.stats || [], ['label', 'value'], (rows) => setField('stats', rows)),
        groupEditor(f.credits || [], (rows) => setField('credits', rows))
      ),
      writeupField(f),
      // Payload keeps these in the sidebar rather than the main column, so they
      // sit apart here too. `code` is derived by the collection and `order` is
      // assigned on publish, which is why neither is editable.
      h(
        'div',
        {
          style: {
            display: 'flex', flexDirection: 'column', gap: '14px',
            paddingTop: '16px', borderTop: '1px solid var(--rule)',
          },
        },
        h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em', color: 'var(--cw45)' } }, 'Sidebar'),
        textField('Slug', 'slug', { required: true, desc: 'The /work/ URL. Must be unique across the whole site.' }),
        // Left blank, this changes nothing: a new project publishes live, and an
        // existing one keeps whatever the CMS already holds. Only an explicit
        // pick is sent — the form is built from the asset folder, never from the
        // document, so a default here would silently overwrite the real visibility.
        selectField(
          'Visibility',
          'visibility',
          [
            // Editing a live page, the stored value is right there in the form,
            // so "as stored" has nothing to mean — and the CMS refuses an empty pick.
            ...(state.cmsDoc ? [] : [['', 'AS STORED — publish new, keep existing']]),
            ['published', 'PUBLISHED — live and listed on the work page'],
            ['unlisted', 'UNLISTED — page builds, nothing links to it'],
            ['archive', 'ARCHIVE — no page at all, CMS only'],
          ],
          { desc: 'Unlisted builds the /work/ page and leaves the URL working, but keeps it out of the work grid, the home marquee and prev/next — for a link you hand out directly.' }
        ),
        checkField('Featured', 'featured', 'Puts the project on the home page as well as the work grid.'),
        // The order only means anything once it is featured, so it only appears
        // then — a number sitting under an unticked box invites filling in.
        f.featured === true
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
              fieldLabel('Featured order'),
              h('input.field', {
                type: 'number',
                min: '1',
                value: f.featuredOrder ?? '',
                onChange: (e) => setField('featuredOrder', e.target.value === '' ? null : Number(e.target.value)),
              }),
              desc('Position among the featured projects. Leave blank to let the CMS decide.')
            )
          : null
      ),
      h('div.grow'),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', paddingTop: '16px', borderTop: '1px solid var(--rule)' } },
        h(
          'span.m.dimmer',
          { style: { fontSize: '9px', letterSpacing: '0.14em' } },
          state.cmsDoc ? 'ONLY WHAT YOU CHANGE GETS WRITTEN' : 'ORDER IS ASSIGNED ON PUBLISH'
        ),
        h('button.btn', { onClick: () => set({ screen: 'export' }) }, state.cmsDoc ? 'REVIEW CHANGES' : 'CONTINUE TO EXPORT')
      )
    )
  );
}

/**
 * `writeup` is one Slate rich-text field on the collection, not the old
 * lead-plus-body pair, so it is edited here as a plain list of paragraphs and
 * published as one node each. Any lead left over from a doc parsed under the
 * old shape is folded in as the first paragraph by normaliseWriteup().
 */
function writeupField(f) {
  const paras = f.writeup?.body || [];
  const write = (body) => setField('writeup', { ...(f.writeup || {}), lead: '', body });

  return h(
    'div.copydrop',
    {
      style: { display: 'flex', flexDirection: 'column', gap: '7px' },
      // Only a file drag lights this up: dragging a gallery tile across the form
      // must not look like it can be dropped into the prose.
      onDragover: (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        e.currentTarget.dataset.over = 'yes';
      },
      onDragleave: (e) => e.currentTarget.removeAttribute('data-over'),
      onDrop: (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.currentTarget.removeAttribute('data-over');
        dropCopyIntoWriteup(e.dataTransfer.files[0]);
      },
    },
    h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'Writeup'),
    paras.map((par, i) =>
      h(
        'div',
        { style: { display: 'flex', gap: '9px', alignItems: 'flex-start' } },
        h('span.m.dimmer', { style: { fontSize: '10px', paddingTop: '11px' } }, pad2(i + 1)),
        h('textarea.field', {
          rows: 3,
          value: par,
          onChange: (e) => {
            const body = [...paras];
            body[i] = e.target.value;
            write(body);
          },
        }),
        h(
          'button.chip',
          { type: 'button', title: 'Remove paragraph', onClick: () => write(paras.filter((_, j) => j !== i)) },
          '\u00d7'
        )
      )
    ),
    h('button.chip', { type: 'button', style: { alignSelf: 'flex-start' }, onClick: () => write([...paras, '']) }, '+ PARAGRAPH'),
    h(
      'span.m.dimmer',
      { style: { fontSize: '8.5px', letterSpacing: '0.06em', lineHeight: 1.6 } },
      'The expandable full write-up (FULL WRITE-UP panel). Formatting from the doc is kept as Markdown — **bold**, *italic*, `code`, <u>underline</u>, [links](url), # headings, > quotes and - lists all publish as rich text. Drop a .md file anywhere on this section to replace the paragraphs below; no other field is touched.'
    )
  );
}

// A `.docx` is a zip, and the parser reads OOXML off the disk rather than out
// of the browser, so only the text formats can come in through a drop. Exporting
// the Google Doc as Markdown is the route in.
const COPY_DROP_RE = /\.(md|markdown|mdown|txt)$/i;

/**
 * A drag carrying files from outside the app, as opposed to a tile being moved
 * around the rail. The rail's own drags set custom types, so this is what keeps
 * the two kinds of drop apart.
 */
const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

/**
 * A copy doc dropped straight onto the write-up. ONLY the write-up is taken,
 * even when the file is a full copy doc with a Title/Year/Capabilities block:
 * this is for amending prose on a page that already exists, and quietly
 * rewriting the fields the page publishes with is the one thing an amendment
 * must not do. A file with no WRITE-UP heading is all write-up, which is what a
 * bare amendment looks like.
 */
async function dropCopyIntoWriteup(file) {
  if (!file) return;
  if (!COPY_DROP_RE.test(file.name)) {
    toast(`${file.name} is not Markdown — export the doc as .md and drop that`, 'error');
    return;
  }
  let parsed;
  try {
    parsed = await rpc.parseCopyText(file.name, await file.text());
  } catch (e) {
    toast(`Could not read ${file.name}: ${e.message}`, 'error');
    return;
  }

  const w = parsed?.fields?.writeup || {};
  let paras = [w.lead, ...(w.body || [])].map((t) => String(t || '').trim()).filter(Boolean);
  if (!paras.length) {
    // No WRITE-UP heading: take the prose, and keep the Markdown twin so bold,
    // links and headings still publish as rich text.
    paras = (parsed?.blocks || [])
      .filter((b) => b.type === 'p' || b.type === 'li')
      .map((b) => String(b.rich || b.text || '').trim())
      .filter(Boolean);
  }
  if (!paras.length) {
    toast(`${file.name} has no copy in it`, 'error');
    return;
  }

  setField('writeup', { lead: '', body: paras });
  toast(`Write-up replaced from ${file.name} — ${paras.length} paragraph${paras.length === 1 ? '' : 's'}`);
}

/** Folds a legacy `writeup.lead` into the paragraph list, once, on load. */
function normaliseWriteup(fields) {
  if (!fields?.writeup) return fields;
  const lead = String(fields.writeup.lead || '').trim();
  if (!lead) return fields;
  return { ...fields, writeup: { lead: '', body: [lead, ...(fields.writeup.body || [])] } };
}

function pairEditor(label, rows, keys, onChange) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
    h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, label),
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', border: '1px solid var(--rule)' } },
      rows.map((r, i) =>
        h(
          'div',
          { style: { display: 'flex', gap: '8px', padding: '6px 9px', borderBottom: '1px solid var(--rule)' } },
          keys.map((k) =>
            h('input.m', {
              value: r[k] || '',
              placeholder: k.toUpperCase(),
              style: { flex: '1 1 0', minWidth: 0, fontSize: '10px', letterSpacing: '0.06em', outline: 'none' },
              onChange: (e) => {
                const next = rows.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row));
                onChange(next);
              },
            })
          ),
          h('button.railrow__x', { onClick: () => onChange(rows.filter((_, j) => j !== i)) }, IC.x())
        )
      ),
      h('button.chip', { style: { border: 0 }, onClick: () => onChange([...rows, Object.fromEntries(keys.map((k) => [k, '']))]) }, '+ ROW')
    )
  );
}

function groupEditor(groups, onChange) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
    h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'Credits'),
    h(
      'span.m.dimmer',
      { style: { fontSize: '8.5px', letterSpacing: '0.06em', lineHeight: 1.6 } },
      'Credit groups, e.g. ALL OF IT NOW / COLLABORATORS. Each row displays TITLE | NAME; the name links to the social URL.'
    ),
    groups.map((g, gi) =>
      h(
        'div',
        { style: { border: '1px solid var(--rule)', marginBottom: '7px' } },
        h(
          'div',
          { style: { display: 'flex', gap: '8px', padding: '7px 9px', borderBottom: '1px solid var(--rule)' } },
          h('input.m', {
            value: g.title || '',
            placeholder: 'GROUP',
            style: { flex: '1 1 auto', fontSize: '8.5px', letterSpacing: '0.22em', outline: 'none' },
            onChange: (e) => onChange(groups.map((x, j) => (j === gi ? { ...x, title: e.target.value } : x))),
          }),
          h('button.railrow__x', { onClick: () => onChange(groups.filter((_, j) => j !== gi)) }, IC.x())
        ),
        // A credit entry is { title, name, url } — the shape the collection
        // stores and the parser produces. This editor used to read `role` and
        // `handle`, which exist nowhere, so every parsed credit rendered blank
        // and anything typed here was dropped on publish.
        (g.entries || []).map((en, ei) => {
          const edit = (k, v) =>
            onChange(
              groups.map((x, j) =>
                j === gi ? { ...x, entries: x.entries.map((y, k2) => (k2 === ei ? { ...y, [k]: v } : y)) } : x
              )
            );
          const cell = (k, placeholder, flex) =>
            h('input.m', {
              value: en[k] || '',
              placeholder,
              title: placeholder,
              style: { flex, minWidth: 0, fontSize: '10px', letterSpacing: '0.06em', outline: 'none' },
              onChange: (e) => edit(k, e.target.value),
            });
          return h(
            'div',
            { style: { display: 'flex', gap: '8px', padding: '6px 9px', borderBottom: '1px solid var(--rule)' } },
            cell('title', 'ROLE', '1 1 0'),
            cell('name', 'NAME', '1 1 0'),
            cell('url', 'SOCIAL URL', '1 1 0'),
            h('button.railrow__x', { onClick: () => onChange(groups.map((x, j) => (j === gi ? { ...x, entries: x.entries.filter((_, k2) => k2 !== ei) } : x))) }, IC.x())
          );
        }),
        h('button.chip', { style: { border: 0 }, onClick: () => onChange(groups.map((x, j) => (j === gi ? { ...x, entries: [...(x.entries || []), { title: '', name: '', url: '' }] } : x))) }, '+ CREDIT')
      )
    ),
    h('button.chip', { style: { alignSelf: 'flex-start' }, onClick: () => onChange([...groups, { title: 'ALL OF IT NOW', entries: [] }]) }, '+ GROUP')
  );
}

// ------------------------------------------------------------- 05 · export
async function runCompose() {
  const items = selectedItems(state);
  if (!items.length) return toast('Nothing selected', 'error');
  try {
    const started = await rpc.startCompose({
      projectId: state.project.id,
      base: state.base,
      items,
      outDir: state.outDir,
    });
    const outDir = started.outDir;
    const job = started.jobId || 'tauri';
    set({ job, jobSteps: started.steps || [], jobLog: [], manifestPath: null, publishResult: null });

    let stop = () => {};
    stop = onComposeProgress(job, (evt) => {
      if (evt.type === 'snapshot') Object.assign(state, { jobSteps: evt.steps, jobLog: evt.log || [] });
      else if (evt.type === 'step') state.jobSteps[evt.index] = evt.step;
      else if (evt.type === 'log') state.jobLog = [...state.jobLog, evt.message];
      else if (evt.type === 'done') {
        state.jobSteps = evt.steps;
        state.manifestPath = evt.manifestPath;
        stop();
        const failed = evt.steps.filter((s) => s.status === 'failed').length;
        toast(
          failed ? `${failed} of ${evt.steps.length} failed` : `Composed ${evt.steps.length} assets into ${outDir}`,
          failed ? 'error' : 'ok'
        );
      } else if (evt.type === 'error') {
        stop();
        toast(evt.message, 'error');
      }
      render();
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function runPublish() {
  if (!state.status?.payload?.credentials) {
    openLogin('Publishing needs a CMS login. Sign in and the publish will continue.');
    return;
  }
  set({ publishing: true });
  // Uploading a tour's worth of video takes minutes, and this reported nothing
  // at all until it finished — so a stall looked exactly like a hang. The step
  // is shown live where the backend can send it, and the elapsed clock runs
  // either way, which is what tells "working" from "stopped".
  startLoading('PUBLISHING TO THE CMS', state.status?.payload?.url || '');
  const stopProgress = onPublishProgress((p) => {
    if (state.loading && p?.message) {
      state.loading.detail = p.message;
      touchLoader();
    }
  });
  const finish = () => {
    stopProgress();
    stopLoading();
  };
  try {
    const res = await rpc.publish({ fields: state.fields, manifestPath: state.manifestPath });
    finish();
    set({ publishing: false, publishResult: res });
    // The toast only exists while this window is in front, and a publish runs
    // long enough that nobody watches it land.
    const summary = `${res.slug} — ${res.mediaCount} media — publish the site to go live`;
    toast(`Published ${summary}`);
    notify('Published to the CMS', summary);
  } catch (err) {
    finish();
    set({ publishing: false });
    toast(err.message, 'error');
    // A failure you walked away from is worth knowing about just as much.
    notify('Publish failed', err.message);
  }
}

/**
 * Step 05 for a page opened FROM the CMS. There is no manifest and nothing to
 * compose, so the whole compose report is replaced by the one thing that matters
 * here: exactly which fields differ from what was loaded, and a button to write
 * those and only those back.
 */
function screenCmsSave() {
  const v = state.validation;
  const changed = cmsChangedKeys();
  const doc = state.cmsDoc;
  // The write-up cannot carry inline media through the text conversion, so
  // editing it is the one change that can lose something. Only warn when that is
  // actually in play: the page has such blocks AND the write-up was touched.
  const willDropMedia = changed.includes('writeup') && (doc?.writeupDropped || 0) > 0;
  const canSave = changed.length > 0 && v?.ok && !state.publishing;

  const row = (label, value) =>
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '9px 0', borderBottom: '1px solid var(--rule)' } },
      h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.18em' } }, label),
      h('span.m', { style: { fontSize: '10px', letterSpacing: '0.08em', textAlign: 'right' } }, value)
    );

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.scroll',
      { style: { padding: '32px 36px', gap: '20px' } },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('span.ov', {}, 'Step 05'),
        h('h1', { style: { margin: 0, fontWeight: 500, fontSize: '40px', lineHeight: 1 } }, 'Save changes')
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', paddingTop: '20px' } },
        row('PROJECT', state.fields?.title || ''),
        row('CODE', doc?.code || '—'),
        row('URL', `/work/${state.fields?.slug || ''}`),
        row('VISIBILITY', (state.fields?.visibility || 'published').toUpperCase())
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '11px', paddingTop: '26px' } },
        h('span.ov', { style: { fontSize: '8.5px', letterSpacing: '0.22em' } }, 'Fields that changed'),
        changed.length
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
              changed.map((k) => h('span.chip', { 'aria-pressed': 'true' }, k.toUpperCase()))
            )
          : h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, 'NOTHING CHANGED YET — EDIT ON STEP 04'),
        h(
          'span.m.dimmer',
          { style: { fontSize: '8.5px', letterSpacing: '0.06em', lineHeight: 1.6 } },
          'Only these are written. Every other field on the document is left exactly as it is — including the gallery, the key image and the running order.'
        )
      ),
      willDropMedia
        ? h(
            'div',
            { style: { display: 'flex', gap: '11px', border: '1px solid #ff9b9b', padding: '13px 15px', marginTop: '22px' } },
            h(
              'span.m',
              { style: { fontSize: '9px', letterSpacing: '0.12em', lineHeight: 1.7, color: '#ff9b9b' } },
              `THIS WRITE-UP HAS ${doc.writeupDropped} INLINE IMAGE${doc.writeupDropped === 1 ? '' : 'S'} OR CLIP${doc.writeupDropped === 1 ? '' : 'S'} THAT THE TEXT EDITOR CANNOT HOLD. SAVING THE WRITE-UP WILL REMOVE ${doc.writeupDropped === 1 ? 'IT' : 'THEM'}. LEAVE THE WRITE-UP ALONE AND ${doc.writeupDropped === 1 ? 'IT SURVIVES' : 'THEY SURVIVE'} UNTOUCHED.`
            )
          )
        : null
    ),
    h(
      'div.pane.pane--r.scroll',
      { style: { width: '370px', padding: '32px 28px', gap: '22px' } },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '13px' } },
        h('span.ov', {}, 'Write back'),
        h(
          'span.m.dimmer',
          { style: { fontSize: '8.5px', letterSpacing: '0.18em' } },
          !v?.ok ? `COPY INCOMPLETE — MISSING ${(v?.missing || []).join(', ').toUpperCase()}` : !changed.length ? 'NOTHING TO SAVE' : state.status?.payload?.credentials ? `READY — ${changed.length} FIELD${changed.length === 1 ? '' : 'S'}` : 'READY — WILL ASK YOU TO SIGN IN'
        ),
        h('button.btn', { disabled: !canSave || undefined, onClick: runCmsSave }, state.publishing ? 'SAVING…' : 'SAVE TO THE CMS'),
        h('button.btn.btn--ghost', { type: 'button', onClick: () => openCmsGallery(doc.id) }, 'EDIT GALLERY & IMAGES'),
        doc?.url
          ? h('button.btn.btn--ghost', { type: 'button', onClick: () => openExternal(doc.url) }, 'VIEW THE PAGE')
          : null,
        state.publishResult
          ? h(
              'span.m.dimmer',
              { style: { fontSize: '8.5px', letterSpacing: '0.14em', lineHeight: 1.7, paddingTop: '10px', borderTop: '1px solid var(--rule)' } },
              `SAVED ${(state.publishResult.fields || []).join(', ').toUpperCase()} — LIVE AFTER THE NEXT SITE PUBLISH`
            )
          : null,
        sitePublishPanel(state.publishing ? 'the save is still being written' : changed.length ? 'save to the CMS first, or the publish will not have it' : '')
      )
    )
  );
}

function screenExport() {
  // A page opened from the CMS has no compose job behind it.
  if (state.cmsDoc) return screenCmsSave();
  const steps = state.jobSteps.length ? state.jobSteps : plannedNames(state).map((n) => ({ ...n, status: 'queued', bytesOut: 0, sourceName: n.asset?.name, bytesIn: n.asset?.size || 0, kind: n.asset?.kind }));
  const done = steps.filter((s) => s.status === 'done').length;
  const failed = steps.filter((s) => s.status === 'failed');
  const running = state.job && !state.manifestPath;
  const totalIn = steps.reduce((a, s) => a + (s.bytesIn || 0), 0);
  const totalOut = steps.reduce((a, s) => a + (s.bytesOut || 0), 0);
  const v = state.validation;
  // Not being signed in no longer blocks the button: it raises the sign-in
  // modal instead, which is far less of a dead end than a disabled control.
  const canPublish = state.manifestPath && !failed.length && v?.ok;

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.scroll',
      { style: { padding: '32px 36px', gap: '20px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, h('span.ov', {}, 'Step 05'), h('h1', { style: { margin: 0, fontWeight: 500, fontSize: '40px', lineHeight: 1 } }, 'Compose')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px', alignItems: 'flex-end' } },
          h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.2em' } }, 'WRITING INTO'),
          h('input.field.m', {
            value: state.outDir,
            placeholder: state.project.folder + '\\  (project root)',
            style: { width: '320px', textAlign: 'right', fontSize: '9.5px' },
            onChange: (e) => set({ outDir: e.target.value.replace(/^[\\/]+/, '') }),
          })
        )
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        h('div.track', {}, h('i', { style: { width: `${steps.length ? (done / steps.length) * 100 : 0}%` } })),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between' } },
          h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, running ? `CONVERTING ${done + 1} OF ${steps.length}` : state.manifestPath ? `${done} OF ${steps.length} COMPOSED` : `${steps.length} QUEUED`),
          h('span.m.dimmer', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, totalOut ? `${bytes(totalIn)} → ${bytes(totalOut)}` : bytes(totalIn))
        )
      ),
      h(
        'div',
        {},
        h(
          'div.xrow.m',
          { style: { fontSize: '8.5px', letterSpacing: '0.22em', color: 'var(--cw45)', borderBottom: '1px solid var(--cw)' } },
          h('span'),
          h('span', {}, 'SOURCE'),
          h('span'),
          h('span', {}, 'OUTPUT'),
          h('span', {}, 'TYPE'),
          h('span', {}, 'SIZE'),
          h('span', {}, 'TRIM'),
          h('span', {}, 'STATUS')
        ),
        steps.map((s) =>
          h(
            'div.xrow',
            { 'data-status': s.status, title: s.message || '' },
            h('span.dimmer', {}, s.role === 'hero' ? 'H' : s.role === 'thumb' ? 'T' : pad2(steps.filter((x) => x.role === 'gallery').indexOf(s) + 1)),
            h('span.trunc.dim', {}, s.sourceName || s.rel),
            h('span.dimmer', {}, '→'),
            h('span.trunc', {}, s.output),
            h('span.dim', {}, s.kind === 'video' ? 'MP4' : 'WEBP'),
            h('span.dim', {}, s.bytesOut ? `${bytes(s.bytesIn)} → ${bytes(s.bytesOut)}` : bytes(s.bytesIn || 0)),
            // What the encoder is told, straight from the same trims the plan
            // sends — so a clip that reads WHOLE here goes out whole.
            h('span.trunc', { style: { color: trimText(s.trim) ? 'var(--cw)' : undefined }, title: trimText(s.trim) ? 'Trimmed in Quick Look — the encode starts and stops here' : '' }, s.kind === 'video' ? trimText(s.trim) || 'WHOLE' : ''),
            h('span.xstatus', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, s.status === 'done' ? IC.check() : null, s.status.toUpperCase())
          )
        )
      ),
      failed.length
        ? h(
            'div',
            { style: { border: '1px solid var(--cw)', padding: '12px 14px' } },
            failed.map((s) => h('div.m', { style: { fontSize: '9.5px', lineHeight: 1.7, letterSpacing: '0.04em' } }, `${s.output} — ${s.message}`))
          )
        : null,
      h('div.grow'),
      state.jobLog.length ? h('div.log', { style: { borderTop: '1px solid var(--rule)', paddingTop: '14px' } }, state.jobLog.map((l) => h('div', {}, l))) : null
    ),
    h(
      'div.pane.pane--r.scroll',
      { style: { width: '370px', padding: '32px 28px', gap: '22px' } },
      h('span.ov', {}, 'Summary'),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '18px' } },
        [
          ['ASSETS', steps.length],
          ['SAVED', totalOut ? Math.round((1 - totalOut / totalIn) * 100) + '%' : '—'],
          ['STILLS', steps.filter((s) => s.kind !== 'video').length],
          ['VIDEO', steps.filter((s) => s.kind === 'video').length],
        ].map(([k, val]) =>
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('span.m.dimmer', { style: { fontSize: '8px', letterSpacing: '0.22em' } }, k),
            h('span.m', { style: { fontSize: '26px', letterSpacing: '0.04em' } }, String(val))
          )
        )
      ),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px', paddingTop: '18px', borderTop: '1px solid var(--rule)' } },
        h('span.ov', {}, 'Recipe'),
        [
          ['STILLS', `WEBP Q${state.status?.recipe?.gallery?.quality ?? 82} / ${state.status?.recipe?.gallery?.maxWidth ?? 2560} MAX`],
          ['THUMB', `WEBP Q${state.status?.recipe?.thumb?.quality ?? 80} / ${state.status?.recipe?.thumb?.width ?? 1200}x${state.status?.recipe?.thumb?.height ?? 800}`],
          ['VIDEO', state.status?.ffmpeg?.ok ? `H264 CRF${state.status?.recipe?.video?.crf ?? 23} / ${state.status?.recipe?.video?.maxWidth ?? 1920}` : 'FFMPEG NOT FOUND'],
          ['ORIGINALS', 'KEPT'],
        ].map(([k, val]) =>
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--rule)' } },
            h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.14em' } }, k),
            h('span.m.trunc', { style: { fontSize: '9.5px', letterSpacing: '0.06em' } }, val)
          )
        )
      ),
      h('button.btn', { disabled: Boolean(running), onClick: runCompose }, running ? 'COMPOSING…' : state.manifestPath ? 'RE-COMPOSE' : `COMPOSE ${steps.length} ASSETS`),
      h('div.grow'),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '13px', paddingTop: '20px', borderTop: '1px solid var(--cw)', opacity: canPublish ? 1 : 0.45 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
          h('span.ov', { style: { color: 'var(--cw80)' } }, 'Publish'),
          h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.18em' } }, publishGate(canPublish, v, failed))
        ),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: '10px' } },
          h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.14em' } }, 'TARGET'),
          h('span.m.trunc', { style: { fontSize: '9.5px' } }, (state.status?.payload?.url || '').replace(/^https?:\/\//, ''))
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          [`UPLOAD ${steps.length} MEDIA DOCS`, `${state.publishResult ? 'UPDATED' : 'CREATE'} PROJECT / ${slugify(state.fields?.slug || state.base).toUpperCase()}`, 'LIVE AFTER THE NEXT SITE PUBLISH'].map((label, i) =>
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '9px' } },
              h('span', { style: { width: '6px', height: '6px', background: state.publishResult ? 'var(--cw)' : 'var(--cw35)', flex: '0 0 auto' } }),
              h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.12em', color: state.publishResult ? 'var(--cw80)' : 'var(--cw45)' } }, label)
            )
          )
        ),
        state.publishResult
          ? h(
              'button.m',
              {
                // A plain target=_blank does nothing inside the webview.
                onClick: () => openExternal(state.publishResult.url),
                style: { fontSize: '9.5px', letterSpacing: '0.1em', color: 'var(--cw)', textDecoration: 'underline', textAlign: 'left' },
              },
              state.publishResult.url
            )
          : null,
        h('button.btn', { disabled: !canPublish || state.publishing, onClick: runPublish }, state.publishing ? 'PUBLISHING…' : 'PUBLISH TO STAGING'),
        sitePublishPanel(state.publishing ? 'the project is still being written to the CMS' : '')
      )
    )
  );
}

function publishGate(canPublish, v, failed) {
  if (canPublish) return state.status?.payload?.credentials ? 'READY' : 'READY — WILL ASK YOU TO SIGN IN';
  if (!state.manifestPath) return 'COMPOSE FIRST';
  if (failed.length) return 'FIX FAILURES FIRST';
  if (!v?.ok) return 'COPY INCOMPLETE';
  return 'LOCKED';
}

// ------------------------------------------------------------------ render
// ------------------------------------------------------------- work order
//
// The running order of the WORK page, edited by dragging.
//
// The site follows the `order` field, lowest first, and that outranks
// everything else — year is only consulted to break a tie between two projects
// that happen to share a number. So this is one flat run, and a project can sit
// anywhere in it regardless of when the job was.
//
// The planner below writes as FEW documents as it can rather than simply
// renumbering the run 1..n. It was built when every Payload write ran the
// whole Astro build synchronously (ten rewritten projects was ten builds);
// since 2026-09-07 nothing rebuilds until the site-wide publish, but every
// write is still a version in the document's history, so one drag should
// still cost one write, not twenty.

/**
 * The longest run of positions whose existing `order` values are ALREADY
 * strictly increasing. Everything outside that run has to be rewritten and
 * nothing inside it does, so keeping the longest run is exactly the fewest
 * writes. O(n^2), which is nothing at portfolio size and reads like the
 * definition of the thing.
 */
function longestKeepable(values) {
  const n = values.length;
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * New `order` values for a sequence, and only for the projects that need one. A
 * rewritten value lands strictly between the neighbours that were kept, which
 * is what makes a single drag cost a single write.
 *
 * Whole numbers whenever the gap leaves room for one — these are visible in the
 * CMS sidebar and 14 reads better than 13.5 — and a fraction when a project is
 * genuinely squeezed between two adjacent integers.
 */
function planOrders(seq) {
  // A missing order sorts as 0 on the site (`a.order ?? 0`), so it is treated
  // as 0 here too. Two of them cannot both be kept, and that is correct: a tie
  // has no defined order, so one of the pair has to be written.
  const cur = seq.map((p) => (typeof p.order === 'number' ? p.order : 0));
  const keep = longestKeepable(cur);
  const out = [];
  for (let i = 0; i < seq.length; ) {
    if (keep.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < seq.length && !keep.has(j)) j++;
    const k = j - i;
    // An open end has no bound to divide, so one is invented a whole step away.
    const before = i > 0 ? cur[i - 1] : null;
    const after = j < seq.length ? cur[j] : null;
    const lo = before !== null ? before : after !== null ? after - (k + 1) : 0;
    const hi = after !== null ? after : lo + (k + 1);
    const step = (hi - lo) / (k + 1);
    for (let n = 0; n < k; n++) {
      const raw = lo + step * (n + 1);
      // Rounding is only safe when the values are a whole step or more apart:
      // any closer and two of them could round onto each other, turning the
      // order back into the tie this was supposed to resolve.
      const value = step >= 1 ? Math.round(raw) : Number(raw.toFixed(6));
      if (value !== cur[i + n]) out.push({ id: seq[i + n].id, order: value });
    }
    i = j;
  }
  return out;
}

/** Every `order` write needed to make the CMS agree with `desiredIds`. */
function planReorder(items, desiredIds) {
  const by = new Map(items.map((p) => [p.id, p]));
  return planOrders(desiredIds.map((id) => by.get(id)).filter(Boolean));
}

/**
 * The marquee run: which projects are featured, and in what order.
 *
 * `featuredOrder` is DERIVED from the running order rather than dragged
 * separately -- the featured projects, numbered 1..n in the sequence they
 * already sit in on this screen. Two orders to drag for one screen would be a
 * second mental model for no gain, and the site reads featuredOrder only to sort
 * the featured set, which this satisfies exactly.
 *
 * Returns one entry per project that needs writing, so a project already correct
 * costs nothing -- which matters more here than usual, because every write blocks
 * on a full site build.
 */
function planFeatured(items, desiredIds, featuredIds) {
  const by = new Map(items.map((p) => [p.id, p]));
  const seq = desiredIds.map((id) => by.get(id)).filter(Boolean);
  const out = [];
  let n = 0;
  for (const p of seq) {
    const want = featuredIds.has(p.id);
    const wantOrder = want ? ++n : null;
    const isNow = Boolean(p.featured);
    const orderNow = typeof p.featuredOrder === 'number' ? p.featuredOrder : null;
    if (want === isNow && wantOrder === orderNow) continue;
    // Unfeaturing clears the number too: a stale featuredOrder left behind would
    // decide the run the next time the box was ticked.
    out.push({ id: p.id, featured: want, featuredOrder: wantOrder });
  }
  return out;
}

/** Order changes and marquee changes merged, one entry per document. */
function planWorkChanges(items, desiredIds, featuredIds) {
  const merged = new Map();
  for (const c of planReorder(items, desiredIds)) merged.set(c.id, { ...c });
  for (const c of planFeatured(items, desiredIds, featuredIds)) {
    merged.set(c.id, { ...(merged.get(c.id) || { id: c.id }), ...c });
  }
  // Written in screen order so the progress report reads top to bottom.
  const pos = new Map(desiredIds.map((id, i) => [id, i]));
  return [...merged.values()].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}

// ------------------------------------------------------------ dragging
//
// Reordering runs on pointer events rather than HTML5 drag and drop, and the
// difference is the whole point of the screen. Native dragging gives you a
// translucent snapshot of the tile lagging behind the cursor and an insertion
// bar that asks you to imagine the result. Here the tile itself follows the
// cursor and the grid reflows underneath it, so the arrangement you are looking
// at while you drag IS the arrangement you get.
//
// Nothing re-renders during a drag. The real elements are moved inside the grid
// and animated from where they were to where they now are — smoother than
// rebuilding the tree, and the only way the thumbnails survive a drag without
// blinking through their pending state.

/**
 * Moves elements and makes them appear to slide there.
 *
 * Measure, mutate, measure again, then put everything back where it started
 * with a transform and take the transform away over the next few frames. The
 * browser lays the grid out once; the motion is compositor work.
 */
function slide(nodes, mutate, ms = 190) {
  if (!nodes.length) return mutate();
  // Measured WITH any transform still applied, so a slide interrupting another
  // slide starts from where the tile visually is rather than snapping first.
  const before = nodes.map((n) => n.getBoundingClientRect());
  mutate();
  // ...and the resting position has to be measured without one.
  nodes.forEach((n) => {
    n.style.transition = 'none';
    n.style.transform = '';
  });
  const deltas = nodes.map((n, i) => {
    const now = n.getBoundingClientRect();
    return [before[i].left - now.left, before[i].top - now.top];
  });
  nodes.forEach((n, i) => {
    const [dx, dy] = deltas[i];
    if (dx || dy) n.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  // One forced reflow, so the line above reads as a starting position instead
  // of being folded into the line below and animating nothing.
  nodes[0].getBoundingClientRect();
  requestAnimationFrame(() => {
    nodes.forEach((n) => {
      n.style.transition = `transform ${ms}ms var(--brand)`;
      n.style.transform = '';
    });
  });
}

/**
 * Which slot the pointer is asking for: the number of other tiles that come
 * before that point in reading order. The grid wraps, so "before" is a row test
 * first and a left-of test only within a row.
 */
function dropIndex(others, x, y, rowHalf) {
  let index = 0;
  for (const n of others) {
    const b = n.getBoundingClientRect();
    const cy = b.top + b.height / 2;
    const earlier = cy < y - rowHalf ? true : cy > y + rowHalf ? false : b.left + b.width / 2 < x;
    if (earlier) index++;
  }
  return index;
}

function startWorkDrag(e) {
  const w = state.workOrder;
  if (e.button !== 0 || !w || w.saving) return;
  const el = e.currentTarget;
  const grid = el.parentElement;
  const scroller = el.closest('.scroll');
  const box = el.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const grabX = e.clientX - box.left;
  const grabY = e.clientY - box.top;
  const wasOrder = [...grid.children].map((n) => n.dataset.id);
  let live = false;
  let at = { x: e.clientX, y: e.clientY };
  let ticking = 0;

  const others = () => [...grid.children].filter((n) => n !== el);

  const renumber = () =>
    [...grid.children].forEach((n, i) => {
      const pos = n.querySelector('.wtile__pos');
      if (pos) pos.textContent = pad2(i + 1);
    });

  const follow = () => {
    // The resting position is read with the transform off, so the offset stays
    // correct after the tile has been moved into a different slot.
    el.style.transition = 'none';
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${at.x - grabX - r.left}px, ${at.y - grabY - r.top}px)`;
  };

  const reflow = () => {
    const rest = others();
    const target = rest[dropIndex(rest, at.x, at.y, box.height / 2)] || null;
    if (el.nextElementSibling === target) return; // already in that slot
    slide(rest, () => grid.insertBefore(el, target));
    renumber();
    follow();
  };

  // A long run has to bring itself to the pointer, or moving a project from the
  // bottom to the top means dropping it, scrolling, and picking it up again.
  const EDGE = 90;
  const tick = () => {
    ticking = requestAnimationFrame(tick);
    if (!scroller) return;
    const b = scroller.getBoundingClientRect();
    const over = at.y - (b.bottom - EDGE);
    const under = b.top + EDGE - at.y;
    const by = over > 0 ? Math.min(over, EDGE) / 5 : under > 0 ? -Math.min(under, EDGE) / 5 : 0;
    if (!by) return;
    const was = scroller.scrollTop;
    scroller.scrollTop += by;
    if (scroller.scrollTop !== was) {
      follow();
      reflow();
    }
  };

  const onMove = (ev) => {
    at = { x: ev.clientX, y: ev.clientY };
    if (!live) {
      // A few pixels of slop, so a click can never count as a reorder.
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      live = true;
      el.dataset.lift = '1';
      grid.dataset.dragging = '1';
      ticking = requestAnimationFrame(tick);
    }
    follow();
    reflow();
  };

  const finish = (cancelled) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.removeEventListener('keydown', onKey);
    cancelAnimationFrame(ticking);
    grid.removeAttribute('data-dragging');
    // A press that never travelled far enough to be a drag is a click, and a
    // click opens that project's gallery.
    if (!live) {
      if (!cancelled) openCmsGallery(el.dataset.id);
      return;
    }

    // Escape puts the run back the way it was found, so the grid is safe to
    // push around and look at.
    if (cancelled) {
      slide(others(), () => {
        for (const id of wasOrder) {
          const n = [...grid.children].find((c) => c.dataset.id === id);
          if (n) grid.append(n);
        }
      });
      renumber();
    }

    // The tile lands rather than snapping: it travels from wherever the cursor
    // left it to the slot it now owns.
    const from = el.getBoundingClientRect();
    el.removeAttribute('data-lift');
    el.style.transition = 'none';
    el.style.transform = '';
    const to = el.getBoundingClientRect();
    el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
    el.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.style.transition = 'transform 200ms var(--brand)';
      el.style.transform = '';
    });

    // Re-rendering mid-flight would replace the element being animated, so the
    // state catches up with the DOM once the tile has landed.
    setTimeout(() => {
      const now = state.workOrder;
      if (!now) return;
      const next = [...grid.children].map((n) => n.dataset.id);
      if (next.join() !== now.ids.join()) {
        now.ids = next;
        now.touched = true;
      }
      render();
    }, 210);
  };

  const onUp = () => finish(false);
  const onKey = (ev) => {
    if (ev.key === 'Escape') finish(true);
  };

  // On document rather than on the tile: the pointer regularly leaves the tile
  // it is dragging, and the tile itself is replaced by the render that ends the
  // drag. `pointercancel` matters as much as `pointerup` — the window losing
  // focus mid-drag fires only the former, and without it the tile would be left
  // stuck to a cursor that is no longer there.
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', onKey);
}

// ---------------------------------------------------- a published gallery
//
// The other half of the work-page screen. The running order decides which
// projects come first; this decides what one project's own page looks like once
// you are inside it — click a tile in the grid and its gallery opens.
//
// Everything here is already in the CMS, so a reflow is one document write
// rather than a re-compose: no upload, no ffmpeg, no publish. The rows use the
// composer's own model (`moveTile`, `removeTile`, `setLayout`), which means the
// arrangement rules are the ones the rail has always used and the ten layouts
// are the ten the collection accepts.
//
// The cells are sized with `aspect-ratio` rather than pixels, so a row is the
// exact shape the site will build at whatever width the window happens to be.

const gallerySig = (rows) =>
  rows.map((r) => `${layoutOf(r)}:${r.items.map((i) => `${i.rel}@${i.focusX},${i.focusY}`).join(',')}`).join('|');

/** The editable rows for a project as the CMS returned it. */
const galleryRows = (project) =>
  project.gallery.map((r) => ({
    layout: r.layout,
    items: r.images.map((im) => ({ rel: im.id, url: im.url, name: im.name, video: im.video, focusX: clampPct(im.focusX), focusY: clampPct(im.focusY) })),
  }));

async function openCmsGallery(id) {
  set({ cmsGallery: null, cmsGalleryFor: id });
  try {
    const project = await withLoading('READING THE PROJECT', '', () => rpc.cmsProject(id), { inline: true });
    const rows = galleryRows(project);
    set({ cmsGallery: { project, rows, was: gallerySig(rows), saving: false, library: null } });
    // Its own uploads are what anyone opening this screen wants first, so the
    // library is filled in rather than waiting to be searched.
    if (project.base) loadCmsLibrary(project.base);
    // Same reasoning for the root: showing the matched folder as chosen while
    // its contact sheet sat unread would only read as a folder that failed to
    // open. Both panels arrive filled in.
    const root = matchingRoot(project.base);
    if (root) chooseRootProject(root.id);
  } catch (err) {
    set({ cmsGalleryFor: null });
    toast(err.message, 'error');
  }
}

const closeCmsGallery = () => set({ cmsGallery: null, cmsGalleryFor: null });

/**
 * The rest of this project's uploads.
 *
 * Payload's media is one flat collection with no link back to a project, but
 * the composer names every file it uploads `{base}_{role}{nn}` — so the base is
 * the grouping, and asking for filenames containing it finds the key image, the
 * thumb crop, and anything composed for an earlier version of the page.
 *
 * Nothing is uploaded from here: a file that is not in the CMS yet has to go
 * through 01-05, and this cannot invent one.
 */
async function loadCmsLibrary(query) {
  const g = state.cmsGallery;
  if (!g) return;
  g.library = { query, items: null, error: null };
  render();
  try {
    const items = await rpc.cmsMedia(query);
    if (state.cmsGallery?.library?.query === query) {
      state.cmsGallery.library = { query, items, error: null };
      render();
    }
  } catch (err) {
    if (state.cmsGallery?.library?.query === query) {
      state.cmsGallery.library = { query, items: [], error: err.message };
      render();
    }
  }
}

/** Adds an image as a new full-width row at the end, ready to be dragged. */
function addToGallery(item) {
  const g = state.cmsGallery;
  if (findRel(g.rows, item.rel)) return;
  slideRender(() => {
    g.rows = [...g.rows, { layout: DEFAULT_LAYOUT, items: [item] }];
  });
  // The new row lands at the bottom of a gallery that may be taller than the
  // window, so it is brought into view rather than silently appended.
  requestAnimationFrame(() => {
    document.querySelector(`.gcell[data-rel="${item.rel}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

/**
 * How many files the CMS already holds under this base and description.
 *
 * The answer decides what the next composed file is called, so it is read off
 * real filenames rather than assumed. An unnumbered `{base}_gallery.webp` counts
 * as one: it was composed when it was the only one of its kind, and the next
 * addition is the second.
 */
function publishedCount(base, desc, names) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(slugify(base))}_${esc(slugify(desc))}(\\d*)\\.`, 'i');
  let most = 0;
  for (const name of names) {
    const m = re.exec(name || '');
    if (m) most = Math.max(most, m[1] ? parseInt(m[1], 10) : 1);
  }
  return most;
}

// Additions are composed into a folder of their own rather than beside the
// originals. Not tidiness: `start_compose` writes `_compose-manifest.json` into
// whatever it composes into, and that file is the record of the ORIGINAL run —
// every asset, the hero, the row each tile sits in. Two additions would replace
// it with a two-line manifest, and a later publish from 05 would then try to
// rebuild the whole project out of two gallery tiles and no key image.
const ADDITIONS_DIR = '_additions';

/**
 * Compose the picked files off the root, upload them, and put them in the rows.
 *
 * Not `publish`: that rebuilds the whole project document from a manifest —
 * hero, write-up, services, the entire gallery — and this page is already
 * published. Compose writes the files, upload puts them in the media
 * collection, and they land as rows to be dragged. Nothing reaches the project
 * document until SAVE, which writes the gallery field alone.
 */
async function addFromRoot() {
  const g = state.cmsGallery;
  const r = g?.root;
  if (!r?.project || !r.picked.length) return;
  const base = g.project.base;
  if (!base) {
    return toast('This project has no upload name to compose against — publish it from 01–05 first', 'error');
  }

  const say = (message) => {
    if (state.cmsGallery?.root) {
      state.cmsGallery.root.log = [...state.cmsGallery.root.log, message];
      render();
    }
  };
  const stop = (message, kind = 'error') => {
    if (state.cmsGallery?.root) state.cmsGallery.root.busy = null;
    render();
    if (message) toast(message, kind);
  };

  r.busy = 'checking';
  r.log = [];
  render();

  try {
    // Read the collection again rather than trusting what is on screen: the
    // library list is whatever the search box last asked for, and a narrowed
    // list would under-count and send the run straight over a published file.
    const existing = await rpc.cmsMedia(base);
    const names = existing.map((m) => m.name);
    const from = publishedCount(base, 'gallery', names);
    say(`${from} already published under ${base}_gallery — the additions start at ${pad2(from + 1)}`);

    const picked = r.picked
      .map((rel) => r.project.assets.find((a) => a.rel === rel))
      .filter(Boolean);
    const size = picked.length + from;

    // Belt and braces. The offset should make every one of these new, and if it
    // has not then something is wrong with the count — so nothing is written.
    const taken = new Set(names.map((n) => n.toLowerCase()));
    const planned = picked.map((a, i) =>
      outName(base, 'gallery', i + from, size, a.kind === 'video' ? 'mp4' : 'webp')
    );
    const clash = planned.filter((n) => taken.has(n.toLowerCase()));
    if (clash.length) {
      return stop(`${clash[0]} is already in the CMS — composing would replace it. Nothing was written.`);
    }
    say(`composing ${planned.join(', ')}`);

    r.busy = 'composing';
    render();
    const started = await rpc.startCompose({
      projectId: r.project.id,
      base,
      items: picked.map((a) => ({ rel: a.rel, role: 'gallery', description: 'gallery' })),
      outDir: ADDITIONS_DIR,
      indexFrom: from,
    });

    const manifestPath = await new Promise((resolve, reject) => {
      let off = () => {};
      off = onComposeProgress(started.jobId || 'tauri', (evt) => {
        if (evt.type === 'log') say(evt.message);
        else if (evt.type === 'step') say(`${evt.step.status} ${evt.step.output}`);
        else if (evt.type === 'done') {
          off();
          const failed = evt.steps.filter((s) => s.status === 'failed');
          if (failed.length) reject(new Error(`${failed[0].output}: ${failed[0].message || 'failed to convert'}`));
          else resolve(evt.manifestPath);
        } else if (evt.type === 'error') {
          off();
          reject(new Error(evt.message));
        }
      });
    });

    r.busy = 'uploading';
    render();
    const offUpload = onPublishProgress((p) => say(p.message));
    let added;
    try {
      added = await rpc.uploadComposed({ manifestPath, alt: g.project.title });
    } finally {
      offUpload();
    }

    // The rows may have been dragged about while this ran, so they are read
    // fresh rather than from the closure.
    if (!state.cmsGallery) return;
    for (const m of added) addToGallery({ rel: m.id, url: m.url, name: m.name, video: m.video });
    state.cmsGallery.root.picked = [];
    state.cmsGallery.root.busy = null;
    render();
    toast(`${added.length} added — drag them into place, then SAVE`, 'ok');
    // The library is now a list short of these, and it is the thing that says
    // what belongs to this project.
    loadCmsLibrary(g.library?.query || base);
  } catch (err) {
    stop(err.message);
  }
}

/**
 * The folder on the roots a published project was built from.
 *
 * The link is the upload name, and it is NOT the slug: `base` is seeded from
 * the folder's slug in 02 but the field is editable and gets edited, so
 * `the-kid-laroi` on the NAS is `the-kid-laroi-a-perfect-world-tour` in the CMS.
 * Every project on the roots is like this — linkin-park, rick-astley,
 * morgan-wallen — so matching on equality found none of them. The slug is a
 * prefix of the base, which is the relationship worth looking for.
 *
 * Longest first, so `peso-pluma-exodo` wins over a shorter `peso` and the two
 * Peso jobs cannot be confused for one another. A guess is only ever a
 * pre-selection: the list is right there to correct it.
 */
function matchingRoot(base) {
  if (!base) return null;
  return state.projects
    .filter((p) => p.slug && (base.startsWith(p.slug) || p.slug.startsWith(base)))
    .sort((a, b) => b.slug.length - a.slug.length)[0];
}

/** Loads a root project's contact sheet into the gallery screen. */
async function chooseRootProject(id) {
  const g = state.cmsGallery;
  if (!g) return;
  g.root = { ...(g.root || {}), id, project: null, picked: [], busy: null, log: [], error: null };
  render();
  try {
    const project = await rpc.getProject(id);
    if (state.cmsGallery?.root?.id === id) {
      state.cmsGallery.root.project = project;
      render();
    }
  } catch (err) {
    if (state.cmsGallery?.root?.id === id) {
      state.cmsGallery.root.error = err.message;
      render();
    }
  }
}

function rootPanel() {
  const g = state.cmsGallery;
  const r = g.root || {};
  const busy = r.busy;
  const match = matchingRoot(g.project.base);
  const chosen = r.id || match?.id || '';
  // What the composer has already made is not a source. Its outputs sit in the
  // project folder next to the originals and the scan cannot tell them apart, so
  // without this the sheet offers `..._gallery01.webp` as something to add — and
  // picking it would transcode an already-transcoded, already-published file
  // into `..._gallery09.webp`. They are recognisable by the upload name they
  // carry, whether they are in the folder itself or in the additions folder.
  const own = `${slugify(g.project.base)}_`;
  const composed = (a) =>
    a.rel.startsWith(`${ADDITIONS_DIR}/`) || a.name.toLowerCase().startsWith(own);
  const shootable = (r.project?.assets || []).filter((a) => a.kind === 'image' || a.kind === 'video');
  const assets = shootable.filter((a) => !composed(a));
  const hidden = shootable.length - assets.length;

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '22px', borderTop: '1px solid var(--cw)' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } },
      h('span', { style: { fontWeight: 500, fontSize: '20px', letterSpacing: '0.02em' } }, 'Add from a root'),
      r.picked?.length
        ? h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.18em' } }, `${r.picked.length} PICKED`)
        : hidden
          ? h(
              'span.m.dimmer',
              { style: { fontSize: '9px', letterSpacing: '0.18em' } },
              `${hidden} ALREADY COMPOSED, NOT SHOWN`
            )
          : null
    ),
    h(
      'p.m.dimmer',
      { style: { margin: 0, fontSize: '9.5px', lineHeight: 1.7, letterSpacing: '0.06em', maxWidth: '620px' } },
      `Files that have never been published. They are transcoded to the same recipe as everything else, written to ${ADDITIONS_DIR}\u2044 in the folder, uploaded, and added as rows to drag into place \u2014 numbered on from what is already up, so nothing published is overwritten. The gallery itself is only written when you SAVE.`
    ),
    h(
      'label',
      { style: { display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '620px' } },
      h('span.m.dim', { style: { fontSize: '9px', letterSpacing: '0.18em', flex: '0 0 auto' } }, 'FOLDER'),
      h(
        'select.field.m',
        {
          // The selection rides on the option, not here: setting `value` as an
          // attribute on a <select> does nothing.
          disabled: Boolean(busy),
          style: { flex: '1 1 auto', fontSize: '10.5px', letterSpacing: '0.06em' },
          onChange: (e) => chooseRootProject(e.target.value),
        },
        h('option', { value: '' }, 'CHOOSE A FOLDER'),
        state.projects.map((p) =>
          h(
            'option',
            { value: p.id, selected: p.id === chosen ? 'selected' : null },
            `${p.folder}  \u00b7  ${p.stills} stills, ${p.videos} clips${p.id === match?.id ? '  \u00b7  MATCHES' : ''}`
          )
        )
      )
    ),
    r.error ? h('div.empty', {}, r.error) : null,
    !chosen
      ? h('div.empty', {}, 'No folder on the roots is named for this project — choose one')
      : !r.project
        ? h('div.empty', {}, 'Reading the folder')
        : assets.length
          ? h(
              'div.libgrid',
              {},
              assets.map((a) => {
                const on = r.picked.includes(a.rel);
                return h(
                  'button.libtile',
                  {
                    'aria-pressed': String(on),
                    disabled: Boolean(busy),
                    title: `${a.rel}\nclick to ${on ? 'drop' : 'pick'}`,
                    onClick: () => {
                      const p = state.cmsGallery.root;
                      p.picked = on ? p.picked.filter((x) => x !== a.rel) : [...p.picked, a.rel];
                      render();
                    },
                  },
                  rootThumb(r.project.id, a.rel, a.mtime),
                  h('span.libtile__tag.m', {}, on ? 'PICKED' : a.kind === 'video' ? 'VIDEO' : 'STILL'),
                  h('span.libtile__name.m.trunc', {}, a.name)
                );
              })
            )
          : h('div.empty', {}, 'Nothing in that folder to compose'),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '14px' } },
      h(
        'button.btn',
        {
          disabled: Boolean(busy) || !r.picked?.length,
          onClick: addFromRoot,
        },
        busy
          ? { checking: 'CHECKING THE CMS', composing: 'COMPOSING', uploading: 'UPLOADING' }[busy]
          : `COMPOSE ${r.picked?.length || 0} AND ADD`
      ),
      busy ? h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.18em' } }, 'THIS CAN TAKE A WHILE FOR VIDEO') : null
    ),
    r.log?.length
      ? h(
          'div.m.dimmer',
          { style: { fontSize: '9.5px', lineHeight: 1.8, letterSpacing: '0.04em', maxWidth: '620px' } },
          // The tail only: composing a dozen clips writes more than anyone reads.
          r.log.slice(-6).map((line) => h('div.trunc', {}, line))
        )
      : null
  );
}

function libraryPanel() {
  const g = state.cmsGallery;
  const lib = g.library;
  const used = new Set(flatTiles(g.rows).map((t) => t.rel));
  const items = lib?.items || [];
  const spare = items.filter((m) => !used.has(m.id));

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '22px', borderTop: '1px solid var(--cw)' } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } },
      h('span', { style: { fontWeight: 500, fontSize: '20px', letterSpacing: '0.02em' } }, 'Add from the CMS'),
      h(
        'span.m.dimmer',
        { style: { fontSize: '9px', letterSpacing: '0.18em' } },
        lib?.items === null ? 'LOOKING' : `${spare.length} NOT IN THIS GALLERY`
      )
    ),
    h(
      'p.m.dimmer',
      { style: { margin: 0, fontSize: '9.5px', lineHeight: 1.7, letterSpacing: '0.06em', maxWidth: '620px' } },
      'Everything the CMS holds under this project\u2019s upload name — the key image, the thumb crop, and anything composed for an earlier version of the page. Click to put one back; it lands as a new row at the end for you to drag into place. Something that was never published has to go through 01–05 first.'
    ),
    h(
      'label',
      { style: { display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid var(--rule)', padding: '9px 12px', maxWidth: '620px' } },
      IC.search(),
      h('input.m', {
        id: 'lib-q',
        value: lib?.query || '',
        placeholder: 'FILENAME CONTAINS',
        style: { flex: '1 1 auto', fontSize: '10.5px', letterSpacing: '0.08em', outline: 'none' },
        // On change, not input: this is a request to the CMS per keystroke
        // otherwise.
        onChange: (e) => loadCmsLibrary(e.target.value),
      })
    ),
    lib?.error ? h('div.empty', {}, lib.error) : null,
    lib?.items === null
      ? h('div.empty', {}, 'Reading the library')
      : items.length
        ? h(
            'div.libgrid',
            {},
            items.map((m) => {
              const inUse = used.has(m.id);
              const isKey = m.id === g.project.keyImage;
              return h(
                'button.libtile',
                {
                  'data-used': inUse ? '1' : null,
                  disabled: inUse,
                  title: inUse ? `${m.name}\nalready in this gallery` : `${m.name}\nclick to add`,
                  onClick: () => addToGallery({ rel: m.id, url: m.url, name: m.name, video: m.video }),
                },
                workThumb(m.url, 'lib'),
                h('span.libtile__tag.m', {}, inUse ? 'IN USE' : isKey ? 'KEY IMAGE' : m.video ? 'VIDEO' : 'STILL'),
                h('span.libtile__name.m.trunc', {}, m.name.replace(/^[^_]*_/, ''))
              );
            })
          )
        : h('div.empty', {}, 'Nothing in the CMS matches that'),
  );
}

async function saveCmsGallery() {
  const g = state.cmsGallery;
  g.saving = true;
  render();
  try {
    const project = await rpc.saveCmsGallery(
      g.project.id,
      g.rows.map((r) => ({ layout: layoutOf(r), images: r.items.map((i) => ({ id: i.rel, focusX: i.focusX, focusY: i.focusY })) }))
    );
    const rows = galleryRows(project);
    set({ cmsGallery: { project, rows, was: gallerySig(rows), saving: false, library: g.library, root: g.root } });
    toast(`${project.title} gallery saved`, 'ok');
    notify('Gallery saved', `${project.title} — publish the site to go live`);
  } catch (err) {
    if (state.cmsGallery) state.cmsGallery.saving = false;
    render();
    toast(err.message, 'error');
  }
}

/**
 * Re-renders and makes the cells appear to slide to their new places.
 *
 * The rows change SHAPE as images move between them — a two-up losing one
 * becomes a full-width band — so unlike the work grid this cannot move elements
 * around by hand. It re-renders and matches the new cells to the old ones by
 * media id instead. `held` is the cell being dragged, which is following the
 * cursor and must not be animated anywhere.
 */
function slideRender(mutate, held) {
  const cells = () => [...document.querySelectorAll('.gcell[data-rel]')];
  const before = new Map(cells().map((n) => [n.dataset.rel, n.getBoundingClientRect()]));
  mutate();
  render();
  const now = cells().filter((n) => n.dataset.rel !== held && before.has(n.dataset.rel));
  const deltas = now.map((n) => {
    const was = before.get(n.dataset.rel);
    const box = n.getBoundingClientRect();
    return [was.left - box.left, was.top - box.top];
  });
  now.forEach((n, i) => {
    const [dx, dy] = deltas[i];
    if (!dx && !dy) return;
    n.style.transition = 'none';
    n.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  now[0]?.getBoundingClientRect();
  requestAnimationFrame(() => {
    now.forEach((n) => {
      n.style.transition = 'transform 190ms var(--brand)';
      n.style.transform = '';
    });
  });
}

/**
 * What the pointer is asking for: a seam between rows, or a side of a cell.
 *
 * Seams are tested first and by containment, so dropping into one is a
 * deliberate move to a row of its own. Anywhere else falls to the nearest cell,
 * which means a drop never misses — letting go over the margin puts the image
 * beside whatever it was closest to rather than nowhere.
 */
function galleryTarget(x, y, held) {
  for (const gap of document.querySelectorAll('.ggap')) {
    const b = gap.getBoundingClientRect();
    if (y >= b.top && y <= b.bottom) return { kind: 'gap', at: Number(gap.dataset.gap) };
  }
  let best = null;
  let bestDistance = Infinity;
  for (const cell of document.querySelectorAll('.gcell')) {
    if (cell === held) continue;
    const b = cell.getBoundingClientRect();
    const d = Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));
    if (d < bestDistance) {
      bestDistance = d;
      best = cell;
    }
  }
  if (!best) return { kind: 'gap', at: -1 };
  const b = best.getBoundingClientRect();
  return {
    kind: 'cell',
    row: Number(best.dataset.row),
    slot: Number(best.dataset.slot),
    side: x < b.left + b.width / 2 ? 'left' : 'right',
  };
}

function startGalleryDrag(e) {
  const g = state.cmsGallery;
  if (e.button !== 0 || !g || g.saving) return;
  const rel = e.currentTarget.dataset.rel;
  const startX = e.clientX;
  const startY = e.clientY;
  const box = e.currentTarget.getBoundingClientRect();
  const grabX = e.clientX - box.left;
  const grabY = e.clientY - box.top;
  const scroller = e.currentTarget.closest('.scroll');
  let live = false;
  let at = { x: e.clientX, y: e.clientY };
  let ticking = 0;
  let movedAt = 0;

  // The element is replaced on every re-render, so it is looked up by the media
  // id rather than held on to.
  const cell = () => document.querySelector(`.gcell[data-rel="${rel}"]`);

  const follow = () => {
    const el = cell();
    if (!el) return;
    el.dataset.lift = '1';
    el.style.transition = 'none';
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${at.x - grabX - r.left}px, ${at.y - grabY - r.top}px)`;
  };

  const reflow = () => {
    const g = state.cmsGallery;
    const el = cell();
    if (!g || !el) return;
    const from = findRel(g.rows, rel);
    if (!from) return;
    // Rows change SHAPE as they take an image, which moves the seams around
    // under a stationary cursor — so without a moment to settle, hovering a
    // seam makes the row split and merge over and over. A tenth of a second is
    // long enough to stop the flapping and short enough to feel immediate.
    if (performance.now() - movedAt < 110) return;
    const target = galleryTarget(at.x, at.y, el);
    const next = moveTile({ row: from.row, slot: from.slot }, target, g.rows);
    if (gallerySig(next) === gallerySig(g.rows)) return;
    movedAt = performance.now();
    slideRender(() => {
      g.rows = next;
    }, rel);
    follow();
  };

  const EDGE = 90;
  const tick = () => {
    ticking = requestAnimationFrame(tick);
    if (!scroller) return;
    const b = scroller.getBoundingClientRect();
    const over = at.y - (b.bottom - EDGE);
    const under = b.top + EDGE - at.y;
    const by = over > 0 ? Math.min(over, EDGE) / 5 : under > 0 ? -Math.min(under, EDGE) / 5 : 0;
    if (!by) return;
    const was = scroller.scrollTop;
    scroller.scrollTop += by;
    if (scroller.scrollTop !== was) {
      follow();
      reflow();
    }
  };

  const onMove = (ev) => {
    at = { x: ev.clientX, y: ev.clientY };
    if (!live) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      live = true;
      // In state, not on the element: every reflow re-renders the pane, which
      // would drop an attribute set directly.
      g.dragging = true;
      ticking = requestAnimationFrame(tick);
    }
    follow();
    reflow();
  };

  const finish = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    cancelAnimationFrame(ticking);
    if (state.cmsGallery) state.cmsGallery.dragging = false;
    if (!live) return;
    const el = cell();
    if (!el) return render();
    // The cell lands rather than snapping back.
    const from = el.getBoundingClientRect();
    el.removeAttribute('data-lift');
    el.style.transition = 'none';
    el.style.transform = '';
    const to = el.getBoundingClientRect();
    el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
    el.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.style.transition = 'transform 200ms var(--brand)';
      el.style.transform = '';
    });
    setTimeout(render, 210);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

// ------------------------------------------------------------------ crop
//
// The site draws every slot with object-fit: cover at a fixed aspect, so the
// one freedom is where inside the picture that window sits — exactly what
// object-position takes, and what the CMS keeps as focusX / focusY. The editor
// shows the whole picture dimmed with the slot's window over it; dragging
// slides the picture under the window, Instagram-style, and the two numbers
// are what get written. Nothing is resampled and the file is untouched.

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));

/** The cell's thumbnail, cropped the way the site will crop it. */
function focusedThumb(item) {
  const img = workThumb(item.url, 'cell');
  img.style.objectPosition = `${clampPct(item.focusX)}% ${clampPct(item.focusY)}%`;
  return img;
}

function openCrop(ri, slot) {
  const g = state.cmsGallery;
  const item = g?.rows[ri]?.items[slot];
  if (!item || g.saving || g.crop) return;
  // Two copies of the same frame: one dimmed under everything, one clipped
  // to the window. The thumbnail route rather than the file itself because a
  // gallery is mostly video, and a poster frame is what the site crops too.
  // ONE request, though: the dimmed copy is a plain <img> that takes the
  // frame's src once it has one, so the same file is never built twice at
  // once — two builds racing on one cache path was a picture that never came.
  const main = cmsThumbImg(item.url, 1600, { alt: '', draggable: 'false' });
  const ghost = h('img', { alt: '', draggable: 'false' });
  const imgs = [ghost, main];
  const at = { x: clampPct(item.focusX), y: clampPct(item.focusY) };
  const crop = { ri, slot, x: at.x, y: at.y, was: at, nat: null, failed: false, imgs };
  // The picture's true shape is what the geometry needs. A cached copy can be
  // complete before any listener exists and its load event already gone, so
  // decode() is asked as well as the events: whichever settles first wins,
  // and the rest are no-ops. In the desktop app the src arrives later, after
  // the thumbnail is made, and the load event is what catches that.
  const settle = () => {
    if (g.crop !== crop || crop.nat || !main.naturalWidth) return;
    crop.nat = { w: main.naturalWidth, h: main.naturalHeight };
    ghost.src = main.currentSrc || main.src;
    render();
  };
  const fail = () => {
    if (g.crop !== crop || crop.nat) return;
    crop.failed = true;
    render();
  };
  main.addEventListener('load', settle);
  main.addEventListener('error', fail);
  // The desktop app marks a thumbnail it could not make ON the element rather
  // than firing an event, so that has to be watched for as well — otherwise a
  // frame that never comes reads as one still on its way.
  new MutationObserver(() => { if (main.dataset.failed) fail(); }).observe(main, { attributes: true, attributeFilter: ['data-failed'] });
  if (main.getAttribute('src')) main.decode().then(settle, () => (main.naturalWidth ? settle() : fail()));
  g.crop = crop;
  render();
  setTimeout(() => document.getElementById('cropov')?.focus(), 0);
}

function closeCrop(commit) {
  const g = state.cmsGallery;
  const c = g?.crop;
  if (!c) return;
  if (commit) {
    const item = g.rows[c.ri]?.items[c.slot];
    if (item) {
      item.focusX = c.x;
      item.focusY = c.y;
    }
  }
  g.crop = null;
  render();
}

/** Window and picture sizes in px: the window at the slot's aspect, the picture covering it. */
function cropGeometry(c, layout) {
  const A = ratioOf(aspectFor(layout, c.slot) || '3 / 2');
  const maxW = Math.max(320, window.innerWidth * 0.6);
  const maxH = Math.max(200, window.innerHeight * 0.56);
  let W = maxW;
  let H = W / A;
  if (H > maxH) {
    H = maxH;
    W = H * A;
  }
  const nat = c.nat || { w: 3, h: 2 };
  const pa = nat.w / nat.h;
  const iw = pa > A ? H * pa : W;
  const ih = pa > A ? H : W / pa;
  return { W, H, iw, ih };
}

// object-position semantics: the X% point of the picture sits on the X% point
// of the window, so the picture's offset is the overflow times the fraction.
const cropOffset = (geo, x, y) => ({ left: -((geo.iw - geo.W) * x) / 100, top: -((geo.ih - geo.H) * y) / 100 });

function cropOverlay(g) {
  const c = g.crop;
  const row = g.rows[c.ri];
  const item = row?.items[c.slot];
  if (!row || !item) return null;
  const layout = layoutOf(row);
  const geo = cropGeometry(c, layout);
  const off = cropOffset(geo, c.x, c.y);
  const px = geo.iw - geo.W;
  const py = geo.ih - geo.H;
  const freeX = px > 0.5;
  const freeY = py > 0.5;
  const imgStyle = { position: 'absolute', width: `${geo.iw}px`, height: `${geo.ih}px`, left: `${off.left}px`, top: `${off.top}px`, maxWidth: 'none', display: 'block', pointerEvents: 'none', userSelect: 'none' };
  Object.assign(c.imgs[0].style, imgStyle, { opacity: c.nat ? 0.3 : 0 });
  Object.assign(c.imgs[1].style, imgStyle, { opacity: c.nat ? 1 : 0 });

  // The drag updates the DOM directly and only commits to state on release:
  // a full render per pointer move would fight the pointer.
  const apply = () => {
    const o = cropOffset(geo, c.x, c.y);
    for (const im of c.imgs) {
      im.style.left = `${o.left}px`;
      im.style.top = `${o.top}px`;
    }
    const read = document.getElementById('cropread');
    if (read) read.textContent = `X ${c.x} · Y ${c.y}`;
  };
  const move = (dx, dy) => {
    if (freeX) c.x = clampPct(c.x + dx);
    if (freeY) c.y = clampPct(c.y + dy);
    apply();
  };
  const onDown = (e) => {
    if (e.button !== 0 || !c.nat) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = c.x;
    const oy = c.y;
    const onMove = (ev) => {
      // Dragging the picture right slides the window LEFT over it.
      if (freeX) c.x = clampPct(ox - ((ev.clientX - sx) / px) * 100);
      if (freeY) c.y = clampPct(oy - ((ev.clientY - sy) / py) * 100);
      apply();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };
  const onKey = (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'Escape') closeCrop(false);
    else if (e.key === 'Enter') closeCrop(true);
    else if (e.key === 'ArrowLeft') move(-step, 0);
    else if (e.key === 'ArrowRight') move(step, 0);
    else if (e.key === 'ArrowUp') move(0, -step);
    else if (e.key === 'ArrowDown') move(0, step);
    else return;
    e.preventDefault();
  };

  const hint = !c.nat
    ? c.failed ? 'NO PREVIEW FOR THIS FILE — THE NUMBERS STILL SET THE CROP' : 'READING THE PICTURE — ESC CANCELS'
    : !freeX && !freeY ? 'THIS PICTURE IS THE SLOT’S OWN SHAPE — THERE IS NOTHING TO MOVE'
    : freeX && freeY ? 'DRAG THE PICTURE · ARROW KEYS NUDGE, SHIFT FOR 5'
    : freeX ? 'DRAG LEFT OR RIGHT · ARROW KEYS NUDGE, SHIFT FOR 5' : 'DRAG UP OR DOWN · ARROW KEYS NUDGE, SHIFT FOR 5';

  return h(
    'div.cropov',
    {
      id: 'cropov',
      tabindex: '0',
      onKeydown: onKey,
      // The dark surround is a cancel; the panel itself is not.
      onPointerdown: (e) => { if (e.target === e.currentTarget) closeCrop(false); },
    },
    h(
      'div.cropov__top',
      {},
      h('span.ov', {}, 'Crop'),
      h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.16em' } }, `${item.name}  ·  ${layoutLabel(layout)}  ·  SLOT ${c.slot + 1}`)
    ),
    h(
      'div.cropov__stage',
      { style: { width: `${geo.W}px`, height: `${geo.H}px` }, 'data-free': freeX || freeY ? '1' : null, onPointerdown: onDown },
      c.imgs[0],
      h('div.cropov__win', {}, c.imgs[1], ['tl', 'tr', 'bl', 'br'].map((k) => h(`div.cropov__hd.cropov__hd--${k}`)))
    ),
    h(
      'div.cropov__bar',
      {},
      h('span.m', { id: 'cropread', style: { fontSize: '10px', letterSpacing: '0.18em', fontVariantNumeric: 'tabular-nums', minWidth: '96px' } }, `X ${c.x} · Y ${c.y}`),
      h('span.m.dim', { style: { fontSize: '9px', letterSpacing: '0.16em' } }, hint),
      h('div.grow'),
      h('button.chip', { onClick: () => { c.x = 50; c.y = 50; apply(); } }, 'CENTRE'),
      h('button.chip', { onClick: () => closeCrop(false) }, 'CANCEL'),
      h('button.chip', { 'aria-pressed': 'true', onClick: () => closeCrop(true) }, 'DONE')
    )
  );
}

// ------------------------------------------------------------------ rendering

function galleryCell(row, ri, slot, item, n) {
  const layout = layoutOf(row);
  return h(
    'div.gcell',
    {
      'data-rel': item.rel,
      'data-row': ri,
      'data-slot': slot,
      style: {
        flexGrow: spansFor(layout)[slot] || 1,
        flexBasis: 0,
        aspectRatio: aspectFor(layout, slot) || '3 / 2',
        alignSelf: alignEndFor(layout, slot) ? 'flex-end' : 'flex-start',
      },
      title: `${item.name}\n${layoutLabel(layout)} · slot ${slot + 1} of ${row.items.length}\nDouble-click to set where the crop sits`,
      onPointerdown: startGalleryDrag,
      onDblclick: () => openCrop(ri, slot),
    },
    focusedThumb(item),
    h('span.gcell__num.m', {}, pad2(n)),
    item.video ? h('span.gcell__vid.m', {}, 'VIDEO') : null,
    // Only a moved crop gets a badge: centred is the norm and stays quiet.
    item.focusX !== 50 || item.focusY !== 50 ? h('span.gcell__crop.m', { title: 'Crop centre, left→right · top→bottom' }, `${item.focusX} · ${item.focusY}`) : null,
    h(
      'button.gcell__x',
      {
        title: 'Take this out of the gallery',
        // The button sits on top of a drag surface, so the press must not also
        // start a drag.
        onPointerdown: (e) => e.stopPropagation(),
        onClick: () => {
          const g = state.cmsGallery;
          slideRender(() => {
            g.rows = removeTile(g.rows, ri, slot);
          });
        },
      },
      IC.x()
    )
  );
}

/** A seam. Dropping here gives the image a row of its own. */
const galleryGap = (at) => h('div.ggap', { 'data-gap': at });

function galleryRow(row, ri, first) {
  const layout = layoutOf(row);
  const alts = layoutsForCount(row.items.length);
  return h(
    'div.gwrap',
    {},
    h(
      'div.ghead',
      {},
      h('span.m.dim', { style: { fontSize: '9px', letterSpacing: '0.2em' } }, `ROW ${pad2(ri + 1)}`),
      // Only the layouts with this slot count are offered — the others cannot
      // hold the row's images and the collection would reject them.
      alts.map((l) =>
        h(
          'button.chip',
          {
            'aria-pressed': String(l === layout),
            onClick: () => {
              const g = state.cmsGallery;
              slideRender(() => {
                g.rows = setLayout(g.rows, ri, l);
              });
            },
          },
          alts.length > 3 ? heightLabel(l) : layoutLabel(l)
        )
      )
    ),
    h('div.gcells', { 'data-row': ri }, row.items.map((it, s) => galleryCell(row, ri, s, it, first + s + 1)))
  );
}

function cmsGalleryPanel() {
  const g = state.cmsGallery;
  if (!g) {
    return h(
      'div.screen',
      {},
      h(
        'div.pane.pane--main',
        { style: { padding: '38px 40px' } },
        state.loading?.inline ? loader(state.loading.label, state.loading.detail, state.loading.since) : h('div.empty', {}, 'Reading the project')
      )
    );
  }

  const dirty = gallerySig(g.rows) !== g.was;
  const signedIn = Boolean(state.status?.payload?.credentials);
  const count = galleryCount(g.rows);
  let n = 0;

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.scroll.gallery',
      { 'data-dragging': g.dragging ? '1' : null, style: { padding: '38px 40px 0', gap: '20px', display: 'flex', flexDirection: 'column' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('span.ov', {}, `Gallery · ${g.project.year}`),
          h('h1', { style: { margin: 0, fontWeight: 500, fontSize: '42px', lineHeight: 1 } }, g.project.title)
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          h('button.chip', { disabled: g.saving, onClick: () => openExternal(g.project.url) }, 'OPEN PAGE'),
          h('button.chip', { disabled: g.saving, onClick: closeCmsGallery }, 'BACK TO THE RUN')
        )
      ),
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '10px', lineHeight: 1.75, letterSpacing: '0.06em', maxWidth: '760px' } },
        'Every image here is already in the CMS, so rearranging costs one write rather than a re-compose. Drag between rows, or into a seam to give an image a row of its own; a row picks up or drops a layout as it gains and loses images, and the buttons above each row set which one. Cells are drawn at the shape the site will build them — double-click one to set where its crop sits.'
      ),
      g.rows.length
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column' } },
            galleryGap(0),
            g.rows.map((row, ri) => {
              const first = n;
              n += row.items.length;
              return [galleryRow(row, ri, first), galleryGap(ri + 1)];
            })
          )
        : h('div.empty', {}, 'This project has no gallery rows — add one below'),
      libraryPanel(),
      rootPanel(),
      h('div', { style: { minHeight: '40px' } })
    ),
    g.crop ? cropOverlay(g) : null,
    h(
      'div.pane.pane--r',
      { style: { width: '300px', padding: '38px 26px', gap: '16px' } },
      h('span.ov', {}, 'Gallery'),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--rule)' } },
        [
          ['ROWS', String(g.rows.length)],
          ['IMAGES', String(count)],
          ['CHANGED', dirty ? 'YES' : 'NO'],
        ].map(([k, v]) =>
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--rule)' } },
            h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, k),
            h('span.m', { style: { fontSize: '10px', letterSpacing: '0.06em' } }, v)
          )
        )
      ),
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '9px', lineHeight: 1.8, letterSpacing: '0.1em' } },
        'TAKING AN IMAGE OUT REMOVES IT FROM THIS PAGE ONLY — THE FILE STAYS IN THE CMS AND ANY OTHER PROJECT USING IT IS UNTOUCHED. IT GOES LIVE WITH THE NEXT SITE-WIDE PUBLISH.'
      ),
      g.saving
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '7px', border: '1px solid var(--cw45)', padding: '12px 14px' } },
            h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, 'WRITING'),
            h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.1em' } }, 'SAVING TO THE CMS')
          )
        : null,
      sitePublishPanel(g.saving ? 'the gallery is still being written' : dirty ? 'save the gallery first, or the publish will not have it' : ''),
      h('div.grow'),
      !signedIn ? h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.14em', lineHeight: 1.7 } }, 'SIGN IN TO WRITE THE GALLERY TO THE CMS') : null,
      h(
        'button.btn.btn--ghost',
        {
          disabled: !dirty || g.saving,
          onClick: () =>
            slideRender(() => {
              g.rows = g.project.gallery.map((r) => ({
                layout: r.layout,
                items: r.images.map((im) => ({ rel: im.id, url: im.url, name: im.name, video: im.video })),
              }));
            }),
        },
        'REVERT'
      ),
      h(
        'button.btn',
        {
          disabled: !dirty || g.saving || !signedIn,
          title: signedIn ? '' : 'Signing in is what lets the app write to the CMS',
          onClick: saveCmsGallery,
        },
        g.saving ? 'SAVING' : 'SAVE GALLERY'
      )
    )
  );
}

// ---------------------------------------------------------------- the screen

// The thumbnails outlive the render that made them. Rebuilding them would mean
// 24 fresh <img> elements, each blank until its source resolves, so the grid
// would blink through its pending state every time a count changed.
//
// Keyed on WHERE as well as what. These are elements, and an element lives in
// one place — `append` moves it — so when the library went in below the rows
// holding the same media, it lifted the thumbnails straight out of the cells
// above and the gallery came up blank. Two callers, two nodes; the backend
// caches the thumb on disk, so the second is a cache hit rather than a second
// transcode.
const workThumbs = new Map();
const workThumb = (url, where = 'grid') => {
  const key = `${where}\u0000${url}`;
  if (!workThumbs.has(key)) workThumbs.set(key, cmsThumbImg(url, 420, { alt: '' }));
  return workThumbs.get(key);
};

/** The same, for a file on a root rather than one in the CMS. */
const rootThumb = (projectId, rel, mtime) => {
  const key = `root\u0000${projectId}\u0000${rel}\u0000${mtime}`;
  if (!workThumbs.has(key)) {
    workThumbs.set(key, thumbImg(projectId, rel, 420, { alt: '', 'data-mtime': mtime }));
  }
  return workThumbs.get(key);
};

const workState = (items) => ({
  items,
  ids: items.map((p) => p.id),
  // The marquee run as a set of ids, seeded from what the CMS holds. Kept beside
  // the order rather than mutating `items`, so REVERT is just dropping this.
  featuredIds: new Set(items.filter((p) => p.featured).map((p) => p.id)),
  saving: null,
  touched: false,
});

function closeWorkOrder() {
  workThumbs.clear();
  set({ workOrderOpen: false, workOrder: null, cmsGallery: null, cmsGalleryFor: null });
}

async function openWorkOrder() {
  set({ workOrderOpen: true, settingsOpen: false, workOrder: null });
  try {
    const items = await withLoading(
      'READING THE WORK PAGE',
      state.status?.payload?.url || '',
      () => rpc.listWorkOrder(),
      { inline: true }
    );
    set({ workOrder: workState(items) });
  } catch (err) {
    set({ workOrderOpen: false });
    toast(err.message, 'error');
  }
}

async function saveWorkOrder() {
  const w = state.workOrder;
  const changes = planWorkChanges(w.items, w.ids, w.featuredIds);
  if (!changes.length) return;
  w.saving = { done: 0, total: changes.length, title: '' };
  render();
  // Each write blocks on a full site build, so the only honest progress report
  // is per document — an indeterminate spinner for ten minutes reads as a hang.
  const off = onReorderProgress((p) => {
    if (state.workOrder) state.workOrder.saving = { total: changes.length, ...p };
    render();
  });
  try {
    const items = await rpc.saveWorkOrder(changes);
    set({ workOrder: workState(items) });
    const n = changes.length;
    toast(`Work page reordered — ${n} project${n > 1 ? 's' : ''} rewritten`, 'ok');
    notify('Work page reordered', `${n} project${n > 1 ? 's' : ''} written, site rebuilt`);
  } catch (err) {
    if (state.workOrder) state.workOrder.saving = null;
    render();
    toast(err.message, 'error');
  } finally {
    off();
  }
}

/** Toggle a project in or out of the homepage marquee. */
function toggleFeatured(id) {
  const w = state.workOrder;
  if (!w || w.saving) return;
  if (w.featuredIds.has(id)) w.featuredIds.delete(id);
  else w.featuredIds.add(id);
  w.touched = true;
  render();
}

function workTile(p, position, dirty, featured, marqueePos) {
  return h(
    'div.wtile',
    {
      // The grid is the record of the order while a drag is in flight, so every
      // tile has to be able to say which project it is.
      'data-id': p.id,
      'data-dirty': dirty ? '1' : null,
      title: `${p.title}\n${p.year}${p.code ? ' · ' + p.code : ''}`,
      onPointerdown: startWorkDrag,
    },
    h(
      'div.wtile__img',
      {},
      p.image
        ? workThumb(p.image)
        : h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.18em' } }, 'NO KEY IMAGE'),
      // Inside the still, not beside it: .wtile__img is the relative box, so
      // anchoring to the bottom here means the bottom of the PICTURE rather than
      // the bottom of the tile, where the name and meta live.
      //
      // `pointerdown` is stopped, not just `click`: the tile starts a drag on
      // pointerdown, so without this every tick would also pick the tile up and
      // reflow the grid under the cursor.
      h(
        'button.wtile__star.m',
        {
          'data-on': featured ? '1' : '0',
          title: featured
            ? `On the homepage marquee at position ${marqueePos}. Click to take it off.`
            : 'Not on the homepage marquee. Click to add it.',
          onPointerdown: (e) => {
            e.stopPropagation();
            e.preventDefault();
          },
          onClick: (e) => {
            e.stopPropagation();
            toggleFeatured(p.id);
          },
        },
        featured ? `\u2605 ${pad2(marqueePos)}` : '\u2606'
      )
    ),
    h('span.wtile__pos.m', {}, pad2(position)),
    dirty ? h('span.wtile__moved.m', {}, 'REWRITE') : null,
    h('span.wtile__name.trunc', {}, p.title),
    h(
      'span.wtile__meta.m.dimmer',
      {},
      [p.year, p.code, featured ? 'FEATURED' : null].filter(Boolean).join(' \u00b7 ') || '\u2014'
    )
  );
}

function workOrderPanel() {
  const w = state.workOrder;
  if (!w) {
    return h(
      'div.screen',
      {},
      h(
        'div.pane.pane--main',
        { style: { padding: '38px 40px' } },
        state.loading?.inline ? loader(state.loading.label, state.loading.detail, state.loading.since) : h('div.empty', {}, 'Reading the work page')
      )
    );
  }

  const changes = planWorkChanges(w.items, w.ids, w.featuredIds);
  const dirty = new Set(changes.map((c) => c.id));
  const by = new Map(w.items.map((p) => [p.id, p]));
  const run = w.ids.map((id) => by.get(id)).filter(Boolean);
  const signedIn = Boolean(state.status?.payload?.credentials);
  const busy = Boolean(w.saving);
  const n = changes.length;

  return h(
    'div.screen',
    {},
    h(
      'div.pane.pane--main.scroll',
      { style: { padding: '38px 40px 0', gap: '22px', display: 'flex', flexDirection: 'column' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          h('span.ov', {}, 'Work page'),
          h('h1', { style: { margin: 0, fontWeight: 500, fontSize: '46px', lineHeight: 1 } }, 'Running order')
        ),
        h('button.chip', { disabled: busy, onClick: closeWorkOrder }, 'CLOSE')
      ),
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '10px', lineHeight: 1.75, letterSpacing: '0.06em', maxWidth: '760px' } },
        'This is the grid in the order the site builds it, top left first. Drag a project anywhere in the run — the order set here decides the page, and the year is only used to settle a tie, so a 2022 job can sit above a 2026 one if that is the story you want to tell. Click a project to open its own gallery and rearrange the images inside it. The star on a still puts it on the HOMEPAGE MARQUEE; the number beside it is its place in that run, taken from the order below, so dragging a project moves it in both.'
      ),
      run.length
        ? h(
            'div.wgrid',
            {},
            (() => {
              // Marquee position is derived from the run, so it renumbers itself
              // as tiles are dragged or ticked -- see planFeatured.
              let m = 0;
              return run.map((p, i) => {
                const featured = w.featuredIds.has(p.id);
                if (featured) m++;
                return workTile(p, i + 1, dirty.has(p.id), featured, m);
              });
            })()
          )
        : h('div.empty', {}, 'No published projects in the CMS'),
      h('div', { style: { minHeight: '20px' } })
    ),
    h(
      'div.pane.pane--r',
      { style: { width: '330px', padding: '38px 30px', gap: '18px' } },
      h('span.ov', {}, 'Publish'),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--rule)' } },
        [
          ['PROJECTS', String(w.items.length)],
          ['TO REWRITE', String(n)],
          ['ON MARQUEE', String(state.workOrder?.featuredIds?.size ?? 0)],
        ].map(([k, v]) =>
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--rule)' } },
            h('span.m.dim', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, k),
            h('span.m', { style: { fontSize: '10px', letterSpacing: '0.06em' } }, v)
          )
        )
      ),
      // Saying this out loud is the point: the cost of a reorder is not the API
      // call, it is that the CMS rebuilds the entire site once per document and
      // does it synchronously. A big reshuffle is minutes, not seconds.
      // Two things worth saying out loud, and the app is the only place either
      // can be said. The first is that the cost of a reorder is not the API
      // call: the CMS rebuilds the whole site once per document, synchronously,
      // so a big reshuffle is minutes rather than seconds. The second is that
      // the run can already need writing before anybody drags anything —
      // projects sharing an order number have no defined sequence, so what is
      // on screen is one reading of the CMS rather than a promise about it.
      h(
        'p.m.dimmer',
        { style: { margin: 0, fontSize: '9px', lineHeight: 1.8, letterSpacing: '0.1em' } },
        n
          ? `SAVING WRITES ${n} PROJECT${n > 1 ? 'S' : ''} TO THE CMS AND NOTHING ELSE. THE SITE SHOWS THE NEW RUN AFTER A PUBLISH.`
          : 'NOTHING HAS MOVED. DRAG A PROJECT TO CHANGE THE RUN.'
      ),
      n && !w.touched
        ? h(
            'p.m.dimmer',
            { style: { margin: 0, fontSize: '9px', lineHeight: 1.8, letterSpacing: '0.1em', borderTop: '1px solid var(--rule)', paddingTop: '12px' } },
            `${n} PROJECT${n > 1 ? 'S SHARE' : ' SHARES'} AN ORDER NUMBER WITH ANOTHER, WHICH IS NOT A SEQUENCE. THE RUN ABOVE IS ONE VALID READING OF IT — SAVING MAKES IT THE ONLY ONE.`
          )
        : null,
      busy
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '7px', border: '1px solid var(--cw45)', padding: '12px 14px' } },
            h('span.m', { style: { fontSize: '9.5px', letterSpacing: '0.18em' } }, `WRITING ${w.saving.done} / ${w.saving.total}`),
            h('span.m.dimmer.trunc', { style: { fontSize: '9px', letterSpacing: '0.1em' } }, w.saving.title || 'SAVING TO THE CMS')
          )
        : null,
      sitePublishPanel(busy ? 'the order is still being written' : n ? 'save the order first, or the publish will not have it' : ''),
      h('div.grow'),
      !signedIn
        ? h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.14em', lineHeight: 1.7 } }, 'SIGN IN TO WRITE THE ORDER TO THE CMS')
        : null,
      h(
        'button.btn.btn--ghost',
        { disabled: !n || busy, onClick: () => set({ workOrder: workState(w.items) }) },
        'REVERT'
      ),
      h(
        'button.btn',
        {
          disabled: !n || busy || !signedIn,
          title: signedIn ? '' : 'Signing in is what lets the app write to the CMS',
          onClick: saveWorkOrder,
        },
        busy ? `SAVING ${w.saving.done}/${w.saving.total}` : n ? `SAVE \u00b7 ${n}` : 'SAVE'
      )
    )
  );
}

const SCREENS = { pick: screenPick, compose: screenCompose, previz: screenPreviz, copy: screenCopy, export: screenExport };

let scrollMemo = {};
function render() {
  const app = $('#app');
  // Keep scroll position across re-renders — the contact sheet is long.
  app.querySelectorAll('.scroll').forEach((n, i) => (scrollMemo[state.screen + i] = n.scrollTop));
  // ...and keep the caret where it was, so live-filtering stays typable.
  const active = document.activeElement;
  const focusId = active && active.id ? active.id : null;
  const caret = focusId && active.selectionStart !== undefined ? active.selectionStart : null;

  // replaceChildren stringifies null, so filter before handing it over.
  app.replaceChildren(
    ...[
      topBar(),
      state.cmsGalleryFor
        ? cmsGalleryPanel()
        : state.workOrderOpen
        ? workOrderPanel()
        : state.settingsOpen
          ? settingsPanel()
          : (state.project || state.cmsDoc || state.screen === 'pick' ? SCREENS[state.screen] : screenPick)(),
      state.login ? loginModal() : null,
      state.loading && !state.loading.inline ? loadingOverlay() : null,
      state.toast ? h('div.toast', { 'data-kind': state.toast.kind }, state.toast.message) : null,
    ].filter(Boolean)
  );

  app.querySelectorAll('.scroll').forEach((n, i) => (n.scrollTop = scrollMemo[state.screen + i] || 0));
  if (focusId) {
    const next = app.querySelector(`#${focusId}`);
    if (next) {
      next.focus();
      if (caret !== null && next.setSelectionRange) next.setSelectionRange(caret, caret);
    }
  }
}

(async function boot() {
  render();
  try {
    state.status = await rpc.status();
    const where = (state.status?.roots || []).map((r) => r.path).join('  ');
    await withLoading(
      'SCANNING FOR PROJECTS',
      where,
      async () => {
        state.projects = await rpc.listProjects();
      },
      { inline: true }
    );
  } catch (err) {
    stopLoading();
    toast(err.message, 'error');
  }
  render();
})();
