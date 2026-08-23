// AOIN page composer — front end.
// One state object, one render pass per change. Text inputs commit on `change`
// (blur/enter) rather than `input`, so re-rendering never eats a keystroke.

import { rpc, thumbImg, onComposeProgress, onPublishProgress, pickFolder, openExternal, isTauri } from '/transport.js';

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

// The gallery is a list of ROWS, and each row picks one of five layouts. This
// mirrors the Payload `gallery` field exactly (`{ layout, images: [...] }`), so
// what the rail shows is what the CMS stores — no translation at publish time.
//
// The five layouts are the site's, not ours: the geometry below is lifted from
// frontend/src/components/project/ProjectPage.astro on `integration`.
const COLS = 12;
const LAYOUTS = {
  full: { slots: 1, spans: [12], aspects: [null], label: 'FULL WIDTH' },
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
const GROW = { full: 'two-up', 'two-up': 'three-up', 'split-8-4': 'three-up', 'split-5-7': 'three-up' };
// ...and shrink into when it loses one.
const SHRINK = { 'three-up': 'two-up', 'two-up': 'full', 'split-8-4': 'full', 'split-5-7': 'full' };

const layoutOf = (row) => (row && LAYOUTS[row.layout] ? row.layout : DEFAULT_LAYOUT);
const slotsFor = (layout) => LAYOUTS[layout]?.slots || 1;
const spansFor = (layout) => LAYOUTS[layout]?.spans || [12];
const aspectFor = (layout, slot) => LAYOUTS[layout]?.aspects?.[slot] ?? null;
const alignEndFor = (layout, slot) => Boolean(LAYOUTS[layout]?.alignEnd?.[slot]);
const layoutLabel = (layout) => LAYOUTS[layout]?.label || String(layout).toUpperCase();

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
  project: null,
  kindFilter: 'all',
  dirFilter: null,
  mode: 'gallery',
  hero: null,
  view: 'grid',
  collapsed: new Set(),
  gallery: [],
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
};

/**
 * An <img> for an asset. The mtime rides along so a re-exported asset busts the
 * cache (and so a stale cached response for an old URL can never stick). On the
 * Tauri build the file is generated on demand and the src fills in after.
 */
const thumb = (rel, w = 420, attrs = {}) => {
  const mt = state.project.assets.find((a) => a.rel === rel)?.mtime || 0;
  return thumbImg(state.project.id, rel, w, { ...attrs, 'data-mtime': Math.round(mt) });
};

// ------------------------------------------------------------------ chrome
const STEPS = [
  ['pick', '01', 'PICK'],
  ['compose', '02', 'COMPOSE'],
  ['previz', '03', 'PREVIZ'],
  ['copy', '04', 'COPY'],
  ['export', '05', 'EXPORT'],
];

function topBar() {
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
        { title: 'Asset roots and CMS target', 'aria-current': String(state.settingsOpen), onClick: openSettings, style: { marginRight: '10px' } },
        IC.gear(),
        h('span', {}, 'ROOTS')
      ),
      STEPS.map(([id, n, label]) =>
        h(
          'button.step',
          {
            'aria-current': String(state.screen === id),
            disabled: id !== 'pick' && !state.project,
            // Picking a step also leaves the roots panel: it sits over the whole
            // screen, so without this the click looked like it did nothing and
            // the panel had to be closed by hand first.
            onClick: () => set({ screen: id, settingsOpen: false }),
          },
          h('span', {}, n),
          h('span', {}, label)
        )
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
async function openSettings() {
  try {
    const s = await rpc.getSettings();
    set({ settingsOpen: true, settings: s, browse: null, browseFor: null });
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
    const s = await rpc.saveSettings({ roots: state.settings.roots, payloadUrl: state.settings.payload.url });
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
        )
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
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, h('span.ov', {}, 'Step 01'), h('h1', {}, 'Select a project')),
        h(
          'div',
          { style: { display: 'flex', gap: '5px' } },
          roots.map((r) =>
            h('button.chip', { 'aria-pressed': String(state.rootFilter === r.label), onClick: () => set({ rootFilter: state.rootFilter === r.label ? null : r.label }) }, r.label)
          )
        )
      ),
      (state.status?.offline || []).length
        ? h(
            'button',
            { style: { display: 'flex', alignItems: 'center', gap: '11px', border: '1px solid var(--cw45)', padding: '11px 14px', textAlign: 'left' }, onClick: openSettings },
            IC.server(),
            h('span.m.grow', { style: { fontSize: '9.5px', letterSpacing: '0.14em', color: 'var(--cw80)' } }, `${state.status.offline.length} ROOT${state.status.offline.length > 1 ? 'S' : ''} UNREACHABLE — ${state.status.offline.map((r) => r.label).join(', ')}`),
            h('span.m.dimmer', { style: { fontSize: '8.5px', letterSpacing: '0.18em' } }, 'OPEN SETTINGS')
          )
        : null,
      h(
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
      h(
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
                  'aria-selected': String(sel?.id === p.id),
                  onClick: () => set({ selectedProjectId: p.id }),
                  onDblclick: () => openProject(p.id),
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
      sel
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
            h('button.btn', { onClick: () => openProject(sel.id) }, 'OPEN IN COMPOSER'),
          ]
        : h('div.empty', {}, 'Nothing selected')
    )
  );
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
        h('span.trunc.grow', {}, child.name.toUpperCase()),
        h('span.dimmer', { style: { fontSize: '9.5px' } }, total)
      )
    );
    if (expanded && hasKids) treeRows(child, out);
  }
  return out;
}

