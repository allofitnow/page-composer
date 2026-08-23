// One backend-agnostic surface for the UI.
//
// The same `web/` folder runs against two backends: the Node/Express server
// (`fetch('/api/…')`) and the Tauri build (`invoke('…')`). Every call the app
// makes goes through here, so neither backend leaks into the UI code.
//
// The shapes on both sides are identical by design — if you add a field to one
// backend, add it to the other.

const T = globalThis.__TAURI__;
export const isTauri = Boolean(T);

// --- HTTP side -------------------------------------------------------------
async function http(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const httpPost = (path, body) =>
  http(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// --- Tauri side ------------------------------------------------------------
// invoke() rejects with a plain string; normalise it to an Error so callers can
// treat both transports the same.
const invoke = async (cmd, args) => {
  try {
    return await T.core.invoke(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e?.message || String(e));
  }
};

const q = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export const rpc = isTauri
  ? {
      status: () => invoke('get_status'),
      listProjects: () => invoke('list_projects'),
      getProject: (id) => invoke('get_project', { id }),
      getSettings: () => invoke('get_settings'),
      saveSettings: ({ roots, payloadUrl }) => invoke('save_settings', { roots, payloadUrl }),
      browse: (path) => invoke('browse_dir', { path }),
      readCopyDoc: (id, rel) => invoke('read_copy_doc', { id, rel: rel || null }),
      validateFields: (fields) => invoke('validate_fields', { fields }),
      planCompose: (body) => invoke('plan_compose', body),
      startCompose: (body) => invoke('start_compose', body),
      publish: ({ fields, manifestPath }) => invoke('publish_project', { fields, manifestPath }),
      payloadLogin: ({ email, password, remember }) => invoke('payload_login', { email, password, remember }),
      payloadLogout: () => invoke('payload_logout'),
    }
  : {
      status: () => http('/api/status'),
      listProjects: () => http('/api/projects'),
      getProject: (id) => http(`/api/project/${id}`),
      getSettings: () => http('/api/settings'),
      saveSettings: ({ roots, payloadUrl }) => httpPost('/api/settings', { roots, payloadUrl }),
      browse: (path) => http(`/api/browse?${q({ path })}`),
      readCopyDoc: (id, rel) => http(`/api/copy/${id}?${q({ rel })}`),
      validateFields: (fields) => httpPost('/api/validate', { fields }).then((v) => v),
      planCompose: (body) => httpPost('/api/plan', body),
      startCompose: (body) => httpPost('/api/compose', body),
      publish: ({ fields, manifestPath }) => httpPost('/api/publish', { fields, manifestPath }),
      payloadLogin: ({ email, password, remember }) => httpPost('/api/payload/login', { email, password, remember }),
      payloadLogout: () => httpPost('/api/payload/logout', {}),
    };

/**
 * Thumbnails differ in kind, not just in shape: over HTTP the URL is known
 * synchronously, while Tauri has to generate the file and hand back a path to
 * convert. So callers get an <img> element rather than a URL, and it fills in
 * when it can.
 */
export function thumbImg(projectId, rel, width, attrs = {}) {
  const img = document.createElement('img');
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) img.setAttribute(k, String(v));
  }
  // Both transports flag the same states so the tile can style them: pending
  // while it is being generated, failed if it never arrives. A thumbnail that
  // cannot be made is not worth a toast — the filename still reads.
  img.dataset.pending = '1';
  img.addEventListener('load', () => delete img.dataset.pending, { once: true });
  img.addEventListener(
    'error',
    () => {
      delete img.dataset.pending;
      img.dataset.failed = '1';
    },
    { once: true }
  );

  if (!isTauri) {
    img.src = `/api/thumb/${projectId}?${q({ rel, w: width, v: attrs['data-mtime'] })}`;
    return img;
  }
  invoke('thumbnail', { id: projectId, rel, w: width })
    .then((path) => {
      img.src = T.core.convertFileSrc(path);
    })
    .catch(() => {
      delete img.dataset.pending;
      img.dataset.failed = '1';
    });
  return img;
}

/**
 * Publish steps as they happen. The desktop backend emits an event per step; the
 * HTTP backend still only reports at the end, so there the UI falls back to the
 * elapsed clock alone. Returns an unsubscribe function either way.
 */
export function onPublishProgress(handler) {
  if (!isTauri) return () => {};
  const unlisten = T.event.listen('publish://progress', (e) => handler(e.payload));
  return () => unlisten.then((f) => f()).catch(() => {});
}

/**
 * Compose progress. HTTP streams it over SSE; Tauri emits window events.
 * Returns an unsubscribe function in both cases.
 */
export function onComposeProgress(job, handler) {
  if (isTauri) {
    const unlisten = T.event.listen('compose://progress', (e) => handler(e.payload));
    return () => unlisten.then((f) => f()).catch(() => {});
  }
  const es = new EventSource(`/api/job/${job}`);
  es.onmessage = (ev) => handler(JSON.parse(ev.data));
  es.onerror = () => es.close();
  return () => es.close();
}

// Plugin namespaces (`__TAURI__.dialog`, `__TAURI__.opener`) only exist when the
// plugins' JS packages are bundled, and this front end deliberately has no build
// step. Their commands are reachable through the core invoke either way, so call
// that and use the namespace only if something else put it there.

/** Native folder picker; falls back to the in-app browser on the web build. */
export async function pickFolder(startAt) {
  if (!isTauri) return null;
  const options = {
    directory: true,
    multiple: false,
    title: 'Choose an asset root',
    defaultPath: startAt || null,
  };
  const chosen = T.dialog?.open
    ? await T.dialog.open(options)
    : await invoke('plugin:dialog|open', { options });
  if (Array.isArray(chosen)) return chosen[0] ?? null;
  return typeof chosen === 'string' ? chosen : null;
}

export async function openExternal(url) {
  if (!isTauri) return window.open(url, '_blank', 'noreferrer');
  if (T.opener?.openUrl) return T.opener.openUrl(url);
  return invoke('plugin:opener|open_url', { path: url });
}
