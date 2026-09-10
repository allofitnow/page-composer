// Publishing the SITE, as opposed to a project: the Astro rebuild that turns
// whatever the CMS holds into pages. Since 2026-09-07 nothing on the CMS host
// runs it by itself — the only trigger is the team's MCP server on .245, whose
// `publish` tool runs deploy/publish.sh and blocks until the build is green.
// nginx already proxies /mcp on the CMS address, with a day-long read timeout,
// so the app can call it from any machine with the bearer token.
//
// The protocol is MCP over streamable HTTP: initialize, say so, call the tool,
// close the session. Replies come back as either JSON or a short SSE stream
// depending on the server's mood, and both are read the same way.

import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

const PROTOCOL = '2025-06-18';

/** The JSON-RPC message with this id, out of a JSON body or an SSE stream. */
async function readRpc(res, id) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  let messages;
  if (type.includes('text/event-stream')) {
    messages = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } else {
    try {
      messages = [JSON.parse(text)];
    } catch {
      throw new Error(`the MCP server sent something that is not JSON: ${text.slice(0, 200)}`);
    }
  }
  const msg = messages.flat().find((m) => m && m.id === id);
  if (!msg) throw new Error(`no reply to request ${id}: ${text.slice(0, 200)}`);
  if (msg.error) throw new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`);
  return msg.result;
}

/**
 * Calls one MCP tool and returns its structured result. Every session is
 * opened and closed here — the app never keeps one, because a publish is
 * minutes apart from the next and the server forgets idle sessions anyway.
 */
export async function mcpCall(name, args = {}) {
  const token = config.payload.publishToken || '';
  if (!token) throw new Error('no publish token — add it under ROOTS');
  const url = `${config.payload.url.replace(/\/$/, '')}/mcp`;
  const base = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...base, ...extra }, body: JSON.stringify(body) });

  let res = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'aoin-page-composer', version: VERSION } },
  });
  if (res.status === 401 || res.status === 403) throw new Error('the publish token was refused — check it under ROOTS');
  if (!res.ok) throw new Error(`the MCP server refused to start a session: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const session = res.headers.get('mcp-session-id') || '';
  const init = await readRpc(res, 1);
  const negotiated = init?.protocolVersion || PROTOCOL;
  const withSession = { 'MCP-Protocol-Version': negotiated, ...(session ? { 'Mcp-Session-Id': session } : {}) };

  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, withSession);
    res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, withSession);
    if (!res.ok) throw new Error(`MCP call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const result = await readRpc(res, 2);
    const text = (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) throw new Error(text || `the ${name} tool reported an error`);
    if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } finally {
    if (session) {
      // Best effort: a session left open costs the server nothing but memory.
      fetch(url, { method: 'DELETE', headers: { ...base, ...withSession } }).catch(() => {});
    }
  }
}

/**
 * Runs the site-wide publish and waits for it. The build takes a minute or
 * two; if the connection gives out first the publish carries on regardless,
 * which the error says, so nobody starts a second one on top of it.
 */
export async function publishSite() {
  const started = Date.now();
  let out;
  try {
    out = await mcpCall('publish', { live: true });
  } catch (err) {
    const m = String(err?.message || err);
    if (/timeout|timed out|socket|terminated|aborted/i.test(m)) {
      throw new Error(`lost the connection while the site was building — the publish is still running on the server, so give it a minute and check the site (${m})`);
    }
    throw err;
  }
  const success = out?.success !== false;
  const log = String(out?.build_log_tail || out?.text || '');
  return { success, log, timestamp: out?.timestamp || '', seconds: Math.round((Date.now() - started) / 1000) };
}
