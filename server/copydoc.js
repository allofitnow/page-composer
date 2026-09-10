import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { inlineHtmlToMarkdown } from './richtext.js';
import { slugify } from './util.js';

export const TAXONOMY = ['REAL-TIME CONTENT', 'SCREENS PRODUCTION', 'MIXED REALITY', 'EQUIPMENT RENTAL'];

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, k) => ENT[k.toLowerCase()] ?? m);
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// `Label: value`, `Label — value`
const KV = /^([A-Za-z][A-Za-z .'\-/]{1,34}?)\s*[:–—]\s*(.+)$/;

/**
 * A run of lines becomes ONE paragraph, except that every line which reads as
 * `Label: value` stands alone. Without this a markdown metadata block (Client /
 * Year / Role on consecutive lines) collapses into a single paragraph and the
 * first key swallows every other field as its value.
 */
function linesToBlocks(raw, type = 'p') {
  const out = [];
  let prose = [];
  const flush = () => {
    if (prose.length) out.push({ type, text: prose.join(' ').replace(/\s+/g, ' ').trim() });
    prose = [];
  };
  for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    if (KV.test(line)) {
      flush();
      out.push({ type, text: line });
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.filter((b) => b.text);
}

/** Flattens a doc into typed blocks: headings drive section detection. */
async function blocksOf(file) {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.docx') {
    // Mammoth drops underline by default (Word writers use it inconsistently),
    // but the site renders <u>, and someone underlining a line in Google Docs
    // means it. Map it back explicitly.
    const { value: html } = await mammoth.convertToHtml({ path: file }, { styleMap: ['u => u'] });
    const out = [];
    const re = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html))) {
      const isHeading = /^h/i.test(m[1]);
      const type = isHeading ? 'heading' : m[1].toLowerCase() === 'li' ? 'li' : 'p';
      // Word writers routinely soft-break inside one paragraph, so a <br> run
      // has to be treated the same way as separate lines in markdown.
      const text = strip(m[2].replace(/<br\s*\/?>/gi, '\n'));
      if (!text) continue;
      if (isHeading) out.push({ type, text: text.replace(/\s+/g, ' ') });
      else {
        // `text` stays plain, because that is what field matching reads. `rich`
        // carries the same content as Markdown, so a write-up keeps the bold,
        // italics, underlines and links the doc was written with.
        const inner = m[2].replace(/<br\s*\/?>/gi, '\n');
        const plain = linesToBlocks(inner.split('\n').map(strip).join('\n'), type);
        const rich = linesToBlocks(inner.split('\n').map(inlineHtmlToMarkdown).join('\n'), type);
        plain.forEach((b, i) => out.push({ ...b, rich: rich[i]?.text }));
      }
    }
    return out;
  }

  return markdownBlocks(fs.readFileSync(file, 'utf8'));
}

/** The Markdown half of blocksOf, reusable for text that has no file behind it. */
function markdownBlocks(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => {
      // A table is the value half of a field in the team's doc template, so it
      // has to survive as structure rather than being flattened to prose.
      if (isTableChunk(b)) {
        const rows = parseMarkdownTable(b);
        return rows.length ? [{ type: 'table', rows, text: rows.map((r) => r.join('  ')).join('\n') }] : [];
      }
      const heading = b.match(/^#{1,6}\s+(.*)$/);
      if (heading) return [{ type: 'heading', text: unescapeMd(heading[1].trim()) }];
      if (/^[-*]\s+/.test(b)) return linesToBlocks(b.replace(/^[-*]\s+/gm, ''), 'li');
      // Markdown is already the rich form; only the plain twin needs unescaping.
      return linesToBlocks(b).map((x) => ({ ...x, rich: x.text, text: unescapeMd(x.text) }));
    });
}

const FIELD_ALIASES = {
  title: 'title', project: 'title', artist: 'title', 'artist/title': 'title', name: 'title',
  slug: 'slug',
  year: 'year',
  // `client`, `role` and `scope` are no longer fields on the Projects
  // collection, so a doc line for them stays deliberately unmapped rather than
  // being silently parsed into somewhere it cannot be published.
  capabilities: 'capabilities', capability: 'capabilities',
  services: 'services', service: 'services',
  tour: 'tour',
  collaborator: 'collaborator', collaborators: 'collaborator',
  // The labels the team's own template uses, once normalised.
  'artist name/project title': 'title', 'project title': 'title', 'artist name': 'title',
  'tour name/subtitle': 'tour', 'tour name': 'tour', subtitle: 'tour',
  summary: 'summary', lede: 'summary', lead: 'summary', 'short summary': 'summary',
  body: 'body', description: 'body',
};

