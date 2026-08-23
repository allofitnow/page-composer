import fs from 'node:fs';

const SHOTS = [
  ['shot01.jpg', 'DSC03502.JPG'],
  ['shot02.jpg', 'GARRETTBRUCE-1401.JPG'],
  ['shot03.jpg', 'GARRETTBRUCE-1534.JPG'],
  ['shot04.jpg', 'GARRETTBRUCE-1910.JPG'],
  ['shot05.jpg', 'GARRETTBRUCE-1967.JPG'],
  ['shot06.jpg', 'GARRETTBRUCE-1997.JPG'],
  ['shot07.jpg', 'GARRETTBRUCE-2218.JPG'],
  ['shot08.jpg', 'GARRETTBRUCE-3228.JPG'],
  ['shot09.jpg', 'GARRETTBRUCE-3231.JPG'],
  ['shot10.jpg', 'GARRETTBRUCE-3347.JPG'],
  ['shot11.jpg', 'GARRETTBRUCE-3392.JPG'],
  ['shot12.jpg', 'GARRETTBRUCE-3418.JPG'],
];

const ic = {
  folder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
  chev: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>',
  chevD: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"></path></svg>',
  img: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16"></rect><path d="M3 16l5-5 4 4 3-3 6 6"></path></svg>',
  grip: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h16M4 16h16"></path></svg>',
  doc: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path></svg>',
};

const OV = 'font-family:var(--mono);font-weight:300;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:var(--cw45)';
const MONO = 'font-family:var(--mono);font-weight:300';

const tiles = SHOTS.map(([f, n], i) => {
  const k = 't' + (i + 1);
  return `        <div onClick="{{ ${k}.pick }}" style="position:relative;border-radius:12px;overflow:hidden;aspect-ratio:3/2;cursor:pointer;background:#0d0d0d;outline:{{ ${k}.ring }};outline-offset:-2px;opacity:{{ ${k}.dim }};transition:opacity 180ms var(--brand)">
          <img src="${f}" alt="${n}" style="width:100%;height:100%;object-fit:cover;display:block">
          <sc-if value="{{ ${k}.on }}" hint-placeholder-val="{{ true }}">
            <div style="position:absolute;top:9px;left:9px;background:var(--cw);color:#000;${MONO};font-size:10px;letter-spacing:0.16em;padding:4px 7px 3px">{{ ${k}.label }}</div>
          </sc-if>
          <div style="position:absolute;left:0;right:0;bottom:0;padding:14px 9px 6px;background:linear-gradient(to top,rgba(0,0,0,0.9),rgba(0,0,0,0));${MONO};font-size:9px;letter-spacing:0.1em;color:var(--cw80);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${n}</div>
        </div>`;
}).join('\n');

const heroImgs = SHOTS.map(([f], i) => `          <sc-if value="{{ h${i + 1} }}" hint-placeholder-val="{{ ${i === 4 ? 'true' : 'false'} }}"><img src="${f}" alt="hero" style="width:100%;height:100%;object-fit:cover;display:block"></sc-if>`).join('\n');

const rows = SHOTS.map(([f, n], i) => {
  const k = 'r' + (i + 1);
  return `          <sc-if value="{{ ${k}.on }}" hint-placeholder-val="{{ true }}">
            <div style="order:{{ ${k}.ord }};display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--rule)">
              <span style="color:var(--cw35);display:flex">${ic.grip}</span>
              <span style="${MONO};font-size:11px;letter-spacing:0.1em;color:var(--cw);width:18px">{{ ${k}.num }}</span>
              <img src="${f}" alt="${n}" style="width:52px;height:35px;object-fit:cover;border-radius:3px;display:block;flex:0 0 auto">
              <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto">
                <div style="${MONO};font-size:9.5px;letter-spacing:0.04em;color:var(--cw80);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ ${k}.out }}</div>
                <div style="${MONO};font-size:8.5px;letter-spacing:0.16em;color:var(--cw35)">{{ ${k}.slot }}</div>
              </div>
            </div>
          </sc-if>`;
}).join('\n');

const names = JSON.stringify(SHOTS.map((s) => s[1]));

