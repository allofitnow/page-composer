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
      mergeIds: (ids) => invoke('merge_project_ids', { ids }),
      getSettings: () => invoke('get_settings'),
      saveSettings: ({ roots, payloadUrl, publishToken }) => invoke('save_settings', { roots, payloadUrl, publishToken: publishToken ?? null }),
      browse: (path) => invoke('browse_dir', { path }),
      readCopyDoc: (id, rel) => invoke('read_copy_doc', { id, rel: rel || null }),
      parseCopyText: (name, text) => invoke('parse_copy_text', { name, text }),
      validateFields: (fields) => invoke('validate_fields', { fields }),
      planCompose: (body) => invoke('plan_compose', body),
      startCompose: (body) => invoke('start_compose', body),
      publish: ({ fields, manifestPath }) => invoke('publish_project', { fields, manifestPath }),
      listWorkOrder: () => invoke('list_work_order'),
      saveWorkOrder: (changes) => invoke('save_work_order', { changes }),
      cmsProject: (id) => invoke('cms_project', { id }),
      cmsProjects: () => invoke('cms_projects'),
      cmsFields: (id) => invoke('cms_project_fields', { id }),
      saveCmsFields: (id, fields, changed, writeupSlate) =>
        invoke('save_cms_fields', { id, fields, changed, writeupSlate }),
      cmsMedia: (query) => invoke('cms_media', { query }),
      uploadComposed: ({ manifestPath, alt }) => invoke('upload_composed', { manifestPath, alt }),
      saveCmsGallery: (id, rows) => invoke('save_cms_gallery', { id, rows }),
      payloadLogin: ({ email, password, remember }) => invoke('payload_login', { email, password, remember }),
      payloadLogout: () => invoke('payload_logout'),
      publishSite: () => invoke('publish_site'),
    }
  : {
      status: () => http('/api/status'),
      listProjects: () => http('/api/projects'),
      getProject: (id) => http(`/api/project/${id}`),
      mergeIds: (ids) => httpPost('/api/merge', { ids }).then((r) => r.id),
      getSettings: () => http('/api/settings'),
      saveSettings: ({ roots, payloadUrl, publishToken }) => httpPost('/api/settings', { roots, payloadUrl, publishToken }),
      browse: (path) => http(`/api/browse?${q({ path })}`),
      readCopyDoc: (id, rel) => http(`/api/copy/${id}?${q({ rel })}`),
      parseCopyText: (name, text) => httpPost('/api/copy-text', { name, text }),
      validateFields: (fields) => httpPost('/api/validate', { fields }).then((v) => v),
      planCompose: (body) => httpPost('/api/plan', body),
      startCompose: (body) => httpPost('/api/compose', body),
      publish: ({ fields, manifestPath }) => httpPost('/api/publish', { fields, manifestPath }),
      listWorkOrder: () => http('/api/work-order'),
      saveWorkOrder: (changes) => httpPost('/api/work-order', { changes }),
      cmsProject: (id) => http(`/api/cms-project/${id}`),
      cmsProjects: () => http('/api/cms-projects'),
      cmsFields: (id) => http(`/api/cms-fields/${id}`),
      saveCmsFields: (id, fields, changed, writeupSlate) =>
        httpPost(`/api/cms-fields/${id}`, { fields, changed, writeupSlate }),
      cmsMedia: (query) => http(`/api/cms-media?${q({ query })}`),
      uploadComposed: ({ manifestPath, alt }) => httpPost('/api/upload-composed', { manifestPath, alt }),
      saveCmsGallery: (id, rows) => httpPost(`/api/cms-project/${id}/gallery`, { rows }),
      payloadLogin: ({ email, password, remember }) => httpPost('/api/payload/login', { email, password, remember }),
      payloadLogout: () => httpPost('/api/payload/logout', {}),
      publishSite: () => httpPost('/api/site/publish', {}),
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
 * An <img> for a KEY IMAGE that lives in the CMS rather than on a root.
 *
 * The desktop build cannot simply point at the url: the content policy allows
 * images from `asset:` and `data:` only, and the CMS address is a runtime
 * setting, so it could not be named in the policy even if the policy were
 * loosened. The backend fetches, downscales and caches it instead, which lands
 * it in the same place as every other thumbnail.
 */
export function cmsThumbImg(url, width, attrs = {}) {
  const img = document.createElement('img');
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) img.setAttribute(k, String(v));
  }
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
  if (!url) {
    delete img.dataset.pending;
    img.dataset.failed = '1';
    return img;
  }
  if (!isTauri) {
    // Not the url itself: a gallery is mostly video, and an <img> cannot show
    // an mp4. The backend answers with a poster frame either way.
    img.src = `/api/cms-thumb?${q({ url, w: width })}`;
    return img;
  }
  invoke('cms_thumb', { url, w: width })
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
 * Reorder progress, one event per project written. It matters more here than
 * anywhere else in the app: each write blocks on a full site build, so without
 * it a legitimate ten-minute save is indistinguishable from a hang. The HTTP
 * backend has no event channel and still only reports at the end.
 */
