// Adding new assets to a page that is ALREADY published.
//
// One thing can go badly wrong here and it goes wrong silently, on a live site:
// composed filenames are positional (`{base}_gallery03.mp4` is whatever sat
// third), and the upload matches on filename — so an addition that restarted
// the count at 01 would REPLACE a published picture with a different one, in
// place, under a name every page already points at.
//
// Everything below is about that. The offset has to be right, the number has to
// be written even for a lone addition, and the three implementations of the
// name — Rust, Node and the prediction the UI shows — have to agree, because the
// UI's guard compares its own prediction against what the CMS holds and a
// disagreement would wave the collision straight through.
//
// The source is sliced out of the shipped files rather than copied, so this
// cannot drift away from what actually runs.
import fs from 'node:fs';
import vm from 'node:vm';
import { buildName } from '../server/util.js';

const appSrc = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const rustSrc = fs.readFileSync(new URL('../src-tauri/src/compose.rs', import.meta.url), 'utf8');
const nodeSrc = fs.readFileSync(new URL('../server/compose.js', import.meta.url), 'utf8');

const slice = (src, startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not slice ${startMarker}`);
  return src.slice(a, b);
};

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  slice(appSrc, 'const slugify = (s) =>', 'const bytes =') +
    slice(appSrc, 'function outName(', 'function plannedNames(') +
    slice(appSrc, 'function publishedCount(', 'async function addFromRoot()'),
  ctx
);
const EXPORTS = '({ outName, publishedCount, slugify })';
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

const BASE = 'the-kid-laroi-a-perfect-world-tour';

// What the CMS actually holds for a published project: the key image, the local
// thumb crop that never went up, and six gallery tiles, five of them video.
const PUBLISHED = [
  `${BASE}_hero.webp`,
  `${BASE}_gallery01.webp`,
  `${BASE}_gallery02.mp4`,
  `${BASE}_gallery03.mp4`,
  `${BASE}_gallery04.mp4`,
  `${BASE}_gallery05.mp4`,
  `${BASE}_gallery06.mp4`,
];

// ------------------------------------------------------------ counting what is up
check('six published tiles count as six', api.publishedCount(BASE, 'gallery', PUBLISHED), 6);
check('the hero is not a gallery tile', api.publishedCount(BASE, 'hero', PUBLISHED), 1);
check('nothing published counts as nothing', api.publishedCount(BASE, 'gallery', [`${BASE}_hero.webp`]), 0);
check('an empty collection counts as nothing', api.publishedCount(BASE, 'gallery', []), 0);

// A description that was a singleton has no number at all. It is still one file,
// and the next addition is the second — not a second `_gallery.webp`.
check(
  'an unnumbered singleton counts as one',
  api.publishedCount(BASE, 'gallery', [`${BASE}_gallery.webp`]),
  1
);

// Gaps happen: a tile deleted out of the CMS by hand leaves 01, 02, 06. The
// question is never "how many are there" but "how high do the numbers go" —
// counting would hand back 3 and send the next file over the top of 04.
check(
  'a gap does not lower the count',
  api.publishedCount(BASE, 'gallery', [`${BASE}_gallery01.webp`, `${BASE}_gallery02.mp4`, `${BASE}_gallery06.mp4`]),
  6
);

// Another project's files can sit in the same answer: the CMS is asked for
// filenames CONTAINING the base, and one base can be a prefix of another.
check(
  'a longer base is not this project',
  api.publishedCount('linkin-park', 'gallery', [
    'linkin-park_gallery01.webp',
    'linkin-park-from-zero-tour_gallery09.webp',
  ]),
  1
);

// ------------------------------------------------------- the names an addition gets
//
// Mirrors what plan() does with the offset: index and group size shift together,
// because the group is genuinely every file sharing the description, published
// ones included.
const namesFor = (from, kinds) =>
  kinds.map((kind, i) => api.outName(BASE, 'gallery', i + from, kinds.length + from, kind === 'video' ? 'mp4' : 'webp'));

check('two additions to six carry on from seven', namesFor(6, ['image', 'video']), [
  `${BASE}_gallery07.webp`,
  `${BASE}_gallery08.mp4`,
]);

// The one that would have bitten: a group of one drops the number, and
// `{base}_gallery.webp` beside a published `{base}_gallery01.webp` is a file
// under a name nothing expects. Shifting the SIZE as well as the index is what
// prevents it.
check('a lone addition is still numbered', namesFor(6, ['image']), [`${BASE}_gallery07.webp`]);
check('a lone addition to nothing is not numbered', namesFor(0, ['image']), [`${BASE}_gallery.webp`]);

// The whole point: nothing an addition produces may already exist.
const collides = (from, kinds) => namesFor(from, kinds).filter((n) => PUBLISHED.includes(n));
check('additions never land on a published name', collides(6, ['image', 'video', 'video']), []);
// ...and when the offset is wrong they do, which is why the UI checks as well.
check('a zero offset would land on published names', collides(0, ['image', 'video']), [
  `${BASE}_gallery01.webp`,
  `${BASE}_gallery02.mp4`,
]);

// -------------------------------------------------------- the three implementations
//
// The UI predicts the filename to decide whether a run is safe; the backends
// produce it. If they disagree the guard is checking the wrong string.
for (const [from, size, i, ext] of [
  [0, 1, 0, 'webp'],
  [0, 6, 3, 'webp'],
  [6, 8, 7, 'mp4'],
  [6, 7, 6, 'webp'],
  [11, 12, 11, 'mp4'],
]) {
  check(
    `outName and buildName agree (from ${from}, ${i + 1} of ${size})`,
    api.outName(BASE, 'gallery', i, size, ext),
    buildName(BASE, 'gallery', i, size, ext)
  );
}

// The Rust side cannot be imported, so what is asserted is that it computes the
// same two arguments — the arithmetic is the whole of the offset.
check(
  'compose.rs shifts index and group size together',
  /build_name\(base, &desc, idx \+ index_from, group_size\[&desc\] \+ index_from, ext\)/.test(rustSrc),
  true
);
check(
  'compose.js shifts index and group size together',
  /buildName\(base, desc, idx \+ indexFrom, groups\.get\(desc\) \+ indexFrom, ext\)/.test(nodeSrc),
  true
);
// A default of anything but nought would renumber every ordinary compose.
check('the Node offset defaults to nought', /indexFrom = 0/.test(nodeSrc), true);
check('the Rust offset defaults to nought', /index_from\.unwrap_or\(0\)/.test(rustSrc), true);

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