const logic = `class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { hero: 4, thumb: 1, gallery: [0, 6, 2, 9, 5, 11], mode: 'gallery' };
  }

  slotOf(p) {
    return ['A / 8 COL / 16:9', 'B / 4 COL / 1:1', 'FULL / 12 COL', 'C / 5 COL / 4:3', 'D / 7 COL / 16:9', 'FULL / 12 COL'][p % 6];
  }

  pick(i) {
    const s = this.state;
    if (s.mode === 'hero') {
      this.setState({ hero: i, gallery: s.gallery.filter((g) => g !== i), thumb: s.thumb === i ? null : s.thumb });
      return;
    }
    if (s.mode === 'thumb') {
      this.setState({ thumb: i, gallery: s.gallery.filter((g) => g !== i), hero: s.hero === i ? null : s.hero });
      return;
    }
    if (s.gallery.indexOf(i) >= 0) {
      this.setState({ gallery: s.gallery.filter((g) => g !== i) });
    } else {
      this.setState({ gallery: s.gallery.concat([i]), hero: s.hero === i ? null : s.hero, thumb: s.thumb === i ? null : s.thumb });
    }
  }

  renderVals() {
    const s = this.state;
    const names = ${names};
    const base = this.props.base ?? 'peso-dinastia-dinastia-tour';
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const v = {};

    for (let i = 0; i < names.length; i++) {
      const g = s.gallery.indexOf(i);
      const isHero = s.hero === i;
      const isThumb = s.thumb === i;
      const on = isHero || isThumb || g >= 0;
      v['t' + (i + 1)] = {
        on: on,
        label: isHero ? 'HERO' : isThumb ? 'THUMB' : pad(g + 1),
        ring: on ? '2px solid ' + (isHero ? '#FFFFFF' : '#D9E1EA') : '0px solid transparent',
        dim: on ? 1 : 0.4,
        pick: () => this.pick(i),
      };
      v['h' + (i + 1)] = isHero;
      v['r' + (i + 1)] = {
        on: g >= 0,
        ord: g,
        num: pad(g + 1),
        out: base + '_gallery' + pad(g + 1) + '.webp',
        slot: this.slotOf(g),
      };
    }

    v.heroName = s.hero == null ? 'NOT SET' : names[s.hero];
    v.heroOut = base + '_hero.webp';
    v.thumbName = s.thumb == null ? 'NOT SET' : names[s.thumb];
    v.thumbOut = base + '_thumb.webp';
    v.base = base;
    v.count = s.gallery.length;
    v.total = s.gallery.length + (s.hero == null ? 0 : 1) + (s.thumb == null ? 0 : 1);
    v.composeLabel = 'COMPOSE ' + v.total + ' ASSETS';
    v.selLine = '148 ASSETS / ' + v.total + ' SELECTED';

    const chip = (m) => ({
      bg: s.mode === m ? '#D9E1EA' : 'transparent',
      fg: s.mode === m ? '#000000' : 'rgba(217,225,234,0.45)',
      bd: s.mode === m ? '#D9E1EA' : 'rgba(217,225,234,0.22)',
      set: () => this.setState({ mode: m }),
    });
    v.mGallery = chip('gallery');
    v.mHero = chip('hero');
    v.mThumb = chip('thumb');
    v.hint =
      s.mode === 'gallery'
        ? 'CLICK TO ADD OR REMOVE FROM THE CAROUSEL'
        : s.mode === 'hero'
        ? 'CLICK A TILE TO SET THE HERO'
        : 'CLICK A TILE TO SET THE THUMB';
    return v;
  }
}`;

const step = (n, l, on) =>
  `<div style="display:flex;align-items:center;gap:7px;padding:4px 9px 3px;background:${on ? 'var(--cw)' : 'transparent'};color:${on ? '#000' : 'var(--cw35)'};${MONO};font-size:9.5px;letter-spacing:0.2em"><span>${n}</span><span>${l}</span></div>`;

