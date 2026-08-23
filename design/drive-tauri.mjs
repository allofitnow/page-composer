// Drives the running Tauri window over WebView2's CDP endpoint, so the desktop
// build can be verified the same way the browser build is.
// Launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   node design/drive-tauri.mjs "<expression>"
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' || t.webSocketDebuggerUrl);
if (!page) throw new Error('no CDP page target — is the app running with remote debugging?');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p(msg);
  }
});

const send = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r));

const expression = process.argv[2];
const res = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

if (res.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails, null, 1));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(res.result?.result?.value, null, 1));
}
ws.close();
