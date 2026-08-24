// A page can be built from more than one project folder — assets for one tour
// living partly on the NAS and partly on another drive. The id carries the list
// of source folders, so the rest of the pipeline needs no new arguments.
//
// This runs against the REAL roots in config.json, because the thing worth
// pinning is that a merged `rel` still resolves to a file that exists on disk.
import fs from 'node:fs';
import { listProjects, getProject, encodeId, decodeId, mergeIds, resolveRel } from '../server/scan.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const ok = (label, cond) => check(label, Boolean(cond), true);

const projects = listProjects();
if (projects.length < 2) {
  console.log('SKIP: need at least two projects under the configured roots');
  process.exit(0);
}
// Two projects that actually hold assets, preferably from different roots.
const withAssets = projects.filter((p) => p.stills + p.videos > 0);
const a = withAssets[0];
const b = withAssets.find((p) => p.root !== a.root) || withAssets[1];
if (!a || !b) {
  console.log('SKIP: need two projects with assets');
  process.exit(0);
}
console.log(`primary:   ${a.root} / ${a.folder}`);
console.log(`secondary: ${b.root} / ${b.folder}\n`);

// 1. A single-folder id must be untouched by any of this — saved selections
//    from before merging existed have to keep resolving.
const single = getProject(a.id);
check('a single-source project reports one source', single.sources.length, 1);
ok('its assets carry no prefix', single.assets.every((x) => !x.rel.startsWith('@')));
check('id round-trips', decodeId(a.id).folder, a.folder);

// 2. Merging.
const merged = mergeIds([a.id, b.id]);
const m = getProject(merged);
check('merged project reports both sources', m.sources.length, 2);
check('the primary names the page', m.folder, a.folder);
check('the primary decides the output folder', m.dir, single.dir);
check('source 0 is the primary', m.sources[0].folder, a.folder);
check('source 1 is the secondary', m.sources[1].folder, b.folder);

const fromA = m.assets.filter((x) => x.source === 0);
const fromB = m.assets.filter((x) => x.source === 1);
ok('assets arrive from both folders', fromA.length > 0 && fromB.length > 0);
check('every asset is accounted for', m.assets.length, fromA.length + fromB.length);
ok('primary assets stay unprefixed', fromA.every((x) => !x.rel.startsWith('@')));
ok('secondary assets are prefixed @1/', fromB.every((x) => x.rel.startsWith('@1/')));

// 3. The point of the whole exercise: a merged rel must resolve to a real file.
const decoded = decodeId(merged);
const sampleA = fromA[0];
const sampleB = fromB[0];
ok('a primary rel resolves to a file that exists', fs.existsSync(resolveRel(decoded, sampleA.rel)));
ok('a secondary rel resolves to a file that exists', fs.existsSync(resolveRel(decoded, sampleB.rel)));
ok('the secondary resolves INTO the secondary folder', resolveRel(decoded, sampleB.rel).startsWith(m.sources[1].dir));

// 4. Two folders may hold identically named files; the prefix is what keeps
//    them apart. Same rel, different source, different file on disk.
check(
  'the same name in two sources resolves two ways',
  resolveRel(decoded, 'x.jpg') === resolveRel(decoded, '@1/x.jpg'),
  false
);

// 5. Traversal is still refused, and a bad source index is an error not a crash.
let threw = false;
try { resolveRel(decoded, '@1/../../../windows/system32'); } catch { threw = true; }
ok('traversal out of a secondary source is refused', threw);
threw = false;
try { resolveRel(decoded, '@9/nope.jpg'); } catch { threw = true; }
ok('an out-of-range source index is an error', threw);

console.log(failures ? `\n${failures} FAILED` : '\nall multi-source checks passed');
process.exitCode = failures ? 1 : 0;
