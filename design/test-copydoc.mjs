// The copy-doc format the team actually writes.
//
// AOIN's copy docs are built from Google Docs TABLES, not `Label: value` lines.
// Exported to Markdown, a field is a label paragraph followed by a one-cell
// table; stats and credits are multi-column tables. The parser was originally
// written for key/value lines and mapped almost nothing from a real doc — this
// pins the real shape so that cannot happen again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCopyDoc } from '../server/copydoc.js';

// A faithful reduction of linkin-park_website-copy.md, including the things
// that actually broke: parenthetical labels, escaped characters, markdown links
// in credit cells, and `##` sub-headings inside the write-up.
const DOC = `Artist Name/Project Title

| LINKIN PARK |
| :---- |

Tour Name/Subtitle

| FROM ZERO TOUR |
| :---- |

Year

| 2024 |
| :---- |

Collaborator

| STURDY. |
| :---- |

Capabilities (Services Rendered)

| REAL-TIME CONTENT  |
| :---- |

Services

| Notch IMAG Design Notch Content Design |
| :---- |

Summary (1-2 sentences)

| For Linkin Park's *From Zero* tour, a dynamic IMAG system was developed. |
| :---- |

Stats

| Shows | Tickets Sold | Gross Ticket Sales |
| :---- | :---- | :---- |
| 80 | 2.2M | $251M |

Team Credits

| Role | Name | Socials Link |
| :---- | :---- | :---- |
| Notch Designer | Berto Mora | https://www.instagram.com/berto\\_mora/ |
| Notch \\+ Embergen Designer | Vishal Sharma |  |

Collaborator Credits

| Role | Company | Socials Link |
| :---- | :---- | :---- |
| Artist | [Linkin Park](https://fromzero.linkinpark.com/) |  |

Full Write Up

Linkin Park's From Zero album signifies the band's resurgence.

## AOIN Involvement

AOIN was enlisted by STURDY. to bring this to life.

## The Result:

The tour has been celebrated by fans and critics alike.

Press Links

| Notch | LINKIN PARK | https://www.notch.one/x |
| :---- | :---- |
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoin-copydoc-'));
const file = path.join(dir, 'copy.md');
fs.writeFileSync(file, DOC, 'utf8');

// The CMS list is what lets a run-together services cell be split at all.
const SERVICES = [
  { id: '1', label: 'Notch IMAG Design' },
  { id: '2', label: 'Notch Content Design' },
  { id: '3', label: 'Creative Direction' },
];

const { fields: f, blocks } = await parseCopyDoc(file, SERVICES);

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

// 1. Label paragraph + one-cell table = a field. None of this mapped before.
check('title comes from the table under its label', f.title, 'LINKIN PARK');
check('tour', f.tour, 'FROM ZERO TOUR');
check('year', f.year, '2024');
check('collaborator', f.collaborator, 'STURDY.');
// The label carries a parenthetical, which must not stop it matching.
check('capabilities despite a parenthetical label', f.capabilities, ['REAL-TIME CONTENT']);
check('summary despite a parenthetical label', f.summary.startsWith('For Linkin Park'), true);

// 2. Google Docs joins the services with plain spaces, so the CMS list is the
//    only thing that can tell where one name ends and the next begins.
check('services split against the CMS list', f.services, ['Notch IMAG Design', 'Notch Content Design']);

// 3. Stats: header row names them, the row beneath holds the values.
check('stats zip header to values', f.stats, [
  { label: 'SHOWS', value: '80' },
  { label: 'TICKETS SOLD', value: '2.2M' },
  { label: 'GROSS TICKET SALES', value: '$251M' },
]);

// 4. Credits become groups, with the export's backslash escapes undone.
check('two credit groups', f.credits.map((g) => g.title), ['ALL OF IT NOW', 'COLLABORATORS']);
check('escaped underscore in a URL is restored', f.credits[0].entries[0].url, 'https://www.instagram.com/berto_mora/');
check('escaped plus in a role is restored', f.credits[0].entries[1].title, 'NOTCH + EMBERGEN DESIGNER');
check('a markdown link in a name splits into text and url', f.credits[1].entries[0], {
  title: 'ARTIST',
  name: 'Linkin Park',
  url: 'https://fromzero.linkinpark.com/',
});

// 5. The write-up runs to the end, and its sub-headings stay part of it. A
//    heading used to end the section, truncating the copy after two paragraphs.
const paras = [f.writeup.lead, ...f.writeup.body];
check('write-up keeps every paragraph and heading', paras.length, 5);
check('sub-headings survive as headings', paras.filter((p) => p.startsWith('## ')), [
  '## AOIN Involvement',
  '## The Result:',
]);
check('the last paragraph is not lost', paras[paras.length - 1].startsWith('The tour has been celebrated'), true);

// 6. Press Links has no field on the collection, so it must stay unmapped
//    rather than being forced somewhere.
check('press links stays unmapped', blocks.some((b) => b.tag === null || b.tag === undefined), true);
check('title is not stolen by a write-up heading', f.title, 'LINKIN PARK');

// 7. Renee Rapp's doc bolded its section headings, so the write-up label came
//    through as `**Full Write Up**` and matched nothing — the whole body was
//    dropped without a word. Its capabilities arrived as one run of text for the
//    same reason services do: the Markdown export joins separate lines with
//    single spaces, leaving no delimiter.
const BOLD_DOC = `Artist Name/Project Title

| RENEE RAPP |
| :---- |

Capabilities (Services Rendered)

| REAL-TIME CONTENT SCREENS PRODUCTION |
| :---- |

**Full Write Up**

First paragraph of the body.

Second paragraph of the body.
`;

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'copydoc-bold-'));
const file2 = path.join(dir2, 'renee-rapp_website-copy.md');
fs.writeFileSync(file2, BOLD_DOC, 'utf8');
const bold = (await parseCopyDoc(file2, [])).fields;

check('a bolded label still names its section', [bold.writeup.lead, ...bold.writeup.body], [
  'First paragraph of the body.',
  'Second paragraph of the body.',
]);
check('capabilities joined by single spaces still split', bold.capabilities, [
  'REAL-TIME CONTENT',
  'SCREENS PRODUCTION',
]);
check('the bolded label is not mistaken for body copy', bold.title, 'RENEE RAPP');
fs.rmSync(dir2, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall copy-doc checks passed');
process.exitCode = failures ? 1 : 0;
