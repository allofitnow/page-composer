//! Publishing the SITE, as opposed to a project: the Astro rebuild that turns
//! whatever the CMS holds into pages. Since 2026-09-07 nothing on the CMS host
//! runs it by itself — the only trigger is the team's MCP server on .245,
//! whose `publish` tool runs deploy/publish.sh and blocks until the build is
//! green. nginx already proxies /mcp on the CMS address, with a day-long read
//! timeout, so the app can call it from any machine with the bearer token.
//!
//! The protocol is MCP over streamable HTTP: initialize, say so, call the
//! tool, close the session. Replies come back as either JSON or a short SSE
//! stream depending on the server's mood, and both are read the same way.
//! Mirrors server/site.js — keep the two in step.

use crate::config::Config;
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

const PROTOCOL: &str = "2025-06-18";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SitePublish {
    pub success: bool,
    pub log: String,
    pub timestamp: String,
    pub seconds: u64,
}

/// The JSON-RPC message with this id, out of a JSON body or an SSE stream.
async fn read_rpc(res: reqwest::Response, id: u64) -> Result<Value> {
    let kind = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = res.text().await?;
    let messages: Vec<Value> = if kind.contains("text/event-stream") {
        text.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
            .flat_map(|v| match v {
                Value::Array(items) => items,
                other => vec![other],
            })
            .collect()
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(items)) => items,
            Ok(other) => vec![other],
            Err(_) => bail!("the MCP server sent something that is not JSON: {}", excerpt(&text)),
        }
    };
    let msg = messages
        .into_iter()
        .find(|m| m["id"] == json!(id))
        .ok_or_else(|| anyhow!("no reply to request {id}: {}", excerpt(&text)))?;
    if let Some(e) = msg.get("error") {
        bail!("MCP error: {}", e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
    }
    Ok(msg["result"].clone())
}

fn excerpt(s: &str) -> String {
    s.chars().take(200).collect()
}

async fn post(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    extra: &[(&str, &str)],
    body: Value,
) -> Result<reqwest::Response> {
    let mut req = client
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .json(&body);
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    Ok(req.send().await?)
}

/// Calls one MCP tool and returns its structured result. Every session is
/// opened and closed here — the app never keeps one, because a publish is
/// minutes apart from the next and the server forgets idle sessions anyway.
pub async fn mcp_call(cfg: &Config, name: &str, args: Value) -> Result<Value> {
    let token = publish_token(cfg);
    if token.is_empty() {
        bail!("no publish token — add it under ROOTS");
    }
    let url = format!("{}/mcp", cfg.payload.url.trim_end_matches('/'));
    // A build timeout, not a request timeout: the call blocks for the whole build.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;

    let res = post(
        &client,
        &url,
        &token,
        &[],
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": { "name": "aoin-page-composer", "version": env!("CARGO_PKG_VERSION") },
            },
        }),
    )
    .await?;
    let status = res.status().as_u16();
    if status == 401 || status == 403 {
        bail!("the publish token was refused — check it under ROOTS");
    }
    if !res.status().is_success() {
        let code = res.status();
        bail!("the MCP server refused to start a session: {code} {}", excerpt(&res.text().await.unwrap_or_default()));
    }
    let session = res
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let init = read_rpc(res, 1).await?;
    let negotiated = init["protocolVersion"].as_str().unwrap_or(PROTOCOL).to_string();
    let mut extra: Vec<(&str, &str)> = vec![("MCP-Protocol-Version", negotiated.as_str())];
    if !session.is_empty() {
        extra.push(("Mcp-Session-Id", session.as_str()));
    }

    let outcome = async {
        post(&client, &url, &token, &extra, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        let res = post(
            &client,
            &url,
            &token,
            &extra,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": args } }),
        )
        .await?;
        if !res.status().is_success() {
            let code = res.status();
            bail!("MCP call failed: {code} {}", excerpt(&res.text().await.unwrap_or_default()));
        }
        let result = read_rpc(res, 2).await?;
        let text = result["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|c| c["type"] == "text")
                    .filter_map(|c| c["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if result["isError"].as_bool().unwrap_or(false) {
            bail!("{}", if text.is_empty() { format!("the {name} tool reported an error") } else { text });
        }
        if result["structuredContent"].is_object() {
            return Ok(result["structuredContent"].clone());
        }
        Ok(serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "text": text })))
    }
    .await;

    if !session.is_empty() {
        // Best effort: a session left open costs the server nothing but memory.
        let mut req = client.delete(&url).bearer_auth(&token);
        for (k, v) in &extra {
            req = req.header(*k, *v);
        }
        let _ = req.send().await;
    }
    outcome
}

/// The bearer token, with the environment winning so it never has to sit on disk.
pub fn publish_token(cfg: &Config) -> String {
    std::env::var("MCP_BEARER_TOKEN").unwrap_or_else(|_| cfg.payload.publish_token.clone())
}

/// Runs the site-wide publish and waits for it. The build takes a minute or
/// two; if the connection gives out first the publish carries on regardless,
/// which the error says, so nobody starts a second one on top of it.
#[tauri::command]
pub async fn publish_site(state: State<'_, AppState>) -> Result<SitePublish, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let started = std::time::Instant::now();
    let out = mcp_call(&cfg, "publish", json!({ "live": true })).await.map_err(|e| {
        let m = e.to_string();
        let lower = m.to_lowercase();
        if lower.contains("timed out") || lower.contains("timeout") || lower.contains("connection") && lower.contains("reset") {
            format!("lost the connection while the site was building — the publish is still running on the server, so give it a minute and check the site ({m})")
        } else {
            m
        }
    })?;
    Ok(SitePublish {
        success: out["success"].as_bool().unwrap_or(true),
        log: out["build_log_tail"]
            .as_str()
            .or_else(|| out["text"].as_str())
            .unwrap_or_default()
            .to_string(),
        timestamp: out["timestamp"].as_str().unwrap_or_default().to_string(),
        seconds: started.elapsed().as_secs(),
    })
}