const treeRow = (icon, label, count, indent, active) =>
  `        <div style="display:flex;align-items:center;gap:8px;padding:6px 0 6px ${indent}px;color:${active ? 'var(--cw)' : 'var(--cw45)'}">
          <span style="display:flex;flex:0 0 auto">${icon}</span>
          <span style="${MONO};font-size:10.5px;letter-spacing:0.06em;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</span>
          <span style="${MONO};font-size:9.5px;letter-spacing:0.1em;color:var(--cw35)">${count}</span>
        </div>`;

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
/*@AOIN-FONTS*/
:root {
  --cw: #D9E1EA;
  --cw80: rgba(217, 225, 234, 0.8);
  --cw45: rgba(217, 225, 234, 0.45);
  --cw35: rgba(217, 225, 234, 0.35);
  --rule: rgba(217, 225, 234, 0.22);
  --ink: #0A0A0A;
  --mono: "SN Ja Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: "Denim INK WD", -apple-system, "Helvetica Neue", Arial, sans-serif;
  --brand: cubic-bezier(0.05, 0.89, 0, 0.99);
}
body { margin: 0; background: #000; color: var(--cw); font-family: var(--sans); font-weight: 400; }
a { color: var(--cw); text-decoration: none; }
a:hover { color: var(--cw45); }
  </style>
</helmet>
<div style="width:1440px;height:980px;display:flex;flex-direction:column;background:#000;overflow:hidden">

  <div style="height:56px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--rule);background:var(--ink)">
    <div style="display:flex;align-items:center;gap:14px">
      <span style="font-family:var(--sans);font-weight:500;font-size:15px;letter-spacing:0.04em">AOIN</span>
      <span style="width:1px;height:14px;background:var(--rule)"></span>
      <span style="${OV}">Page Composer</span>
    </div>
    <div style="display:flex;align-items:center;gap:9px;color:var(--cw80)">
      <span style="display:flex;color:var(--cw45)">${ic.folder}</span>
      <span style="${MONO};font-size:11px;letter-spacing:0.14em">26013_PESO-DINASTIA</span>
      <span style="${MONO};font-size:9.5px;letter-spacing:0.16em;color:var(--cw35)">Z-2026 PROJECTS</span>
    </div>
    <div style="display:flex;align-items:center;gap:2px">
      ${step('01', 'PICK', false)}
      ${step('02', 'COMPOSE', true)}
      ${step('03', 'PREVIZ', false)}
      ${step('04', 'COPY', false)}
      ${step('05', 'EXPORT', false)}
    </div>
  </div>

  <div style="flex:1 1 auto;display:flex;min-height:0">

    <div style="width:240px;flex:0 0 auto;border-right:1px solid var(--rule);background:var(--ink);display:flex;flex-direction:column;padding:20px 18px;gap:16px">
      <div style="${OV}">Source</div>
      <div style="display:flex;gap:5px">
        <div style="${MONO};font-size:9.5px;letter-spacing:0.16em;padding:4px 9px 3px;background:var(--cw);color:#000">ALL</div>
        <div style="${MONO};font-size:9.5px;letter-spacing:0.16em;padding:4px 9px 3px;border:1px solid var(--rule);color:var(--cw45)">STILLS</div>
        <div style="${MONO};font-size:9.5px;letter-spacing:0.16em;padding:4px 9px 3px;border:1px solid var(--rule);color:var(--cw45)">VIDEO</div>
      </div>
      <div style="display:flex;flex-direction:column">
${treeRow(ic.chevD, '01_PHOTOS', '148', 0, true)}
${treeRow(ic.img, 'J SELECTS', '17', 16, true)}
${treeRow(ic.img, 'RENDER SCREENSHOTS', '44', 16, false)}
${treeRow(ic.img, 'SHOW PHOTOS', '87', 16, false)}
${treeRow(ic.chev, '02_VIDEOS', '24', 0, false)}
${treeRow(ic.chev, '03_GIFS', '6', 0, false)}
${treeRow(ic.chev, '04_INSTAGRAM', '31', 0, false)}
      </div>
      <div style="flex:1 1 auto"></div>
      <div style="border-top:1px solid var(--rule);padding-top:14px;display:flex;flex-direction:column;gap:9px">
        <div style="${OV}">Copy Doc</div>
        <div style="display:flex;align-items:center;gap:8px;color:var(--cw)">
          <span style="display:flex;color:var(--cw45)">${ic.doc}</span>
          <span style="${MONO};font-size:9.5px;letter-spacing:0.04em;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">PESO-DINASTIA_WRITEUP.DOCX</span>
          <span style="display:flex">${ic.check}</span>
        </div>
        <div style="${MONO};font-size:9px;letter-spacing:0.12em;color:var(--cw35)">14 / 14 FIELDS MAPPED</div>
      </div>
    </div>

    <div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;padding:20px 24px;gap:14px">
      <div style="display:flex;align-items:flex-end;justify-content:space-between">
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="${OV}">Contact Sheet</div>
          <div style="${MONO};font-size:9.5px;letter-spacing:0.16em;color:var(--cw35)">{{ hint }}</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <span style="${MONO};font-size:10px;letter-spacing:0.16em;color:var(--cw45)">{{ selLine }}</span>
          <div style="display:flex;gap:4px">
            <div onClick="{{ mGallery.set }}" style="cursor:pointer;${MONO};font-size:9.5px;letter-spacing:0.16em;padding:5px 11px 4px;background:{{ mGallery.bg }};color:{{ mGallery.fg }};border:1px solid {{ mGallery.bd }}">GALLERY</div>
            <div onClick="{{ mHero.set }}" style="cursor:pointer;${MONO};font-size:9.5px;letter-spacing:0.16em;padding:5px 11px 4px;background:{{ mHero.bg }};color:{{ mHero.fg }};border:1px solid {{ mHero.bd }}">HERO</div>
            <div onClick="{{ mThumb.set }}" style="cursor:pointer;${MONO};font-size:9.5px;letter-spacing:0.16em;padding:5px 11px 4px;background:{{ mThumb.bg }};color:{{ mThumb.fg }};border:1px solid {{ mThumb.bd }}">THUMB</div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:10px">
${tiles}
      </div>
    </div>

    <div style="width:320px;flex:0 0 auto;border-left:1px solid var(--rule);background:var(--ink);display:flex;flex-direction:column;padding:20px 18px;gap:14px;min-height:0">
      <div style="${OV}">Page Order</div>

      <div style="display:flex;flex-direction:column;gap:7px">
        <div style="position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#111;outline:2px solid #FFFFFF;outline-offset:-2px">
${heroImgs}
          <div style="position:absolute;top:9px;left:9px;background:#FFFFFF;color:#000;${MONO};font-size:10px;letter-spacing:0.16em;padding:4px 7px 3px">HERO</div>
        </div>
        <div style="${MONO};font-size:9.5px;letter-spacing:0.04em;color:var(--cw80)">{{ heroOut }}</div>
        <div style="${MONO};font-size:8.5px;letter-spacing:0.14em;color:var(--cw35)">FROM {{ heroName }}</div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)">
        <span style="${MONO};font-size:9.5px;letter-spacing:0.16em;color:var(--cw45)">THUMB</span>
        <span style="${MONO};font-size:9.5px;letter-spacing:0.04em;color:var(--cw80);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ thumbOut }}</span>
      </div>

      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div style="${OV}">Gallery</div>
        <div style="${MONO};font-size:9.5px;letter-spacing:0.16em;color:var(--cw35)">{{ count }} IN CAROUSEL</div>
      </div>

      <div style="flex:1 1 auto;overflow-y:auto;min-height:0;display:flex;flex-direction:column">
${rows}
      </div>

      <div style="flex:0 0 auto;display:flex;flex-direction:column;gap:9px;padding-top:12px;border-top:1px solid var(--rule)">
        <div style="${OV}">Name Base</div>
        <div style="border:1px solid var(--rule);padding:8px 10px;${MONO};font-size:10px;letter-spacing:0.04em;color:var(--cw)">{{ base }}</div>
        <div style="${MONO};font-size:8.5px;letter-spacing:0.1em;color:var(--cw35);text-transform:uppercase">project-name-tour_description##</div>
        <div style="background:var(--cw);color:#000;text-align:center;padding:12px 0 11px;${MONO};font-size:11px;letter-spacing:0.2em;cursor:pointer">{{ composeLabel }}</div>
      </div>
    </div>

  </div>
</div>
</x-dc>
<script data-dc-script data-props='{"base":{"editor":"text","default":"peso-dinastia-dinastia-tour","section":"Naming"}}'>
${logic}
</script>
</body>
</html>
`;

fs.writeFileSync('Main.dc.html', html);
console.log('wrote Main.dc.html', (html.length / 1024).toFixed(1) + 'kb');
