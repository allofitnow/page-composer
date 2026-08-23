// Checks the services label -> relationship-id mapping against the live CMS.
//
// `services` is the field that actually prints in the project page's meta block,
// and it is a *relationship*: Payload stores ids, while the composer and the copy
// doc both deal in labels. If that mapping is wrong the field silently publishes
// empty, which is exactly the kind of failure nobody notices until the page is up.
//
// This one talks to the CMS, so it skips rather than fails when it cannot reach it.
import { serviceCategories, resolveServices } from '../server/payload.js';

const list = await serviceCategories();
if (!list.length) {
  console.log('skip  CMS unreachable — no service categories to check against');
  process.exit(0);
}

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

console.log(`     ${list.length} service categories in the CMS`);

// Every category must have both halves of the mapping, or it cannot round-trip.
check('every category has an id and a label', list.every((s) => s.id && s.label), true);
check('ids are unique', new Set(list.map((s) => s.id)).size, list.length);

const first = list[0];
const second = list[1] || list[0];

// 1. A label the CMS knows resolves to its id.
let r = await resolveServices([first.label]);
check(`"${first.label}" resolves to its id`, r, { ids: [first.id], unknown: [] });

// 2. Case and surrounding space must not matter — copy docs are typed by hand.
r = await resolveServices([`  ${first.label.toUpperCase()}  `]);
check('matching ignores case and padding', r, { ids: [first.id], unknown: [] });

// 3. Order is preserved, because it is the order they print in.
r = await resolveServices([second.label, first.label]);
check('order is preserved', r.ids, [second.id, first.id]);

// 4. An unknown name is reported, never invented — auto-creating a category
//    from a typo would quietly pollute a taxonomy the whole site shares.
r = await resolveServices(['Definitely Not A Real Service']);
check('unknown names are reported, not created', r, { ids: [], unknown: ['Definitely Not A Real Service'] });

// 5. A mix keeps the good ones and still reports the bad.
r = await resolveServices([first.label, 'Nonsense Service']);
check('a mix keeps the known and flags the rest', r, { ids: [first.id], unknown: ['Nonsense Service'] });

// 6. Empty input must not send an empty relationship array.
check('nothing selected resolves to nothing', await resolveServices([]), { ids: [], unknown: [] });
check('blank entries are ignored', await resolveServices(['', '   ']), { ids: [], unknown: [] });

console.log(failures ? `\n${failures} FAILED` : '\nall service-mapping checks passed');
// Set the code rather than calling process.exit(): fetch keeps a pooled socket
// alive, and tearing the process down on top of it aborts with a libuv
// assertion on Windows — which would report a passing run as a failure.
process.exitCode = failures ? 1 : 0;
