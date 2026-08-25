import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { config } from './config.js';
import { getProject, invalidate, decodeId, resolveRel } from './scan.js';
import { buildName, safeJoin } from './util.js';
import { ffmpeg, probe } from './ffmpeg.js';

const jobs = new Map();

export const getJob = (id) => jobs.get(id);

/**
 * Works out every output filename up front so the UI can show the full plan
 * (and catch collisions) before a single byte is written.
 */
export function plan({ project, base, items, outDir }) {
  const groups = new Map();
  for (const it of items) {
    const desc = it.description || (it.role === 'gallery' ? 'gallery' : it.role);
    groups.set(desc, (groups.get(desc) || 0) + 1);
  }
  const seen = new Map();

  return items.map((it) => {
    const desc = it.description || (it.role === 'gallery' ? 'gallery' : it.role);
    const idx = seen.get(desc) || 0;
    seen.set(desc, idx + 1);
    const asset = project.assets.find((a) => a.rel === it.rel);
    if (!asset) throw new Error(`asset not in project: ${it.rel}`);
    const ext = asset.kind === 'video' ? 'mp4' : 'webp';
    const output = buildName(base, desc, idx, groups.get(desc), ext);
    return {
      rel: it.rel,
      role: it.role,
      description: desc,
      layout: it.layout || null,
      row: it.row ?? null,
      slot: it.slot ?? null,
      // A trim that cuts nothing is dropped here rather than in the encoder, so
      // the manifest does not claim a clip was trimmed.
      trim: it.trim && (it.trim.in > 0 || it.trim.out != null) ? it.trim : null,
      kind: asset.kind,
      source: resolveRel(decodeId(project.id), it.rel),
      sourceName: asset.name,
      bytesIn: asset.size,
      output,
      outputPath: path.join(outDir, output),
      exists: fs.existsSync(path.join(outDir, output)),
    };
  });
}

async function convertImage(step, role) {
  const r = config.recipe;
  const img = sharp(step.source, { failOn: 'none' }).rotate();
  if (role === 'thumb') {
    img.resize(r.thumb.width, r.thumb.height, { fit: 'cover', position: 'attention', withoutEnlargement: true });
    img.webp({ quality: r.thumb.quality });
  } else {
    const spec = role === 'hero' ? r.hero : r.gallery;
    img.resize(spec.maxWidth, null, { withoutEnlargement: true });
    img.webp({ quality: spec.quality });
  }
  await img.toFile(step.outputPath);
}

async function convertVideo(step) {
  const v = config.recipe.video;
  // `-ss` goes BEFORE `-i`, which makes it an input seek — ffmpeg jumps to the
  // keyframe instead of decoding everything up to it, so trimming the head of a
  // 40-minute master costs nothing. The tail is `-t <duration>` after the input,
  // not `-to`: with an input seek in play `-to` has meant different things in
  // different ffmpeg versions, while `-t` has always been "this many seconds
  // from where we started".
  const cut = [];
  if (step.trim) {
    const start = Math.max(0, Number(step.trim.in) || 0);
    // Six decimals, not three: the front end aims half a frame past each
    // boundary, and at 60fps that margin is 0.0083s — three decimals can eat
    // most of it, and at 120fps all of it.
    if (start > 0) cut.push('-ss', start.toFixed(6));
    if (step.trim.out != null) {
      const dur = Number(step.trim.out) - start;
      if (dur > 0) cut.push('-t', dur.toFixed(6));
    }
  }
  await ffmpeg([
    '-y',
    ...cut,
    '-i', step.source,
    '-vf', `scale='min(${v.maxWidth},iw)':-2`,
    '-c:v', 'libx264',
    '-crf', String(v.crf),
    '-preset', v.preset,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', v.audio,
    step.outputPath,
  ]);
}

export function startCompose({ projectId, base, items, outDir: outDirRel }) {
  const project = getProject(projectId);
  const outDir = outDirRel ? safeJoin(project.dir, outDirRel) : project.dir;
  fs.mkdirSync(outDir, { recursive: true });

  const steps = plan({ project, base, items, outDir });
  const id = crypto.randomUUID();
  const bus = new EventEmitter();
  const job = {
    id,
    bus,
    done: false,
    error: null,
    project: { id: projectId, folder: project.folder, dir: project.dir },
    outDir,
    base,
    steps: steps.map((s) => ({ ...s, status: 'queued', bytesOut: 0, message: '' })),
    log: [],
  };
  jobs.set(id, job);

  const emit = (type, payload) => {
    const evt = { type, ...payload };
    if (type === 'log') job.log.push(payload.message);
    bus.emit('event', evt);
  };

  (async () => {
    const ts = () => new Date().toTimeString().slice(0, 8);
    emit('log', { message: `${ts()}  writing into ${outDir}` });

    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      step.status = 'running';
      emit('step', { index: i, step });
      emit('log', { message: `${ts()}  ${step.sourceName} -> ${step.output}` });
      try {
        if (step.kind === 'video') {
          const meta = await probe(step.source);
          if (meta) emit('log', { message: `${ts()}  transcoding ${meta.width}x${meta.height} ${meta.codec_name} to h264` });
          await convertVideo(step);
        } else {
          await convertImage(step, step.role);
        }
        step.bytesOut = fs.statSync(step.outputPath).size;
        step.status = 'done';
      } catch (err) {
        step.status = 'failed';
        step.message = String(err.message || err).split('\n').slice(-3).join(' ');
        emit('log', { message: `${ts()}  FAILED ${step.output} — ${step.message}` });
      }
      emit('step', { index: i, step });
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      project: project.folder,
      base,
      outDir,
      convention: 'project-name-tour_description##',
      note: 'Source files are untouched. Delete an output and re-compose to regenerate it.',
      items: job.steps.map((s) => ({
        role: s.role,
        description: s.description,
        layout: s.layout,
        row: s.row,
        slot: s.slot,
        source: s.rel,
        output: s.output,
        kind: s.kind,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        status: s.status,
      })),
    };
    const manifestPath = path.join(outDir, '_compose-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    emit('log', { message: `${ts()}  wrote _compose-manifest.json — ${manifest.items.length} mappings, originals untouched` });

    invalidate(project.dir);
    job.done = true;
    emit('done', { steps: job.steps, manifestPath });
  })().catch((err) => {
    job.done = true;
    job.error = String(err.message || err);
    emit('error', { message: job.error });
  });

  return job;
}
