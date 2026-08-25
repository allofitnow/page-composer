import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, roots, ROOT_DIR, applyRoots, saveConfig, saveCredentials, reachable } from './config.js';
import { listProjects, getProject, invalidateAll, decodeId, resolveRel, mergeIds } from './scan.js';
import { thumbnail, preview } from './thumbs.js';
import { ffmpegStatus, probe, videoInfo } from './ffmpeg.js';
import { parseCopyDoc, validate, TAXONOMY } from './copydoc.js';
import { startCompose, getJob, plan } from './compose.js';
import { publish, payloadStatus, checkLogin, setCredentials, clearCredentials, serviceCategories } from './payload.js';
import { safeJoin } from './util.js';

const app = express();
app.use(express.json({ limit: '4mb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(400).json({ error: String(err.message || err) });
});

app.get('/api/status', wrap(async (_req, res) => {
  res.json({
    roots: roots.map((r) => ({ label: r.label, path: r.path })),
    // Configured but unreachable — a NAS that is offline or not yet mounted.
    offline: (config.roots || []).filter((r) => !roots.some((x) => x.path === r.path)),
    ffmpeg: await ffmpegStatus(),
    payload: await payloadStatus(),
    taxonomy: TAXONOMY,
    // The editable services taxonomy, straight from the CMS.
    services: await serviceCategories(),
    recipe: config.recipe,
  });
}));

app.get('/api/settings', wrap((_req, res) => {
  res.json({
    roots: (config.roots || []).map((r) => ({ ...r, online: reachable(r.path) })),
    payload: { url: config.payload.url, credentials: Boolean(config.payload.email && config.payload.password) },
  });
}));

app.post('/api/settings', wrap((req, res) => {
  const saved = applyRoots(req.body.roots || []);
  if (req.body.payloadUrl) config.payload.url = String(req.body.payloadUrl).trim().replace(/\/$/, '');
  saveConfig();
  invalidateAll();
  res.json({
    roots: saved.map((r) => ({ ...r, online: reachable(r.path) })),
    payload: { url: config.payload.url, credentials: Boolean(config.payload.email && config.payload.password) },
  });
}));

/**
 * Directory picker for pointing at a NAS: lists the sub-folders of `path` so
 * you can drill into a UNC share (\\\\nas\\projects) without typing it exactly.
 * Read-only, directories only, never files.
 */
app.get('/api/browse', wrap((req, res) => {
  const target = String(req.query.path || '').trim();
  if (!target) return res.json({ path: '', parent: null, online: false, dirs: [] });
  if (!reachable(target)) return res.json({ path: target, parent: path.dirname(target), online: false, dirs: [] });
  const dirs = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return res.json({ path: target, parent: parent === target ? null : parent, online: true, dirs });
}));

app.get('/api/projects', wrap((_req, res) => res.json(listProjects())));

app.post('/api/merge', wrap((req, res) => res.json({ id: mergeIds(req.body.ids || []) })));
app.get('/api/project/:id', wrap((req, res) => res.json(getProject(req.params.id))));

app.get('/api/thumb/:id', wrap(async (req, res) => {
  const project = getProject(req.params.id);
  // `__first` lets the picker show a project without knowing its contents.
  const asset =
    req.query.rel === '__first'
      ? project.assets.find((a) => a.kind === 'image') || project.assets[0]
      : project.assets.find((a) => a.rel === req.query.rel);
  if (!asset) return res.status(404).end();
  const width = Math.min(Number(req.query.w) || 420, 1800);
  const file = await thumbnail(resolveRel(decodeId(req.params.id), asset.rel), asset.kind, width);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  // The cache lives in `.cache`, and send() 404s any path with a dot-segment
  // unless dotfiles are allowed explicitly.
  res.sendFile(file, { dotfiles: 'allow' });
}));

// The ORIGINAL file, for the preview overlay — a thumbnail is a 420px crop and
// a video has no thumbnail worth scrubbing. sendFile answers Range requests on
// its own, which a <video> needs to seek at all.
app.get('/api/file/:id', wrap((req, res) => {
  const project = getProject(req.params.id);
  const asset = project.assets.find((a) => a.rel === req.query.rel);
  if (!asset) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(resolveRel(decodeId(req.params.id), asset.rel), { dotfiles: 'allow' });
}));

// Frame rate and frame count for the trim timeline. Always probed on the
// SOURCE, never on the proxy: the frame numbers an editor sets have to mean the
// same thing to ffmpeg at compose time, and compose reads the source.
app.get('/api/probe/:id', wrap(async (req, res) => {
  const project = getProject(req.params.id);
  const asset = project.assets.find((a) => a.rel === req.query.rel);
  if (!asset) return res.status(404).end();
  const info = videoInfo(await probe(resolveRel(decodeId(req.params.id), asset.rel)));
  if (!info) return res.status(400).json({ error: 'could not probe this file' });
  res.json(info);
}));

// The proxy for a source video the webview cannot decode. Slow the first time —
// it is a real transcode — and instant afterwards.
app.get('/api/preview/:id', wrap(async (req, res) => {
  const project = getProject(req.params.id);
  const asset = project.assets.find((a) => a.rel === req.query.rel);
  if (!asset) return res.status(404).end();
  if (asset.kind !== 'video') return res.status(400).json({ error: 'not a video' });
  const file = await preview(resolveRel(decodeId(req.params.id), asset.rel));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file, { dotfiles: 'allow' });
}));