export function onReorderProgress(handler) {
  if (!isTauri) return () => {};
  const unlisten = T.event.listen('reorder://progress', (e) => handler(e.payload));
  return () => unlisten.then((f) => f()).catch(() => {});
}

/**
 * The ORIGINAL file, for the Quick Look overlay — a thumbnail is a 420px crop
 * and a video has no thumbnail worth watching. Over HTTP the URL is known
 * outright; Tauri has to ask where the file is and convert the path, because
 * the asset protocol streams it (and answers range requests, which a <video>
 * needs in order to seek). Handing bytes back through a command instead would
 * mean loading the whole file into memory before the first frame drew.
 */
export async function mediaSrc(projectId, rel) {
  if (!isTauri) return `/api/file/${projectId}?${q({ rel })}`;
  const path = await invoke('source_path', { id: projectId, rel });
  return T.core.convertFileSrc(path);
}

/**
 * Frame rate, frame count and duration of a SOURCE video — everything the trim
 * timeline needs to be frame accurate. Probed on the source, never the proxy,
 * because the frame numbers have to mean the same thing to ffmpeg at compose
 * time and compose reads the source.
 */
export async function probeMedia(projectId, rel) {
  if (!isTauri) return http(`/api/probe/${projectId}?${q({ rel })}`);
  return invoke('probe_media', { id: projectId, rel });
}

/**
 * A web-playable proxy of a source video, for when the original is a format the
 * webview cannot decode. Slow the first time — it is a real transcode — and
 * cached after that.
 */
export async function previewSrc(projectId, rel) {
  if (!isTauri) return `/api/preview/${projectId}?${q({ rel })}`;
  // NOT the asset protocol: it serves the source roots but answers 403 for
  // anything in the app's own cache directory, where the proxy lives. The bytes
  // come over the IPC instead and become a blob. Affordable only because the
  // proxy is small by construction — never do this with an original.
  const bytes = await invoke('preview_bytes', { id: projectId, rel });
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
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
 * A desktop notification, for the end of something long enough that nobody
 * watched it. Best-effort by design: a denied permission, a browser without the
 * API, or a locked-down desktop must never break the thing it is reporting on,
 * so every failure path is swallowed and the in-app toast still stands on its
 * own.
 */
export async function notify(title, body) {
  try {
    if (isTauri) {
      let granted = await invoke('plugin:notification|is_permission_granted');
      if (!granted) granted = (await invoke('plugin:notification|request_permission')) === 'granted';
      if (granted) await invoke('plugin:notification|notify', { options: { title, body } });
      return;
    }
    if (typeof Notification === 'undefined') return;
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm === 'granted') new Notification(title, { body });
  } catch {
    /* the toast already said it; a notification is a courtesy */
  }
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
