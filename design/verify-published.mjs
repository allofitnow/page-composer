// Checks what a project actually looks like in the CMS after a publish.
//
// Publishing omits an empty field rather than blanking it, which is right — an
// update must never destroy copy someone typed in the admin — but it also means
// a field that failed to parse looks exactly like a field nobody touched. The
// only way to know a publish landed is to read it back.
//
//   node design/verify-published.mjs renee-rapp
//   node design/verify-published.mjs renee-rapp --url http://192.168.30.245
//
// Exits non-zero if the project is missing or the CMS cannot be reached, so it
// can be chained after a publish.
import fs from 'node:fs';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const urlFlag = args.indexOf('--url');
const base = (
  urlFlag >= 0
    ? args[urlFlag + 1]
    : (() => {
        try {
          return JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).payload.url;
        } catch {
          return 'http://192.168.30.245';
        }
      })()
).replace(/\/+$/, '');

if (!slug) {
  console.error('usage: node design/verify-published.mjs <slug> [--url http://host]');
  process.exitCode = 2;
} else {
  const get = async (path, ms = 8000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(base + path, { signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  };

  let doc;
  try {
    const res = await get(`/api/projects?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=1`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    doc = (await res.json()).docs?.[0];
  } catch (err) {
    // Distinguish "the CMS said no" from "nothing on this network answered" —
    // they need completely different people to fix.
    const why = err.name === 'AbortError' || /fetch failed/i.test(err.message)
      ? `could not reach ${base}. Check you are on the network that routes to it —\n   \`tracert -d ${base.replace(/^https?:\/\//, '')}\` should stay on 192.168.x, not jump to a public hop.`
      : err.message;
    console.error(`CANNOT VERIFY: ${why}`);
    process.exitCode = 1;
  }

  if (doc === undefined && process.exitCode !== 1) {
    console.error(`NOT FOUND: no project with slug "${slug}" at ${base}`);
    process.exitCode = 1;
  } else if (doc) {
    const rows = doc.gallery || [];
    const paras = doc.writeup || [];
    const line = (k, v, warn) => console.log(`  ${warn ? '!' : ' '} ${k.padEnd(13)} ${v}`);

    console.log(`${doc.title}  (${doc.slug})  ${base}/work/${doc.slug}/`);
    console.log(`  updated ${doc.updatedAt}\n`);
    line('code/status', `${doc.code} / ${doc.status}${doc.featured ? ' / FEATURED' : ''}`);
    line('year / tour', `${doc.year || '—'} / ${doc.tour || '—'}`, !doc.year);
    line('collaborator', doc.collaborator || '—');
    line('image', doc.image ? 'set' : 'MISSING — required by the collection', !doc.image);
    line('summary', doc.summary ? `${doc.summary.length} chars` : 'empty', !doc.summary);
    // The one that silently did nothing on Renee Rapp.
    line('writeup', paras.length ? `${paras.length} blocks (${paras.map((b) => b.type || 'p').join(' ')})` : 'EMPTY — the copy did not transfer', !paras.length);
    line('capabilities', (doc.capabilities || []).join(', ') || 'none', !(doc.capabilities || []).length);
    line('services', (doc.services || []).map((s) => s.label || s).join(', ') || 'none');
    line('stats', `${(doc.stats || []).length}`);
    line('credits', `${(doc.credits || []).length} groups, ${(doc.credits || []).reduce((n, c) => n + (c.entries || []).length, 0)} entries`);
    line('gallery', `${rows.length} rows, ${rows.reduce((n, r) => n + (r.images || []).length, 0)} images — ${rows.map((r) => r.layout).join(', ') || 'none'}`, !rows.length);

    // The page only exists if Payload's afterChange hook fired and Astro rebuilt.
    try {
      const page = await get(`/work/${doc.slug}/`, 15000);
      const html = await page.text();
      console.log();
      line('rendered page', `${page.status}${page.ok ? '' : ' — the Astro rebuild may not have run'}`, !page.ok);
      if (page.ok && /\*[A-Za-z]/.test(html.replace(/<[^>]*>/g, ''))) {
        line('markdown leak', 'literal * in the rendered text — a plain-text field holds markdown', true);
      }
    } catch {
      console.log();
      line('rendered page', 'could not fetch', true);
    }
  }
}