// The real copy docs are built from Google Docs TABLES, not `Label: value`
// lines. Exported to Markdown a field looks like this:
//
//     Year
//
//     | 2024 |
//     | :---- |
//
// so the label is an ordinary paragraph and the value is a one-cell table under
// it. Stats and credits are proper multi-column tables. Everything below exists
// to read that shape, because it is what the team actually writes.

const SEPARATOR_CELL = /^:?-{2,}:?$/;

/** `| a | b |` rows -> [["a","b"], ...], with the `:---` rule dropped. */
function parseMarkdownTable(chunk) {
  const rows = [];
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => unescapeMd(c.trim()));
    if (cells.length && cells.every((c) => SEPARATOR_CELL.test(c) || c === '')) continue;
    rows.push(cells);
  }
  return rows;
}

const isTableChunk = (chunk) =>
  chunk.split('\n').filter((l) => l.trim()).every((l) => l.trim().startsWith('|'));

/** Google Docs escapes `_`, `+` and friends on export; undo that. */
const unescapeMd = (s) => String(s).replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');

/** `[label](url)` -> { text, url }, for a credit whose name carries the link. */
function splitLink(cell) {
  const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(String(cell).trim());
  return m ? { text: m[1].trim(), url: m[2].trim() } : { text: String(cell).trim(), url: '' };
}

/**
 * A label paragraph is matched loosely: docs carry parentheticals and slashes
 * ("Capabilities (Services Rendered)", "Artist Name/Project Title").
 */
const normLabel = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    // A label that was bolded in the Google Doc exports as `**Full Write Up**`,
    // and those markers are part of the text here. Renee Rapp's doc bolded its
    // headings, so the write-up section never opened and the entire body was
    // dropped in silence — nothing was missing, it simply never matched.
    .replace(/^\s*#+\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/[:.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const SECTION_ALIASES = [
  [/^(full )?write[\s-]?up$/i, 'writeup'],
  [/^(production notes|story|the story|long form|narrative)$/i, 'writeup'],
  [/^team credits$/i, 'credits:ALL OF IT NOW'],
  [/^(collaborator|partner) credits$/i, 'credits:COLLABORATORS'],
  [/^press links?$/i, 'ignore'],
  [/^(stats|numbers|by the numbers|key stats)$/i, 'stats'],
  [/^(credits|team|crew)$/i, 'credits'],
  [/^(summary|lede|lead)$/i, 'summary'],
];

const normRole = (v) => {
  const s = String(v).toUpperCase().replace(/\s+/g, ' ').trim();
  return TAXONOMY.find((t) => t === s || t.replace(/-/g, ' ') === s.replace(/-/g, ' ')) || null;
};

/** The section a label paragraph names, if any ("Full Write Up", "Stats"...). */
function sectionForLabel(label) {
  const hit = SECTION_ALIASES.find(([re]) => re.test(label));
  return hit ? hit[1] : null;
}

/**
 * Services arrive as one cell. In a Google Doc they are separate lines, but the
 * Markdown export joins them with plain spaces, so there is no delimiter left to
 * split on. The CMS list is the only thing that knows where one name ends, so
 * they are matched against it longest-first; whatever cannot be matched is kept
 * whole and shown as unmatched on step 04 rather than being guessed at.
 */
