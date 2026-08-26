// Exercises the work-page reorder planner out of web/app.js, without a browser.
// It slices the shipped source rather than copying it, so this cannot drift.
//
// Two properties matter, and they pull against each other:
//
//  1. CORRECTNESS. After the planned writes, the site's own comparator —
//     `order` ascending, with year only settling a tie — must produce exactly
//     the run that was dragged. Most of what follows re-sorts and compares.
//
//  2. COST. Every write is a full, synchronous Astro build on the CMS box, so
//     the number of documents written is not a detail, it is the feature. A
//     drag of one project must cost one write, not a renumbered grid.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

const slice = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not slice ${startMarker}`);
  return src.slice(a, b);
};

const code = slice('function longestKeepable(', '// ---------------------------------------------------------------- the screen');

const ctx = { console };
vm.createContext(ctx);
const EXPORTS = '({ longestKeepable, planOrders, planReorder, dropIndex })';
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

/** Projects, given as "id:year:order" — `order` may be `-` for not set. */
const make = (...specs) =>
  specs.map((s) => {
    const [id, year, order] = s.split(':');
    return { id, year, title: id.toUpperCase(), order: order === '-' ? null : Number(order) };
  });

const ids = (list) => list.map((p) => p.id);

/**
 * The site's comparator, from frontend/src/lib/payload.ts: the manual order
 * decides, and year only settles a tie between two projects sharing a number.
 * This is the oracle — a plan that does not survive it would not survive a
 * build.
 */
function asTheSiteWouldSortIt(items, changes) {
  const by = new Map(changes.map((c) => [c.id, c.order]));
  return items
    .map((p) => ({ ...p, order: by.has(p.id) ? by.get(p.id) : p.order }))
    .sort((a, b) => {
      const oa = a.order ?? 0;
      const ob = b.order ?? 0;
      if (oa !== ob) return oa - ob;
      return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
    })
    .map((p) => p.id);
}

// --------------------------------------------------------------- keepable run
check('nothing to keep in an empty list', [...api.longestKeepable([])], []);
check('an already-increasing run is kept whole', [...api.longestKeepable([1, 2, 3])].sort(), [0, 1, 2]);
check('one moved value costs one position', [...api.longestKeepable([5, 1, 2, 3])].sort(), [1, 2, 3]);
// Ties are not an order, so only one of a pair can stand.
check('equal values cannot both be kept', api.longestKeepable([2, 2, 2]).size, 1);
check('a reversed run keeps a single position', api.longestKeepable([4, 3, 2, 1]).size, 1);

// ------------------------------------------------------------- writes needed
const run = make('a:2026:1', 'b:2026:2', 'c:2025:3', 'd:2024:4');

check('an untouched run writes nothing', api.planReorder(run, ids(run)), []);

// The whole point: one drag, one build.
const movedOne = ['a', 'd', 'b', 'c'];
const one = api.planReorder(run, movedOne);
check('moving one project writes one document', one.length, 1);
check('...and it is the one that moved', one[0].id, 'd');
check('...landing where it was dropped', asTheSiteWouldSortIt(run, one), movedOne);
// 1, 2, 3, 4 with `d` dropped between `a` and `b` leaves no whole number to
// give it. A tie or an overshoot would both put it in the wrong place, so the
// planner has to use a fraction.
check('...on a fraction, because there is no integer between 1 and 2',
  one[0].order > 1 && one[0].order < 2, true);

// Dragging the front project to the back is still one document.
const toTheBack = ['b', 'c', 'd', 'a'];
const back = api.planReorder(run, toTheBack);
check('dragging the first project to the end writes one document', back.length, 1);
check('...and sorts there', asTheSiteWouldSortIt(run, back), toTheBack);

// A full reversal genuinely needs n-1: only one position can be kept.
const reversed = ['d', 'c', 'b', 'a'];
const rev = api.planReorder(run, reversed);
check('a reversed run writes n-1 documents', rev.length, 3);
check('...and comes out reversed', asTheSiteWouldSortIt(run, rev), reversed);

// ---------------------------------------------------------- the year is out
// This is the change the whole screen turns on: a project can be dragged past
// projects from other years and it sticks. Under the old comparator this move
// was impossible to express.
check('an older project can be pulled to the front', api.planReorder(run, ['d', 'a', 'b', 'c']).length, 1);
check('...and the site agrees',
  asTheSiteWouldSortIt(run, api.planReorder(run, ['d', 'a', 'b', 'c'])), ['d', 'a', 'b', 'c']);

// Year survives only as a tiebreak, so two projects sharing a number are not
// arbitrary — and the planner has to write one of them to separate the pair.
const tied = make('old:2019:5', 'new:2026:5');
check('a shared number falls back to newest first', asTheSiteWouldSortIt(tied, []), ['new', 'old']);
check('...and putting the older one first costs a write',
  asTheSiteWouldSortIt(tied, api.planReorder(tied, ['old', 'new'])), ['old', 'new']);

// ----------------------------------------------------------- value chosen
// Whole numbers whenever there is room for one, because these are read in the
// CMS sidebar.
const roomy = make('a:2025:10', 'b:2025:20', 'c:2025:30');
const whole = api.planReorder(roomy, ['a', 'c', 'b']);
check('a wide gap gets a whole number', Number.isInteger(whole[0].order), true);

// ------------------------------------------------------------- missing order
// A project with no order sorts as 0 on the site, so several of them are a tie
// and all but one have to be written even when nothing was dragged.
const blanks = make('a:2025:-', 'b:2025:-', 'c:2025:-');
const fixed = api.planReorder(blanks, ['a', 'b', 'c']);
check('unset orders are a tie, so they get resolved', fixed.length, 2);
check('...into the order shown', asTheSiteWouldSortIt(blanks, fixed), ['a', 'b', 'c']);

// ----------------------------------------------------------- where it lands
// The grid wraps, so the slot a pointer is asking for is a row question before
// it is a left-of question. Tiles here are 200x140 on a 3-wide grid, laid out
// the way the real one is; only getBoundingClientRect is needed.
const W = 200;
const H = 140;
const cells = (n, perRow = 3) =>
  Array.from({ length: n }, (_, i) => {
    const box = {
      left: (i % perRow) * W,
      top: Math.floor(i / perRow) * H,
      width: W,
      height: H,
    };
    return { getBoundingClientRect: () => box };
  });

const slot = (n, x, y) => api.dropIndex(cells(n), x, y, H / 2);

// Five tiles: three across the top row, two on the second.
check('the far left of the first row is the front of the run', slot(5, 4, 70), 0);
check('past the first tile is the second slot', slot(5, 150, 70), 1);
check('the far right of the first row is the end of that row', slot(5, 596, 70), 3);
check('the second row starts after everything above it', slot(5, 4, 210), 3);
check('...and moving right along it still counts the row above', slot(5, 150, 210), 4);
check('below the last row is the end of the run', slot(5, 4, 400), 5);
check('above the first row is the front of the run', slot(5, 500, -200), 0);
// A pointer between two rows must not straddle: it belongs to one of them.
check('a pointer level with a row boundary picks a single slot',
  slot(5, 300, H) >= 0 && slot(5, 300, H) <= 5, true);
check('an empty grid has one slot', slot(0, 100, 100), 0);

// ------------------------------------------------------ every arrangement
// The two properties, checked against each other over every permutation of a
// four-project run: the plan must always sort correctly, and must never write
// more than it has to.
const perms = (xs) =>
  xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r]));

let wrong = 0;
let costly = 0;
for (const want of perms(ids(run))) {
  const plan = api.planReorder(run, want);
  if (JSON.stringify(asTheSiteWouldSortIt(run, plan)) !== JSON.stringify(want)) wrong++;
  // n minus the longest already-increasing run is the floor: anything outside
  // that run has to be rewritten, and nothing inside it does.
  const floor = run.length - api.longestKeepable(want.map((id) => run.find((p) => p.id === id).order)).size;
  if (plan.length > floor) costly++;
}
check('every arrangement sorts as dragged', wrong, 0);
check('...and none writes more documents than it must', costly, 0);

// The real portfolio is around two dozen projects and the numbers already in
// the CMS are sparse and unsorted, so the same two properties are checked on
// something shaped like the live data rather than only on a tidy 1..4.
const live = make(
  'laroi:2026:-', 'peso1:2026:1', 'peso2:2026:4', 'wallen:2026:40',
  'omens:2025:4', 'rapp:2025:7', 'fallout:2025:24', 'griz:2025:38',
  'bunny:2024:1', 'rauw:2024:2', 'peso3:2024:36', 'linkin:2024:39'
);
const shuffled = ['griz:2025:38', 'laroi:2026:-', 'linkin:2024:39', 'peso1:2026:1'].map((s) => s.split(':')[0]);
const rest = ids(live).filter((id) => !shuffled.includes(id));
const target = [...shuffled, ...rest];
const livePlan = api.planReorder(live, target);
check('a shuffle of live-shaped data sorts as dragged', asTheSiteWouldSortIt(live, livePlan), target);
check('...without renumbering the whole grid', livePlan.length < live.length, true);

console.log(failures ? `\n${failures} FAILED` : '\nall work-order checks passed');
process.exit(failures ? 1 : 0);
