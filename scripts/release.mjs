#!/usr/bin/env node
// Builds a SIGNED desktop release and puts it where every copy of the app looks
// for updates: `/composer/` on each CMS host, served by nginx from
// /opt/aoin-composer. After this, an installed app offers the new build itself.
//
//   node scripts/release.mjs [--notes "what changed"] [--host 192.168.30.245]...
//
// Needs the signing key at ~/.tauri/page-composer.key (the public half is in
// tauri.conf.json — a build made with any other key is refused by the app) and
// root ssh to each host. Hosts default to both CMS boxes. Builds for the OS it
// runs on: NSIS here, the .app bundle on a Mac; latest.json on the server keeps
// whichever platforms have been uploaded so far.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hosts = args.flatMap((a, i) => (a === '--host' ? [args[i + 1]] : []));
if (!hosts.length) hosts.push('192.168.30.245', '192.168.30.246');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const keyPath = path.join(os.homedir(), '.tauri', 'page-composer.key');
if (!fs.existsSync(keyPath)) {
  console.error(`no signing key at ${keyPath} — run: npx tauri signer generate -w "${keyPath}"`);
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
    process.exit(r.status || 1);
  }
};

// ---- build ---------------------------------------------------------------
const targetDir =
  process.env.CARGO_TARGET_DIR ||
  (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'aoin-composer-target') : '');
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyPath, 'utf8').trim(),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '',
  ...(targetDir ? { CARGO_TARGET_DIR: targetDir } : {}),
};
const bundles = process.platform === 'win32' ? 'nsis' : 'app,dmg';
console.log(`\nbuilding ${pkg.name} ${version} (${bundles})\n`);
run(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri'), ['build', '--bundles', bundles], { env });

// ---- collect the signed artifacts ----------------------------------------
const bundleDir = path.join(targetDir || path.join(ROOT, 'src-tauri', 'target'), 'release', 'bundle');
const platforms = {}; // updater platform key -> { file, sig }
if (process.platform === 'win32') {
  const dir = path.join(bundleDir, 'nsis');
  const exe = fs.readdirSync(dir).find((f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`));
  if (!exe) throw new Error(`no NSIS installer for ${version} in ${dir}`);
  platforms['windows-x86_64'] = { file: path.join(dir, exe), sig: fs.readFileSync(path.join(dir, `${exe}.sig`), 'utf8').trim() };
} else if (process.platform === 'darwin') {
  const dir = path.join(bundleDir, 'macos');
  const tar = fs.readdirSync(dir).find((f) => f.endsWith('.app.tar.gz'));
  if (!tar) throw new Error(`no .app.tar.gz in ${dir}`);
  const key = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
  platforms[key] = { file: path.join(dir, tar), sig: fs.readFileSync(path.join(dir, `${tar}.sig`), 'utf8').trim() };
}

// The installer also goes where it always has, for anyone installing by hand.
for (const { file } of Object.values(platforms)) {
  if (file.endsWith('.exe')) {
    for (const dest of [path.join(ROOT, 'AOIN Page Composer_setup.exe'), path.join(os.homedir(), 'Downloads', 'AOIN Page Composer_setup.exe')]) {
      fs.copyFileSync(file, dest);
    }
  }
}

// ---- upload, and write latest.json per host ------------------------------
// notes: what the update chip shows. The last commit subject is a fair default.
const notes =
  flag('--notes') ||
  spawnSync('git', ['log', '-1', '--format=%s'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ||
  `Version ${version}`;
const ssh = (host, cmd) => run('ssh', ['-o', 'BatchMode=yes', `root@${host}`, cmd]);
const scp = (host, from, to) => run('scp', ['-o', 'BatchMode=yes', from, `root@${host}:${to}`]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-release-'));

for (const host of hosts) {
  console.log(`\n→ ${host}`);
  ssh(host, 'mkdir -p /opt/aoin-composer');
  // Keep the other platforms' entries from the last release on this host, so a
  // Windows build here does not knock the Mac build off the list.
  let existing = {};
  const cur = spawnSync('ssh', ['-o', 'BatchMode=yes', `root@${host}`, 'cat /opt/aoin-composer/latest.json 2>/dev/null'], { encoding: 'utf8' });
  try {
    existing = JSON.parse(cur.stdout || '{}').platforms || {};
  } catch {
    existing = {};
  }
  const entries = { ...existing };
  for (const [key, { file, sig }] of Object.entries(platforms)) {
    const name = path.basename(file);
    scp(host, file, `/opt/aoin-composer/${name}`);
    entries[key] = { signature: sig, url: `http://${host}/composer/${encodeURIComponent(name)}` };
  }
  const latest = { version, notes, pub_date: new Date().toISOString(), platforms: entries };
  const local = path.join(tmp, `latest-${host}.json`);
  fs.writeFileSync(local, JSON.stringify(latest, null, 2) + '\n');
  scp(host, local, '/opt/aoin-composer/latest.json');
  console.log(`  ${host}: ${version} — ${Object.keys(entries).join(', ')}`);
}
console.log(`\nreleased ${version}. Installed apps pointed at ${hosts.join(' or ')} will offer it on next launch.\n`);
