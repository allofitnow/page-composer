// Exercises the real h() element helper out of web/app.js against a stub DOM.
//
// This exists because `draggable: true` silently produced `draggable=""`, which
// is an *invalid* value for an enumerated attribute and falls back to "not
// draggable" — so the Page Order rail could not be dragged at all, while the
// markup still looked right in devtools. Nothing failed loudly; the feature
// just did nothing. Boolean-style serialisation is correct for `disabled` and
// friends, so the helper has to tell the two kinds apart.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const a = src.indexOf('function h(tag, props, ...kids) {');
const b = src.indexOf('// ------------------------------------------------------------------ naming');
if (a < 0 || b < 0) throw new Error('could not slice h() out of app.js');

class StubNode {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.attrs = {};
    this.listeners = [];
    this.kids = [];
    this.style = {};
    this.textContent = undefined;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(t, fn) {
    this.listeners.push(t);
  }
  append(kid) {
    this.kids.push(kid);
  }
}

const ctx = {
  console,
  Node: StubNode,
  document: {
    createElement: (t) => new StubNode(t),
    createTextNode: (s) => new StubNode(`#text:${s}`),
  },
};
vm.createContext(ctx);
vm.runInContext(src.slice(a, b), ctx);
const h = vm.runInContext('h', ctx);

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

// The regression itself: the rail's tiles are dragged to reorder and to split.
check('draggable: true serialises to "true"', h('div', { draggable: true }).attrs.draggable, 'true');

// Enumerated attributes generally — the same trap, same fix.
check('contenteditable: true serialises to "true"', h('div', { contenteditable: true }).attrs.contenteditable, 'true');
check('spellcheck: true serialises to "true"', h('div', { spellcheck: true }).attrs.spellcheck, 'true');
check('aria-* true serialises to "true"', h('div', { 'aria-expanded': true }).attrs['aria-expanded'], 'true');

// Genuinely boolean attributes must keep the empty-string form.
check('disabled: true stays an empty string', h('button', { disabled: true }).attrs.disabled, '');
check('hidden: true stays an empty string', h('div', { hidden: true }).attrs.hidden, '');

// False must drop the attribute entirely rather than write "false".
check('draggable: false is omitted', h('div', { draggable: false }).attrs.draggable, undefined);

// An explicit string is passed through untouched — this is how the <img> inside
// a draggable tile opts out of being its own drag source.
check('draggable: "false" is written verbatim', h('img', { draggable: 'false' }).attrs.draggable, 'false');

// A <textarea> has no `value` attribute: setting one is silently ignored by the
// browser, so the box renders empty and typing appears to erase itself on every
// re-render. Its content has to go in as a text node instead.
const area = h('textarea', { value: 'typed text' });
check('textarea value becomes its text content', area.textContent, 'typed text');
check('textarea value is NOT written as an attribute', area.attrs.value, undefined);

// An <input> does have one, so it must keep using the attribute.
const input = h('input', { value: 'typed text' });
check('input value stays an attribute', input.attrs.value, 'typed text');
check('input gets no stray text content', input.textContent, undefined);

// The rest of the helper's contract, so this file can stand alone as its guard.
check('tag.class syntax sets className', h('div.cell.m', {}).className, 'cell m');
check('on* registers a listener, not an attribute', h('div', { onClick: () => {} }).listeners, ['click']);
check('null and undefined props are skipped', Object.keys(h('div', { a: null, b: undefined }).attrs), []);

// An inline full-bleed overlay is a click-eating trap, and a silent one.
//
// A drop target rendered as `position: absolute; inset: 0` had no positioned
// ancestor, so it sized against the VIEWPORT instead of the pane it looked like
// it was in — and it only rendered when the gallery was empty, which is exactly
// the state a freshly opened project lands in. The app looked normal and
// ignored every click in the window.
//
// Nothing in a stub DOM can catch that, so this is a source rule instead:
// full-bleed positioning belongs in style.css, where the containing block is
// visible next to the rule. Inline styles in app.js may not use `inset`, and
// may not pair `position: absolute` with a zeroed edge.
const offenders = [];
const inlineStyles = src.match(/style:\s*\{[^}]*\}/g) || [];
for (const style of inlineStyles) {
  const flat = style.replace(/\s+/g, ' ');
  if (/\binset\b/.test(flat)) offenders.push(flat);
  else if (/position:\s*'absolute'/.test(flat) && /(top|right|bottom|left):\s*'0/.test(flat)) offenders.push(flat);
}
check('no inline style paints a full-bleed overlay', offenders, []);

// The stylesheet carries a handful of one-line utility classes that are applied
// all over the app — `.grow` alone sits on ten spacers. A new screen naming one
// of its own containers the same thing raises no error anywhere: it silently
// restyles every other use, on screens nobody happens to be looking at. That is
// exactly what a `.grow` gallery row did, so each utility keeps its one rule.
const css = fs.readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const UTILITIES = ['grow', 'trunc', 'dim', 'dimmer', 'ov', 'm', 'field', 'chip', 'btn', 'step', 'empty', 'scroll', 'screen', 'pane', 'cell', 'tile'];
const reused = UTILITIES.filter((name) => {
  // Rules that define the bare class on its own, rather than qualifying it
  // (`.chip:hover`), descending from it (`.ghead .chip`) or modifying it
  // (`.btn--ghost`).
  const bare = new RegExp('(^|[,}])\\s*\\.' + name + '\\s*\\{', 'gm');
  return (css.match(bare) || []).length > 1;
});
check('no utility class is redefined by a screen', reused, []);

console.log(failures ? `\n${failures} FAILED` : '\nall attribute checks passed');
process.exit(failures ? 1 : 0);
