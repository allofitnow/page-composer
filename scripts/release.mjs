#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it lives, commits, tags, and
// pushes. GitHub Actions (.github/workflows/release.yml) does the rest — builds
// and signs the Windows and macOS apps and publishes the release that installed
// apps update themselves from. Nothing is built on this machine.
//
//   npm run release patch     0.1.5 -> 0.1.6
//   npm run release minor     0.1.5 -> 0.2.0
//   npm run release major     0.1.5 -> 1.0.0
//   npm run release 0.3.1     exactly that
//
// Refuses to run with uncommitted changes: the tag should point at what is
// actually in the tree.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const want = process.argv[2] || 'patch';

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
    process.exit(r.status || 1);
  }
  return r.stdout.trim();
};

if (git('status', '--porcelain')) {
  console.error('the tree has uncommitted changes — commit or stash them first, so the tag points at what is really there');
  process.exit(1);
}

// ---- the three files that carry the version -------------------------------
const pkgPath = path.join(ROOT, 'package.json');
const confPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const [maj, min, pat] = current.split('.').map(Number);
const next =
  want === 'patch' ? `${maj}.${min}.${pat + 1}`
  : want === 'minor' ? `${maj}.${min + 1}.0`
  : want === 'major' ? `${maj + 1}.0.0`
  : /^\d+\.\d+\.\d+$/.test(want) ? want
  : null;
if (!next) {
  console.error(`not a version or a bump: ${want} (use patch, minor, major, or x.y.z)`);
  process.exit(1);
}
if (git('tag', '-l', `v${next}`)) {
  console.error(`v${next} is already tagged`);
  process.exit(1);
}

const replaceOnce = (file, from, to) => {
  const s = fs.readFileSync(file, 'utf8');
  if (!s.includes(from)) throw new Error(`${path.basename(file)} does not contain ${from}`);
  fs.writeFileSync(file, s.replace(from, to));
};
replaceOnce(pkgPath, `"version": "${current}"`, `"version": "${next}"`);
replaceOnce(confPath, `"version": "${current}"`, `"version": "${next}"`);
replaceOnce(cargoPath, `version = "${current}"`, `version = "${next}"`);
// Cargo.lock names the crate's own version too; let cargo rewrite it rather
// than editing by hand, and without touching any dependency.
spawnSync('cargo', ['update', '--workspace', '--offline'], { cwd: path.join(ROOT, 'src-tauri'), stdio: 'ignore' });

// ---- commit, tag, push ------------------------------------------------------
git('add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'package-lock.json');
git('commit', '-q', '-m', `Release ${next}`);
git('tag', '-a', `v${next}`, '-m', `AOIN Page Composer ${next}`);
const branch = git('branch', '--show-current');
git('push', 'origin', branch);
git('push', 'origin', `v${next}`);

console.log(`\ntagged v${next} and pushed. GitHub is building it now:`);
console.log(`  https://github.com/allofitnow/page-composer/actions`);
console.log(`When that goes green the release is live and installed apps will offer ${next} at their next launch.\n`);
