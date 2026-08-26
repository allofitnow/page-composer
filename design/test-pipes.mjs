// Does every call the UI makes actually land somewhere?
//
// transport.js says it plainly: "The shapes on both sides are identical by
// design — if you add a field to one backend, add it to the other." Nothing
// enforced it. The failure mode is quiet and one-sided: a call added to the
// Tauri branch alone works all through development on the desktop build and
// throws `rpc.x is not a function` the first time anyone opens the web one, and
// a `tauri::command` that never reaches `invoke_handler` compiles perfectly and
// fails at the click.
//
// So this walks the four ends and checks they meet:
//
//   web/app.js       — the calls the UI actually makes
//   web/transport.js — the two branches that must offer the same names
//   src-tauri/src/lib.rs — the commands the desktop build will answer
//   server/index.js  — the routes the web build will answer
//
// It reads the shipped source; there is nothing to keep in step by hand.
import fs from 'node:fs';

// Line endings are mixed across this repo and every marker below spans a
// newline, so they are normalised once on the way in.
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').split('\r\n').join('\n');
const transport = read('web/transport.js');
const app = read('web/app.js');
const libRs = read('src-tauri/src/lib.rs');
const indexJs = read('server/index.js');

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

// ------------------------------------------------------------- the two branches
//
// `export const rpc = isTauri ? { … } : { … }` — split on the `: {` that starts
// the second object literal, at the indentation the file uses for it.
const rpcBlock = transport.slice(transport.indexOf('export const rpc ='), transport.indexOf('\n * Thumbnails differ'));
const [tauriHalf, httpHalf] = rpcBlock.split(/\n\s*: \{/);
const keysOf = (s) => [...s.matchAll(/^      ([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort();

const tauriKeys = keysOf(tauriHalf);
const httpKeys = keysOf(httpHalf);
check('both branches are found', [tauriKeys.length > 10, httpKeys.length > 10], [true, true]);
check('the desktop branch offers nothing the web one lacks', tauriKeys.filter((k) => !httpKeys.includes(k)), []);
check('the web branch offers nothing the desktop one lacks', httpKeys.filter((k) => !tauriKeys.includes(k)), []);

// ---------------------------------------------------- every call the UI makes
const used = [...new Set([...app.matchAll(/\brpc\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]))].sort();
check('the UI calls nothing that does not exist', used.filter((k) => !tauriKeys.includes(k)), []);

// ------------------------------------------------- every command is registered
//
// The handler list is one `generate_handler![…]`; the names inside are
// `module::command`.
const handler = libRs.slice(libRs.indexOf('generate_handler!['), libRs.indexOf(']', libRs.indexOf('generate_handler![')));
const registered = new Set([...handler.matchAll(/([a-z_][a-z0-9_]*)\s*,/g)].map((m) => m[1]));
const invoked = [...new Set([...transport.matchAll(/invoke\('([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]))].sort();
check('the transport invokes at least a dozen commands', invoked.length > 12, true);
check('every invoked command is registered', invoked.filter((c) => !registered.has(c)), []);

// ------------------------------------------------------- every route is served
//
// Template literals mean a path is `/api/cms-project/${id}` in the transport and
// `/api/cms-project/:id` in Express, so both sides are reduced to their fixed
// leading segments before comparing.
const stem = (p) => {
  const parts = p.split('/').filter(Boolean);
  const stop = parts.findIndex((s) => s.startsWith('${') || s.startsWith(':'));
  return '/' + (stop < 0 ? parts : parts.slice(0, stop)).join('/');
};
const routes = new Set(
  [...indexJs.matchAll(/app\.(?:get|post)\('([^']+)'/g)].map((m) => stem(m[1]))
);
const fetched = [...new Set([...transport.matchAll(/http(?:Post)?\(['`](\/api\/[^`'?]*)/g)].map((m) => stem(m[1])))].sort();
check('the transport fetches at least a dozen routes', fetched.length > 12, true);
check('every fetched route is served', fetched.filter((p) => !routes.has(p)), []);

// --------------------------------------------- the two ends of add-from-a-root
//
// Named checks for the newest pipe, because a generic sweep would pass on a
// call that exists on both sides and carries the wrong argument.
check('the transport can upload a composed manifest', tauriKeys.includes('uploadComposed'), true);
check(
  'both branches name the manifest the same way',
  [/uploadComposed: \(\{ manifestPath, alt \}\)/g].map((re) => (transport.match(re) || []).length),
  [2]
);
check('upload_composed takes manifest_path and alt', /manifest_path: String,\n    alt: String,/.test(read('src-tauri/src/payload.rs')), true);
check('uploadComposed takes manifestPath and alt', /uploadComposed\(\{ manifestPath, alt, onProgress/.test(read('server/payload.js')), true);
// The offset is the whole safety of the feature; if it stops reaching a backend
// the additions silently restart at 01 and overwrite published pictures.
check('the UI sends an offset with the compose', /indexFrom: from,/.test(app), true);
check('the Rust compose accepts one', /index_from: Option<usize>,/.test(read('src-tauri/src/compose.rs')), true);
check('the Node compose accepts one', /startCompose\(\{ projectId, base, items, outDir: outDirRel, indexFrom = 0 \}\)/.test(read('server/compose.js')), true);

console.log(failures ? `\n${failures} FAILED` : '\nall pipes fit');
process.exit(failures ? 1 : 0);