function screenCompose() {
  const p = state.project;
  const assets = p.assets.filter(
    (a) => (state.kindFilter === 'all' || a.kind === state.kindFilter) && inFolder(a.dir, state.dirFilter)
  );
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
                  { 'data-on': badge ? '1' : '0', 'data-role': state.hero === a.rel ? 'hero' : '', 'data-blocked': state.mode === 'hero' && a.kind === 'video' ? '1' : '0', onClick: () => pickAsset(a.rel), title: state.mode === 'hero' && a.kind === 'video' ? a.rel + ' — a video cannot be the hero' : a.rel },
                  thumb(a.rel, 420, { loading: 'lazy', alt: a.name }),
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
          { style: { position: 'relative', aspectRatio: '16/9', borderRadius: '12px', overflow: 'hidden', background: '#111', outline: state.hero ? '2px solid #fff' : '1px solid var(--rule)', outlineOffset: '-2px' } },
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
        : h('div.empty', { style: { flex: '1 1 auto', fontSize: '9px' } }, 'Click tiles to build the carousel'),
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
function moveTile(from, target) {
  const tile = state.gallery[from.row]?.items[from.slot];
  if (!tile) return state.gallery;
  const collapses = state.gallery[from.row].items.length === 1;
  const rows = removeTile(state.gallery, from.row, from.slot);

  if (target.kind === 'gap') {
    let at = target.at < 0 ? rows.length : target.at;
    if (collapses && from.row < at) at -= 1;
    rows.splice(Math.max(0, Math.min(rows.length, at)), 0, { layout: DEFAULT_LAYOUT, items: [tile] });
    return rows;
  }

  let ri = target.row;
  if (collapses && from.row < ri) ri -= 1;
  if (ri < 0 || ri >= rows.length) {
    rows.push({ layout: DEFAULT_LAYOUT, items: [tile] });
    return rows;
  }
  return insertIntoRow(rows, ri, target.slot + (target.side === 'right' ? 1 : 0), tile);
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
      set({ gallery: moveTile(from, { kind: 'gap', at: rowIndex }) });
    },
  });
}

function railRow(row, rowIndex, nameAt) {
  const layout = layoutOf(row);
  const spans = spansFor(layout);
  const alts = layoutsForCount(row.items.length);
  const cells = [];

  row.items.forEach((it, slot) => {
    const flat = nameAt(rowIndex, slot);
    if (slot > 0) cells.push(divider(rowIndex, layout));
    cells.push(
      h(
        'div.cell',
        {
          style: { flexGrow: spans[slot] || 1, flexBasis: 0 },
          draggable: true,
          title: (flat?.output || it.rel) + '\n' + layoutLabel(layout) + ' \u00b7 slot ' + (slot + 1) + ' of ' + row.items.length,
          onDragstart: (e) => {
            state.drag = { row: rowIndex, slot };
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
            set({ gallery: moveTile(from, { kind: 'cell', row: rowIndex, slot, side }) });
          },
        },
        // An <img> is a drag source in its own right, so without this the browser
        // drags the photo instead of the tile and the split never fires.
        thumb(it.rel, 320, { alt: '', draggable: 'false' }),
        h('span.cell__num.m', {}, pad2((flat?.n ?? 0) + 1)),
        h('span.cell__span.m', {}, spans[slot] === COLS ? 'FULL' : spans[slot] + '/' + COLS),
        h(
          'button.cell__x',
          {
            title: 'Remove',
            onClick: (e) => {
              e.stopPropagation();
              set({ gallery: removeTile(state.gallery, rowIndex, slot) });
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
    h('div.railrow2__strip', {}, cells),
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
              title: layoutLabel(layout) + ' - click to cycle the layouts for ' + row.items.length + ' images',
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

  // The key image is not typed here — it is the hero picked on step 02. Showing
  // it keeps the form honest about what will actually publish, since `image` is
  // required by the collection and there is nowhere else on this screen to see it.
  const heroName = plannedNames(state).find((n) => n.role === 'hero');
  const imageField = () =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
      fieldLabel('Image', true),
      state.hero
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
    h(
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
        h('span.m.dimmer', { style: { fontSize: '9px', letterSpacing: '0.14em' } }, 'ORDER IS ASSIGNED ON PUBLISH'),
        h('button.btn', { onClick: () => set({ screen: 'export' }) }, 'CONTINUE TO EXPORT')
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
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
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
      'The expandable full write-up (FULL WRITE-UP panel). Formatting from the doc is kept as Markdown — **bold**, *italic*, `code`, <u>underline</u>, [links](url), # headings, > quotes and - lists all publish as rich text.'
    )
  );
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
    toast(`Published ${res.slug} — ${res.mediaCount} media, rebuild queued`);
  } catch (err) {
    finish();
    set({ publishing: false });
    toast(err.message, 'error');
  }
}

function screenExport() {
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
          [`UPLOAD ${steps.length} MEDIA DOCS`, `${state.publishResult ? 'UPDATED' : 'CREATE'} PROJECT / ${slugify(state.fields?.slug || state.base).toUpperCase()}`, 'TRIGGER ASTRO REBUILD'].map((label, i) =>
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
        h('button.btn', { disabled: !canPublish || state.publishing, onClick: runPublish }, state.publishing ? 'PUBLISHING…' : 'PUBLISH TO STAGING')
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
      state.settingsOpen ? settingsPanel() : (state.project || state.screen === 'pick' ? SCREENS[state.screen] : screenPick)(),
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
