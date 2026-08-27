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

  // A heading that runs to a paragraph is not a heading.
  // 
  //    mammoth maps a Word/Docs HEADING STYLE to `## `, so a body paragraph that
  //    someone styled as Heading 2 in the doc arrives here indistinguishable from a
  //    real heading — and three published write-ups came out as nothing but
  //    headings because of it (Renée Rapp, Bad Omens, GRiZ).
  // 
  //    The two populations do not overlap. Measured on the live CMS: real headings
  //    run 16-20 characters ("AOIN Involvement", "Technical Challenges"); the
  //    mis-styled ones run 499-850. 120 sits between them with room either side.
  const heading = /^(#{1,6})\s+(.*)$/.exec(joined);
  // The marker comes off either way — a demoted block must not publish with its
  // hashes showing, which would be worse than the heading it replaced.
  const body = heading ? heading[2].trim() : joined;
  if (heading && body.length <= MAX_HEADING) {
    return { type: `h${heading[1].length}`, children: inlineToSlate(body) };
  }

  if (/^>\s+/.test(body)) return { type: 'blockquote', children: inlineToSlate(body.replace(/^>\s+/, '')) };

  // A block with no type is a paragraph, which is what Slate expects.
  return { children: inlineToSlate(body) };
}

/** The stored paragraph list → the Slate value Payload holds for `writeup`. */
/** The longest a `## ` block may be and still be treated as a heading. */
const MAX_HEADING = 120;

export function paragraphsToSlate(paragraphs) {
  return (paragraphs || [])
    .map((p) => blockToSlate(p))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Slate -> Markdown. The inverse of paragraphsToSlate/inlineToSlate above, used
// when a project is opened FROM the CMS rather than built from a copy doc: the
// stored `writeup` has to come back as the plain paragraph list step 04 edits.
//
// It is deliberately not a general Slate renderer. It inverts exactly the shapes
// blockToSlate can produce, and reports anything else as `dropped` rather than
// guessing -- see slateToParagraphs.
// ---------------------------------------------------------------------------

/** One inline leaf/element back to Markdown. Mirrors inlineToSlate's grammar. */
function slateInlineToMarkdown(nodes) {
  return (nodes || [])
    .map((n) => {
      if (n && n.type === 'link') {
        return `[${slateInlineToMarkdown(n.children)}](${n.url || ''})`;
      }
      let t = escapeMd(String(n?.text ?? ''));
      if (!t) return '';
      // Order mirrors the parser: the both-marks case is written `***x***`, which
      // inlineToSlate tests before `**`, so it round-trips to the same leaf.
      if (n.bold && n.italic) t = `***${t}***`;
      else if (n.bold) t = `**${t}**`;
      else if (n.italic) t = `*${t}*`;
      if (n.underline) t = `<u>${t}</u>`;
      if (n.code) t = `\`${t}\``;
      return t;
    })
    .join('');
}

/** A list block (`ul`/`ol`) back to one marker-prefixed line per item. */
function listToMarkdown(node) {
  const ordered = node.type === 'ol';
  return (node.children || [])
    .map((li, i) => `${ordered ? `${i + 1}.` : '-'} ${slateInlineToMarkdown(li?.children)}`)
    .join('\n');
}

/**
 * The CMS `writeup` value -> { paragraphs, dropped }.
 *
 * `dropped` counts blocks that CANNOT survive the trip -- in practice `upload`
 * nodes, the inline images and clips an editor dropped into the prose from the
 * Payload admin. There is no paragraph text that represents one, so re-publishing
 * a hydrated write-up would silently delete them. The count is returned so the
 * caller can keep the original Slate and only send the converted paragraphs when
 * the operator has actually edited them (see cmsProjectFields).
 */
export function slateToParagraphs(value) {
  const paragraphs = [];
  let dropped = 0;
  for (const node of Array.isArray(value) ? value : []) {
    if (!node || typeof node !== 'object') continue;
    const type = node.type;
    if (type === 'ul' || type === 'ol') {
      paragraphs.push(listToMarkdown(node));
      continue;
    }
    const heading = /^h([1-6])$/.exec(type || '');
    if (heading) {
      paragraphs.push(`${'#'.repeat(Number(heading[1]))} ${slateInlineToMarkdown(node.children)}`);
      continue;
    }
    if (type === 'blockquote') {
      paragraphs.push(`> ${slateInlineToMarkdown(node.children)}`);
      continue;
    }
    if (type === 'upload' || (type && type !== 'paragraph')) {
      dropped++;
      continue;
    }
    const text = slateInlineToMarkdown(node.children);
    if (text.trim()) paragraphs.push(text);
  }
  return { paragraphs, dropped };
}