function splitKnown(value, names, extraDelims = '') {
  const delims = new RegExp(`[,;\n${extraDelims}]|\\s{2,}`);
  const explicit = value.split(delims).map((v) => v.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit;
  if (!names?.length) return explicit;

  const known = [...names].map((n) => n.trim()).sort((a, b) => b.length - a.length);
  let rest = value.trim();
  const found = [];
  let guard = 0;
  while (rest && guard++ < 64) {
    const hit = known.find((k) => k && rest.toLowerCase().startsWith(k.toLowerCase()));
    if (!hit) break;
    found.push(hit);
    rest = rest.slice(hit.length).trim();
  }
  if (!found.length) return explicit;
  // Anything left over is a name the list does not have; keep it visible.
  if (rest) found.push(rest);
  return found;
}

const splitServices = (value, serviceList) => splitKnown(value, (serviceList || []).map((s) => s.label));

/**
 * Capabilities have the same problem as services and for the same reason: the
 * Markdown export joins what were separate lines with single spaces, so
 * "REAL-TIME CONTENT SCREENS PRODUCTION" arrives as one string with no
 * delimiter left to split on. Matching against the fixed taxonomy is the only
 * thing that knows where one ends.
 */
const splitCapabilities = (value) => splitKnown(value, TAXONOMY, '/').map(normRole).filter(Boolean);

/** Writes one parsed value into the field it belongs to. */
function applyField(fields, field, value, serviceList) {
  if (field === 'capabilities') {
    fields.capabilities = splitCapabilities(value);
  } else if (field === 'services') {
    fields.services = splitServices(value, serviceList);
  } else if (field === 'tour' || field === 'collaborator') {
    fields[field] = value.toUpperCase();
  } else if (field === 'title') {
    fields.title = value.toUpperCase();
  } else {
    fields[field] = value;
  }
}

/**
 * Parses a dropped .docx/.md into the Payload project shape.
 * Returns the fields AND the source blocks tagged with what they mapped to, so
 * the UI can show the mapping side by side and you can correct it.
 */
export async function parseCopyDoc(file, serviceList = []) {
  return { ...fieldsFromBlocks(await blocksOf(file), serviceList), file: path.basename(file) };
}

/**
 * The same parse, from Markdown text that never touched the disk. A file dropped
 * onto the write-up editor arrives as text rather than as a path, and `.docx` is
 * a zip so it cannot come this way at all.
 */
export function parseCopyText(text, serviceList = []) {
  return { ...fieldsFromBlocks(markdownBlocks(String(text || '')), serviceList), file: '' };
}

/** The block walk both entry points share. */
function fieldsFromBlocks(blocks, serviceList = []) {
  const fields = { capabilities: [], stats: [], credits: [], writeup: { lead: '', body: [] } };
  const mapped = [];

  let section = null;
  let creditGroup = null;

  // A label paragraph is only a label if a table follows it; otherwise it is
  // prose. That look-ahead is why this walks by index.
  let pendingLabel = null;

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    let tag = null;

    // ---- the value half of a field, or a stats/credits grid ----
    if (b.type === 'table') {
      const label = pendingLabel ? normLabel(pendingLabel.text) : '';
      pendingLabel = null;
      const rows = b.rows || [];
      const single = rows.length && rows.every((r) => r.length === 1);

      if (label === 'stats' && rows.length >= 2) {
        // Header row names the stats, the row under it holds the values.
        const [head, ...body] = rows;
        for (const row of body) {
          head.forEach((h, i) => {
            const value = (row[i] || '').trim();
            if (h && value) fields.stats.push({ label: h.toUpperCase(), value });
          });
        }
        mapped.push({ ...b, tag: 'stats' });
        continue;
      }

      const creditHit = /^credits:(.+)$/.exec(sectionForLabel(label) || '');
      if (creditHit && rows.length >= 2) {
        // Role | Name | Socials Link
        const [, ...body] = rows;
        const group = { title: creditHit[1], entries: [] };
        for (const row of body) {
          const role = (row[0] || '').trim();
          const who = splitLink(row[1] || '');
          const url = (row[2] || '').trim() || who.url;
          if (role || who.text) group.entries.push({ title: role.toUpperCase(), name: who.text, url });
        }
        if (group.entries.length) fields.credits.push(group);
        mapped.push({ ...b, tag: `credits:${group.title}` });
        continue;
      }

      if (single) {
        const value = rows.map((r) => r[0]).filter(Boolean).join(' ').trim();
        const field = FIELD_ALIASES[label];
        if (field && value) {
          applyField(fields, field, value, serviceList);
          mapped.push({ ...b, tag: field });
          continue;
        }
      }
      mapped.push({ ...b, tag: null });
      continue;
    }

    if (b.type === 'heading') {
      const hit = SECTION_ALIASES.find(([re]) => re.test(b.text.trim()));
      if (hit) {
        section = hit[1];
        creditGroup = null;
        mapped.push({ ...b, tag: `section:${section}` });
        continue;
      }
      if (section === 'credits') {
        creditGroup = { title: b.text.toUpperCase(), entries: [] };
        fields.credits.push(creditGroup);
        mapped.push({ ...b, tag: 'credits[].title' });
        continue;
      }
      // A sub-heading inside the write-up belongs TO the write-up. Ending the
      // section here is what cut Linkin Park's copy off after two paragraphs.
      if (section === 'writeup') {
        fields.writeup.body.push(`## ${b.text}`);
        mapped.push({ ...b, tag: `writeup.body[${fields.writeup.body.length - 1}]` });
        continue;
      }
      section = null;
      mapped.push({ ...b, tag: null });
      continue;
    }

    // A short paragraph naming a section switches section even without a table
    // ("Full Write Up" is a plain line in the template, not a heading).
    const asSection = sectionForLabel(normLabel(b.text));
    if (asSection && b.text.length < 60) {
      pendingLabel = b;
      if (asSection === 'ignore') {
        section = 'ignore';
      } else if (!asSection.startsWith('credits:')) {
        section = asSection;
        creditGroup = null;
      }
      mapped.push({ ...b, tag: `section:${asSection}` });
      continue;
    }

    // A short paragraph naming a field is the label for the table beneath it.
    if (FIELD_ALIASES[normLabel(b.text)] && blocks[bi + 1]?.type === 'table') {
      pendingLabel = b;
      mapped.push({ ...b, tag: `label:${FIELD_ALIASES[normLabel(b.text)]}` });
      continue;
    }

    if (section === 'ignore') {
      mapped.push({ ...b, tag: null });
      continue;
    }

    const kv = b.text.match(KV);
    const key = kv ? kv[1].toLowerCase().trim() : null;
    const val = kv ? kv[2].trim() : null;

    if (section === 'credits' && kv) {
      if (!creditGroup) {
        creditGroup = { title: 'CREDITS', entries: [] };
        fields.credits.push(creditGroup);
      }
      creditGroup.entries.push({ role: kv[1].toUpperCase().trim(), handle: val });
      mapped.push({ ...b, tag: 'credits[].entries' });
      continue;
    }

    if (section === 'stats' && kv) {
      fields.stats.push({ label: kv[1].toUpperCase().trim(), value: val });
      mapped.push({ ...b, tag: 'stats[]' });
      continue;
    }

    if (kv && FIELD_ALIASES[key]) {
      const f = FIELD_ALIASES[key];
      if (f === 'capabilities') {
        fields.capabilities = splitCapabilities(val);
      } else if (f === 'services') {
        // Kept as written: these are matched against the CMS list at publish,
        // which is the only place that knows what exists.
        fields.services = val.split(/[,;]/).map((c) => c.trim()).filter(Boolean);
      } else if (f === 'tour' || f === 'collaborator') {
        fields[f] = val.toUpperCase();
      } else {
        fields[f] = val;
      }
      mapped.push({ ...b, tag: f });
      continue;
    }

    if (section === 'writeup' && b.type === 'p') {
      if (!fields.writeup.lead) {
        fields.writeup.lead = b.rich || b.text;
        tag = 'writeup.lead';
      } else {
        fields.writeup.body.push(b.rich || b.text);
        tag = `writeup.body[${fields.writeup.body.length - 1}]`;
      }
      mapped.push({ ...b, tag });
      continue;
    }

    if (section === 'summary' && b.type === 'p' && !fields.summary) {
      fields.summary = b.text;
      mapped.push({ ...b, tag: 'summary' });
      continue;
    }

    mapped.push({ ...b, tag: null });
  }

  // A doc with no explicit Title: line — take the first heading.
  if (!fields.title) fields.title = blocks.find((b) => b.type === 'heading')?.text || '';
  if (!fields.slug && fields.title) fields.slug = slugify(fields.title);
  if (fields.title) fields.title = fields.title.toUpperCase();
  // `role` is no longer a field on the collection, so it is never derived from
  // capabilities any more — the traffic only ever went the other way.
  if (!fields.capabilities.length && fields.role) fields.capabilities = [fields.role];

  return { fields, blocks: mapped };
}

// Mirrors the required fields on the live Projects collection: title, slug,
// year and capabilities. `image` is required too, but that is the hero you
// pick on step 02, not something the copy doc can supply.
const REQUIRED = ['title', 'slug', 'year'];

export function validate(fields) {
  const missing = REQUIRED.filter((k) => !fields[k] || String(fields[k]).trim() === '');
  if (!fields.capabilities?.length) missing.push('capabilities');
  const errors = [];
  if (fields.role && !TAXONOMY.includes(fields.role)) errors.push(`role "${fields.role}" is not in the taxonomy`);
  for (const c of fields.capabilities || []) {
    if (!TAXONOMY.includes(c)) errors.push(`capability "${c}" is not in the taxonomy`);
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors, required: REQUIRED.length + 1 };
}
