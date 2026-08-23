// Formatting, from a Google Doc through to the published page.
//
// A .docx carries its formatting (bold, italic, underline, links, headings,
// lists) and mammoth already hands it to us as HTML — the parser used to throw
// all of it away. This module keeps it, using **Markdown as the interchange
// format** for three reasons:
//
//   1. it survives in a plain <textarea>, so step 04 stays editable;
//   2. Google Docs can export Markdown directly, so a .md drop needs no
//      conversion at all;
//   3. one converter (Markdown → Slate) then serves both sources.
//
// The supported set is deliberately exactly what the site can render — see
// frontend/src/lib/richtext.ts. Strikethrough is NOT included: Payload's editor
// offers it, but the site's serializer ignores it, so parsing it would quietly
// drop formatting somebody could see in the CMS. Underline has no Markdown
// syntax, so it round-trips as a literal <u> tag.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" };
const decode = (s) =>
  String(s).replace(/&(#?\w+);/g, (m, e) => (ENTITIES[e] ? ENTITIES[e] : /^#\d+$/.test(e) ? String.fromCharCode(Number(e.slice(1))) : m));

/** Characters that would otherwise be read back as markup. */
const escapeMd = (s) => s.replace(/([\\`*_[\]])/g, '\\$1');

/**
 * The inline half of a Word paragraph — `<strong>`, `<em>`, `<u>`, `<code>` and
 * `<a href>` — as Markdown. Anything else is dropped to its text.
 */
export function inlineHtmlToMarkdown(html) {
  let out = '';
  // A tiny tag walker: enough for mammoth's output, which is clean and shallow.
  const re = /<(\/?)(strong|b|em|i|u|code|a)\b([^>]*)>|<[^>]+>|([^<]+)/gi;
  const open = [];
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tag, attrs, text] = m;
    if (text !== undefined) {
      out += escapeMd(decode(text));
      continue;
    }
    if (!tag) continue; // some other tag — ignore it, keep its text
    const name = tag.toLowerCase();
    if (closing) {
      const last = open.pop();
      if (!last) continue;
      out += last.close;
      continue;
    }
    if (name === 'strong' || name === 'b') {
      out += '**';
      open.push({ close: '**' });
    } else if (name === 'em' || name === 'i') {
      out += '*';
      open.push({ close: '*' });
    } else if (name === 'u') {
      out += '<u>';
      open.push({ close: '</u>' });
    } else if (name === 'code') {
      out += '`';
      open.push({ close: '`' });
    } else if (name === 'a') {
      const href = /href\s*=\s*"([^"]*)"/i.exec(attrs || '') || /href\s*=\s*'([^']*)'/i.exec(attrs || '');
      out += '[';
      open.push({ close: `](${decode(href ? href[1] : '')})` });
    }
  }
  // A doc can leave a tag unclosed; close them so the Markdown stays balanced.
  while (open.length) out += open.pop().close;
  return out.replace(/[ \t]+/g, ' ').trim();
}

// ---------------------------------------------------------------- to Slate

/**
 * Inline Markdown → Slate leaves. Links become element nodes, everything else
 * is a leaf carrying marks.
 */
export function inlineToSlate(md) {
  const nodes = [];
  let text = '';
  const marks = {};
  const push = () => {
    if (text) nodes.push({ text, ...marks });
    text = '';
  };

  for (let i = 0; i < md.length; i++) {
    const rest = md.slice(i);

    if (md[i] === '\\' && i + 1 < md.length) {
      text += md[i + 1];
      i++;
      continue;
    }

    const link = /^\[((?:\\.|[^\]])*)\]\(([^)]*)\)/.exec(rest);
    if (link) {
      push();
      const inner = inlineToSlate(link[1]);
      nodes.push({ type: 'link', url: link[2], children: inner.length ? inner : [{ text: '' }] });
      i += link[0].length - 1;
      continue;
    }

    const u = /^<u>([\s\S]*?)<\/u>/i.exec(rest);
    if (u) {
      push();
      for (const leaf of inlineToSlate(u[1])) nodes.push({ ...leaf, underline: true });
      i += u[0].length - 1;
      continue;
    }

    // `***x***` is both marks at once. It has to be tested before `**`, which
    // would otherwise close on the wrong pair and leave a stray asterisk.
    if (rest.startsWith('***')) {
      const end = md.indexOf('***', i + 3);
      if (end > i + 2) {
        push();
        for (const leaf of inlineToSlate(md.slice(i + 3, end))) nodes.push({ ...leaf, italic: true, bold: true });
        i = end + 2;
        continue;
      }
    }

    if (rest.startsWith('**')) {
      const end = md.indexOf('**', i + 2);
      if (end > i + 1) {
        push();
        for (const leaf of inlineToSlate(md.slice(i + 2, end))) nodes.push({ ...leaf, bold: true });
        i = end + 1;
        continue;
      }
    }

    if ((md[i] === '*' || md[i] === '_') && md[i + 1] !== md[i]) {
      const end = md.indexOf(md[i], i + 1);
      if (end > i) {
        push();
        for (const leaf of inlineToSlate(md.slice(i + 1, end))) nodes.push({ ...leaf, italic: true });
        i = end;
        continue;
      }
    }

    if (md[i] === '`') {
      const end = md.indexOf('`', i + 1);
      if (end > i) {
        push();
        nodes.push({ text: md.slice(i + 1, end), code: true });
        i = end;
        continue;
      }
    }

    text += md[i];
  }
  push();
  return nodes.length ? nodes : [{ text: '' }];
}

const listItems = (lines, re) =>
  lines.map((l) => ({ type: 'li', children: inlineToSlate(l.replace(re, '').trim()) }));

/**
 * One stored paragraph → one Slate block. A paragraph may itself hold a list,
 * because that is how a bulleted run out of a Word doc arrives.
 */
function blockToSlate(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) return null;

  const bullet = /^\s*[-*]\s+/;
  const numbered = /^\s*\d+[.)]\s+/;

  if (lines.every((l) => bullet.test(l))) return { type: 'ul', children: listItems(lines, bullet) };
  if (lines.every((l) => numbered.test(l))) return { type: 'ol', children: listItems(lines, numbered) };

  const joined = lines.join(' ');

  const heading = /^(#{1,6})\s+(.*)$/.exec(joined);
  if (heading) return { type: `h${heading[1].length}`, children: inlineToSlate(heading[2].trim()) };

  if (/^>\s+/.test(joined)) return { type: 'blockquote', children: inlineToSlate(joined.replace(/^>\s+/, '')) };

  // A block with no type is a paragraph, which is what Slate expects.
  return { children: inlineToSlate(joined) };
}

/** The stored paragraph list → the Slate value Payload holds for `writeup`. */
export function paragraphsToSlate(paragraphs) {
  return (paragraphs || [])
    .map((p) => blockToSlate(p))
    .filter(Boolean);
}
