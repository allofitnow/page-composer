// Exercises the real gallery-row logic out of web/app.js, without a browser.
// It slices the shipped source rather than copying it, so this cannot drift.
//
// The composer's gallery must be expressible in Payload's `gallery` field, which
// offers exactly five layouts. Anything the rail can produce that the CMS cannot
// store is a bug, so most of what follows is about staying inside that set.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

const slice = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not slice ${startMarker}`);
  return src.slice(a, b);
};

const code = [
  slice('// The gallery is a list of ROWS', '/** Mirrors server/util.js buildName'),
  slice('/** Where a given asset sits in the rows', 'function roleOf('),
  slice('/** Removes one tile, shrinking', 'function railRow('),
  slice('// A free-form ratio has nowhere to go', 'function divider('),
].join('\n');

const ctx = { state: { gallery: [] }, console };
vm.createContext(ctx);
const EXPORTS =
  '({ LAYOUTS, SEAM_ORDER, SEAM_LEFT, DEFAULT_LAYOUT, layoutOf, slotsFor, spansFor, aspectFor, alignEndFor,' +
  ' normaliseGallery, flatTiles, galleryCount, removeTile, insertIntoRow, moveTile, setLayout,' +
  ' layoutsForCount, findRel, appendTile })';
vm.runInContext(code + '\n;' + EXPORTS, ctx);
const api = vm.runInContext(EXPORTS, ctx);

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

const shape = (rows) => rows.map((r) => [r.layout, r.items.map((i) => i.rel)]);
const row = (layout, ...rels) => ({ layout, items: rels.map((rel) => ({ rel })) });

// 1. Every layout the composer can emit must exist in the CMS, with the slot
//    count and geometry the site's own CSS uses.
const CMS = {
  full: [12],
  'two-up': [6, 6],
  'split-8-4': [8, 4],
  'split-5-7': [5, 7],
  'three-up': [4, 4, 4],
  // Full width comes in four heights so a row can match its picture. 16/7 was
  // the only one, and it fits almost nothing: of 125 media docs, 122 are taller
  // than it and lose their top and bottom.
  'full-16-9': [12],
  'full-2-1': [12],
  'full-3-1': [12],
};
check('layout set matches the CMS exactly', Object.keys(api.LAYOUTS).sort(), Object.keys(CMS).sort());
for (const [name, spans] of Object.entries(CMS)) {
  check(`${name} spans`, api.spansFor(name), spans);
  check(`${name} slots match its spans`, api.slotsFor(name), spans.length);
  check(`${name} fills 12 columns`, spans.reduce((a, b) => a + b, 0), 12);
}

// 2. The aspects and baseline alignment are the site's, not ours.
check('split-8-4 is 16:9 then 1:1', [api.aspectFor('split-8-4', 0), api.aspectFor('split-8-4', 1)], ['16 / 9', '1 / 1']);
check('split-5-7 is 4:3 then 16:9', [api.aspectFor('split-5-7', 0), api.aspectFor('split-5-7', 1)], ['4 / 3', '16 / 9']);
// Every full-width height, and these MUST equal the CSS in ProjectPage.astro.
// `full` used to be null here while the site cropped it to 16/7, so previz
// showed an uncropped image and the site published a cropped one.
check('the four full-width heights match the site', [
  api.aspectFor('full-16-9', 0),
  api.aspectFor('full-2-1', 0),
  api.aspectFor('full', 0),
  api.aspectFor('full-3-1', 0),
], ['16 / 9', '2 / 1', '16 / 7', '3 / 1']);
check('the wide-right slot sits on the baseline', [api.alignEndFor('split-8-4', 1), api.alignEndFor('split-5-7', 1)], [true, true]);
check('the left slot never does', [api.alignEndFor('split-8-4', 0), api.alignEndFor('two-up', 1)], [false, false]);

// 3. Galleries saved before layouts existed were a flat list of spans. They must
//    survive, folded into the nearest legal rows.
check(
  'legacy 8/4 + full + 5/7 folds into real layouts',
  shape(
    api.normaliseGallery([
      { rel: 'a', span: 8 }, { rel: 'b', span: 4 },
      { rel: 'c', span: 12 },
      { rel: 'd', span: 5 }, { rel: 'e', span: 7 },
    ])
  ),
  [['split-8-4', ['a', 'b']], ['full', ['c']], ['split-5-7', ['d', 'e']]]
);
check(
  'a legacy free-form ratio snaps to a layout with the same slot count',
  shape(api.normaliseGallery([{ rel: 'a', span: 9 }, { rel: 'b', span: 3 }])),
  [['two-up', ['a', 'b']]]
);
check('rows already in the new shape pass through', shape(api.normaliseGallery([row('three-up', 'a', 'b', 'c')])), [
  ['three-up', ['a', 'b', 'c']],
]);
check('normalising drops empty rows', api.normaliseGallery([{ layout: 'full', items: [] }]), []);

// 4. The rail is a stack: one click, one row. It used to pair every second
//    click into a split automatically, which meant clicking a tile could move
//    the previous one, and getting back out took a drag. Splits are made on
//    purpose now, so clicking must never make one.
let g = [];
for (const rel of ['a', 'b', 'c', 'd']) g = api.appendTile(g, rel);
check('clicking four tiles gives four full-width rows', shape(g), [
  ['full', ['a']],
  ['full', ['b']],
  ['full', ['c']],
  ['full', ['d']],
]);
check('clicking never disturbs a row already built', shape(api.appendTile([row('split-8-4', 'a', 'b')], 'c')), [
  ['split-8-4', ['a', 'b']],
  ['full', ['c']],
]);
// ...and a tile can always be pulled back out of a split into its own row,
// which is the only way out now that clicking does not undo one.
ctx.state.gallery = [row('split-8-4', 'a', 'b'), row('full', 'c')];
check('dragging out of a split leaves the split behind as full', shape(api.moveTile({ row: 0, slot: 1 }, { kind: 'gap', at: 0 })), [
  ['full', ['b']],
  ['full', ['a']],
  ['full', ['c']],
]);
check('dragging out to the end of the stack', shape(api.moveTile({ row: 0, slot: 0 }, { kind: 'gap', at: -1 })), [
  ['full', ['b']],
  ['full', ['c']],
  ['full', ['a']],
]);

// 5. Dropping a tile onto a row grows that row's layout.
ctx.state.gallery = [row('full', 'a'), row('full', 'b')];
check('dropping onto a full row makes it two-up', shape(api.moveTile({ row: 1, slot: 0 }, { kind: 'cell', row: 0, slot: 0, side: 'right' })), [
  ['two-up', ['a', 'b']],
]);

ctx.state.gallery = [row('full', 'a'), row('full', 'b')];
check('dropping on the left half puts the incoming tile first', shape(api.moveTile({ row: 1, slot: 0 }, { kind: 'cell', row: 0, slot: 0, side: 'left' })), [
  ['two-up', ['b', 'a']],
]);

ctx.state.gallery = [row('split-8-4', 'a', 'b'), row('full', 'c')];
check('a two-image row grows to three-up', shape(api.moveTile({ row: 1, slot: 0 }, { kind: 'cell', row: 0, slot: 1, side: 'right' })), [
  ['three-up', ['a', 'b', 'c']],
]);

// 5b. Three-up is as wide as the CMS goes — a fourth tile must not be swallowed.
ctx.state.gallery = [row('three-up', 'a', 'b', 'c'), row('full', 'd')];
const full4 = api.moveTile({ row: 1, slot: 0 }, { kind: 'cell', row: 0, slot: 0, side: 'right' });
check('a fourth image gets its own row rather than vanishing', shape(full4), [
  ['three-up', ['a', 'b', 'c']],
  ['full', ['d']],
]);
check('no row ever holds more images than its layout has slots', full4.every((r) => r.items.length === api.slotsFor(r.layout)), true);

// 6. Dropping between rows reorders without changing any arrangement.
ctx.state.gallery = [row('split-8-4', 'a', 'b'), row('full', 'c')];
check('gap drop moves a tile out to its own row', shape(api.moveTile({ row: 0, slot: 1 }, { kind: 'gap', at: 0 })), [
  ['full', ['b']],
  ['full', ['a']],
  ['full', ['c']],
]);

// 7. Removing a tile shrinks the row it leaves behind.
check('removing from three-up leaves two-up', shape(api.removeTile([row('three-up', 'a', 'b', 'c')], 0, 2)), [['two-up', ['a', 'b']]]);
check('removing the last tile deletes the row', api.removeTile([row('full', 'a')], 0, 0), []);

// 8. The seam can only ever land on a layout the CMS has.
check('seam order is the two-image layouts, widening left', api.SEAM_ORDER, ['split-5-7', 'two-up', 'split-8-4']);
check('seam positions are 5, 6, 8 columns', api.SEAM_LEFT, [5, 6, 8]);
check('every seam stop is a real layout', api.SEAM_ORDER.every((l) => l in CMS), true);
check('setLayout leaves the images alone', shape(api.setLayout([row('two-up', 'a', 'b')], 0, 'split-5-7')), [['split-5-7', ['a', 'b']]]);

// 8b. The aspects above are a COPY of the site's CSS, and a copy can drift —
//     that is exactly how previz came to show an uncropped full-width image
//     while the site published it cropped to 16/7. When the website repo is
//     checked out beside this one, read its CSS and compare for real.
const SITE = new URL('../../allofitnow-website/frontend/src/components/project/ProjectPage.astro', import.meta.url);
if (fs.existsSync(SITE)) {
  const css = fs.readFileSync(SITE, 'utf8');
  const drift = [];
  for (const name of Object.keys(api.LAYOUTS)) {
    for (let slot = 0; slot < api.slotsFor(name); slot++) {
      const ours = api.aspectFor(name, slot);
      if (!ours) continue;
      // Single-slot rows are ".pp__gRow--<name> .pp__g {...}"; multi-slot rows
      // qualify the slot as ".pp__g--slot<n>".
      const row = '\\.pp__gRow--' + name.replace(/[-]/g, '\\-') + '\\s';
      const tail = '\\s*\\{[^}]*aspect-ratio:\\s*([0-9]+\\s*/\\s*[0-9]+)';
      // A multi-slot row may size each slot separately (split-8-4) or all of
      // them with a single rule (two-up, three-up), so try the specific form
      // first and fall back to the one that covers the whole row.
      const perSlot = new RegExp(row + '*\\.pp__g--slot' + (slot + 1) + tail);
      const whole = new RegExp(row + '*\\.pp__g' + tail);
      const m = perSlot.exec(css) || whole.exec(css);
      if (!m) {
        drift.push(`${name} slot${slot + 1}: no aspect-ratio rule found on the site`);
        continue;
      }
      const theirs = m[1].replace(/\s+/g, ' ').trim();
      if (theirs !== ours) drift.push(`${name} slot${slot + 1}: composer "${ours}" vs site "${theirs}"`);
    }
  }
  check('every aspect matches the live site CSS', drift, []);
} else {
  console.log('skip  site CSS cross-check (allofitnow-website not checked out beside this repo)');
}

// 9. The layout picker must only offer layouts that fit the row's image count.
check('one image → the four full-width heights', api.layoutsForCount(1).sort(), ['full', 'full-16-9', 'full-2-1', 'full-3-1']);
check('two images → the three split ratios', api.layoutsForCount(2).sort(), ['split-5-7', 'split-8-4', 'two-up']);
check('three images → only three-up', api.layoutsForCount(3), ['three-up']);

// 10. Reading order drives filenames and the published row order.
const rows = [row('split-8-4', 'a', 'b'), row('full', 'c')];
check('flatTiles walks rows then slots', api.flatTiles(rows).map((t) => [t.rel, t.row, t.slot]), [
  ['a', 0, 0], ['b', 0, 1], ['c', 1, 0],
]);
check('galleryCount counts images, not rows', api.galleryCount(rows), 3);
check('findRel locates a tile by asset', api.findRel(rows, 'b'), { row: 0, slot: 1 });

console.log(failures ? `\n${failures} FAILED` : '\nall gallery-layout checks passed');
process.exit(failures ? 1 : 0);