// The services cell has no delimiter once Google Docs exports it, so the parser
// is handed the CMS list to split it against.
app.get('/api/copy/:id', wrap(async (req, res) => {
  const project = getProject(req.params.id);
  const rel = req.query.rel || project.docs[0]?.rel;
  if (!rel) return res.json({ file: null, fields: null, blocks: [], validation: null });
  const parsed = await parseCopyDoc(resolveRel(decodeId(req.params.id), rel), await serviceCategories());
  res.json({ ...parsed, rel, validation: validate(parsed.fields) });
}));

app.post('/api/validate', wrap((req, res) => res.json(validate(req.body.fields || {}))));

app.post('/api/plan', wrap((req, res) => {
  const project = getProject(req.body.projectId);
  const outDir = req.body.outDir ? safeJoin(project.dir, req.body.outDir) : project.dir;
  res.json({ outDir, steps: plan({ project, base: req.body.base, items: req.body.items, outDir }) });
}));

app.post('/api/compose', wrap((req, res) => {
  const job = startCompose(req.body);
  res.json({ jobId: job.id, outDir: job.outDir, steps: job.steps });
}));

app.get('/api/job/:jobId', wrap((req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);

  // Replay so a late subscriber (or a reload) still sees the whole run.
  send({ type: 'snapshot', steps: job.steps, log: job.log, done: job.done, outDir: job.outDir });
  if (job.done) {
    send({ type: 'done', steps: job.steps, manifestPath: path.join(job.outDir, '_compose-manifest.json') });
    return res.end();
  }

  const onEvent = (evt) => {
    send(evt);
    if (evt.type === 'done' || evt.type === 'error') res.end();
  };
  job.bus.on('event', onEvent);
  req.on('close', () => job.bus.off('event', onEvent));
}));

/**
 * Signs in to the CMS. The password is verified against Payload before anything
 * is kept, so a typo is reported here rather than halfway through a publish.
 * It is held for this process only unless `remember` is set.
 */
app.post('/api/payload/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const who = await checkLogin(email, password);

  setCredentials(email, password);
  // The address alone is safe to keep and saves retyping; the password is only
  // written to disk when explicitly asked for.
  saveCredentials(email, req.body.remember ? password : '');
  config.payload.email = email;
  config.payload.password = req.body.remember ? password : config.payload.password;

  res.json({ ok: true, email: who.email, remembered: Boolean(req.body.remember) });
}));

app.post('/api/payload/logout', wrap((_req, res) => {
  clearCredentials();
  // Forget the stored password but keep the address, so signing back in is one
  // field. `config` is the live copy the rest of the process reads.
  saveCredentials(config.payload.email || '', '');
  config.payload.password = '';
  res.json({ ok: true });
}));

app.post('/api/publish', wrap(async (req, res) => {
  const messages = [];
  const result = await publish({
    fields: req.body.fields,
    manifestPath: req.body.manifestPath,
    onProgress: (p) => messages.push(p.message),
  });
  res.json({ ...result, messages });
}));

// Brand OTFs live in the website repo next door; if it isn't checked out here
// the stylesheet's fallback stack takes over.
app.use('/fonts', express.static(path.join(ROOT_DIR, '..', 'allofitnow-website', 'frontend', 'public', 'fonts')));
app.use(express.static(path.join(ROOT_DIR, 'web')));

app.listen(config.port, () => {
  console.log(`\n  AOIN page composer  →  http://localhost:${config.port}\n`);
  for (const r of roots) console.log(`  root ${r.label}  ${r.path}`);
  if (!roots.length) console.log('  ! no project roots found — check config.json');
  console.log('');
});
