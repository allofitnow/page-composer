// Formatting from a Google Doc through to the Slate value Payload stores.
//
// The supported set is exactly what frontend/src/lib/richtext.ts can render, so
// nothing is parsed that would silently vanish on the site.
import { inlineHtmlToMarkdown, inlineToSlate, paragraphsToSlate } from '../server/richtext.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

// ------------------------------------------------- 1. Word HTML -> Markdown
// This is mammoth's output shape for a Google Doc exported as .docx.
check('bold survives', inlineHtmlToMarkdown('a <strong>bold</strong> word'), 'a **bold** word');
check('italic survives', inlineHtmlToMarkdown('an <em>italic</em> word'), 'an *italic* word');
check('underline round-trips as a tag', inlineHtmlToMarkdown('an <u>underlined</u> word'), 'an <u>underlined</u> word');
check('links keep their href', inlineHtmlToMarkdown('see <a href="https://aoin.com">the site</a>'), 'see [the site](https://aoin.com)');
check('nested marks nest', inlineHtmlToMarkdown('<strong>bold <em>and italic</em></strong>'), '**bold *and italic***');
check('entities are decoded', inlineHtmlToMarkdown('Ben &amp; Jerry&#39;s'), "Ben & Jerry's");
check('unknown tags drop to their text', inlineHtmlToMarkdown('<span class="x">plain</span>'), 'plain');
check('an unclosed tag still balances', inlineHtmlToMarkdown('<strong>oops'), '**oops**');
// Markdown characters in ordinary prose must not become markup on the way back.
check('literal asterisks are escaped', inlineHtmlToMarkdown('2 * 3 * 4'), '2 \\* 3 \\* 4');

// ------------------------------------------------------ 2. Markdown -> Slate
check('plain text is one leaf', inlineToSlate('hello'), [{ text: 'hello' }]);
check('bold becomes a mark', inlineToSlate('a **b** c'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }]);
check('italic becomes a mark', inlineToSlate('a *b* c'), [{ text: 'a ' }, { text: 'b', italic: true }, { text: ' c' }]);
check('underscores are italic too', inlineToSlate('_b_'), [{ text: 'b', italic: true }]);
check('code becomes a mark', inlineToSlate('use `npm start`'), [{ text: 'use ' }, { text: 'npm start', code: true }]);
check('underline becomes a mark', inlineToSlate('<u>u</u>'), [{ text: 'u', underline: true }]);
check('bold inside italic keeps both', inlineToSlate('***x***'), [{ text: 'x', italic: true, bold: true }]);
check('a link becomes an element', inlineToSlate('[AOIN](https://aoin.com)'), [
  { type: 'link', url: 'https://aoin.com', children: [{ text: 'AOIN' }] },
]);
check('marks inside a link survive', inlineToSlate('[**AOIN**](https://aoin.com)'), [
  { type: 'link', url: 'https://aoin.com', children: [{ text: 'AOIN', bold: true }] },
]);
check('an escaped asterisk stays literal', inlineToSlate('2 \\* 3'), [{ text: '2 * 3' }]);
// A stray marker must not eat the rest of the paragraph.
check('an unmatched asterisk is literal', inlineToSlate('2 * 3'), [{ text: '2 * 3' }]);

// --------------------------------------------------- 3. paragraphs -> blocks
check('a paragraph has no type', paragraphsToSlate(['Just prose.']), [{ children: [{ text: 'Just prose.' }] }]);
check('a heading carries its level', paragraphsToSlate(['## The Build']), [
  { type: 'h2', children: [{ text: 'The Build' }] },
]);
check('a blockquote is a blockquote', paragraphsToSlate(['> quoted']), [
  { type: 'blockquote', children: [{ text: 'quoted' }] },
]);
check('a bulleted run becomes a ul', paragraphsToSlate(['- one\n- two']), [
  { type: 'ul', children: [
    { type: 'li', children: [{ text: 'one' }] },
    { type: 'li', children: [{ text: 'two' }] },
  ] },
]);
check('a numbered run becomes an ol', paragraphsToSlate(['1. one\n2. two']), [
  { type: 'ol', children: [
    { type: 'li', children: [{ text: 'one' }] },
    { type: 'li', children: [{ text: 'two' }] },
  ] },
]);
check('empty paragraphs are dropped', paragraphsToSlate(['', '   ', 'real']), [{ children: [{ text: 'real' }] }]);
check('soft-wrapped lines join into one paragraph', paragraphsToSlate(['a stage\nthat reads as one']), [
  { children: [{ text: 'a stage that reads as one' }] },
]);

// ------------------------------------------------------ 4. the whole journey
const wordHtml = 'The <strong>Dinastia</strong> tour used <em>real-time</em> content, see <a href="https://aoin.com">AOIN</a>.';
const md = inlineHtmlToMarkdown(wordHtml);
check('Word HTML -> Markdown', md, 'The **Dinastia** tour used *real-time* content, see [AOIN](https://aoin.com).');
check('…and Markdown -> Slate', paragraphsToSlate([md]), [
  {
    children: [
      { text: 'The ' },
      { text: 'Dinastia', bold: true },
      { text: ' tour used ' },
      { text: 'real-time', italic: true },
      { text: ' content, see ' },
      { type: 'link', url: 'https://aoin.com', children: [{ text: 'AOIN' }] },
      { text: '.' },
    ],
  },
]);

// Every mark and element produced here must be one the site can serialize.
const RENDERABLE_MARKS = new Set(['text', 'bold', 'italic', 'underline', 'code', 'type', 'url', 'newTab', 'children']);
const RENDERABLE_TYPES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'link']);
const walk = (nodes, bad = []) => {
  for (const n of nodes) {
    for (const k of Object.keys(n)) if (!RENDERABLE_MARKS.has(k)) bad.push(k);
    if (n.type && !RENDERABLE_TYPES.has(n.type)) bad.push(`type:${n.type}`);
    if (n.children) walk(n.children, bad);
  }
  return bad;
};
const everything = paragraphsToSlate([
  '# H1', '## H2', '### H3', '> quote', '- a\n- b', '1. a\n2. b',
  'plain **b** *i* `c` <u>u</u> [l](https://x.com)',
]);
check('nothing is emitted that the site cannot render', walk(everything), []);

// mammoth maps a Word/Docs HEADING STYLE to `## `, so a body paragraph someone
// styled as Heading 2 arrives indistinguishable from a real heading — which is
// how three write-ups reached the site as nothing but headings. Length separates
// them cleanly: on the live CMS real headings run 16-20 characters and the
// mis-styled ones 499-850.
const longLine = "For Renee Rapp's Bite Me Tour, All Of It Now worked alongside our client to develop the creative and technical approach for a show built almost entirely around real-time Notch camera content.";
check('a short ## line is a heading', paragraphsToSlate(['## AOIN Involvement'])[0].type, 'h2');
check('a paragraph-length ## line is a paragraph', paragraphsToSlate([`## ${longLine}`])[0].type, undefined);
check('...and loses its hashes on the way', paragraphsToSlate([`## ${longLine}`])[0].children[0].text.slice(0, 14), 'For Renee Rapp');
check('the cutoff is where it says it is', [
  paragraphsToSlate(['## ' + 'x'.repeat(120)])[0].type,
  paragraphsToSlate(['## ' + 'x'.repeat(121)])[0].type,
], ['h2', undefined]);

console.log(failures ? `\n${failures} FAILED` : '\nall rich-text checks passed');
process.exitCode = failures ? 1 : 0;
