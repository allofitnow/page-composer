// Bakes the brand OTFs into each artboard as @font-face data: URIs, so the
// published canvas is typographically identical to the site (the artifact CSP
// admits no font host but Google Fonts).
import fs from 'node:fs';
import path from 'node:path';

const FONTS = 'A:/AOIN Brand and Marketing/!-Project Assets/z-2026_Website/allofitnow-website/frontend/public/fonts';
const OUT = 'build';

const face = (family, file, weight) => {
  const b64 = fs.readFileSync(path.join(FONTS, file)).toString('base64');
  return `@font-face{font-family:"${family}";src:url(data:font/otf;base64,${b64}) format("opentype");font-weight:${weight};font-style:normal;font-display:block}`;
};

const block = [
  face('Denim INK WD', 'DenimINKWD-Medium.otf', '400 700'),
  face('SN Ja Mono', 'SNJaMono-Light.otf', '300'),
].join('\n');

fs.mkdirSync(OUT, { recursive: true });

const boards = fs.readdirSync('.').filter((f) => f.endsWith('.dc.html'));
for (const b of boards) {
  const src = fs.readFileSync(b, 'utf8');
  if (!src.includes('/*@AOIN-FONTS*/')) throw new Error(`${b}: missing /*@AOIN-FONTS*/ marker`);
  const out = src.replace('/*@AOIN-FONTS*/', block);
  fs.writeFileSync(path.join(OUT, b), out);
  console.log(b, (out.length / 1024).toFixed(0) + 'kb');
}

for (const f of fs.readdirSync('.').filter((f) => f.endsWith('.jpg') || f === 'canvas.json')) {
  fs.copyFileSync(f, path.join(OUT, f));
}
console.log('build/ ready');
