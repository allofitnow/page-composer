import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'A:/AOIN Brand and Marketing/!-Project Assets/z-2026- Projects/26013_peso-dinastia/01_Photos/J Selects-20260812T173808Z-1-001/J Selects';
const OUT = 'design';
const files = fs.readdirSync(SRC).filter(f => /\.jpe?g$/i.test(f)).sort();
console.log('found', files.length);
const pick = files.slice(0, 12);
let i = 0;
for (const f of pick) {
  i++;
  const out = path.join(OUT, `shot${String(i).padStart(2, '0')}.jpg`);
  await sharp(path.join(SRC, f)).resize(420, 280, { fit: 'cover', position: 'attention' }).jpeg({ quality: 62, mozjpeg: true }).toFile(out);
  console.log(out, (fs.statSync(out).size / 1024).toFixed(1) + 'kb', '<-', f);
}
