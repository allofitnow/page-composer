//! Publishing to the Payload CMS: upload the composed media, then create or
//! update the project. Payload's own `afterChange` hook fires the Astro rebuild.

use crate::config::Config;
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use tauri::{Emitter, State};

/// A publish that stalls leaves no evidence: the app is a GUI binary with no
/// console, so `eprintln!` goes nowhere and the only signal was the button
/// sitting on PUBLISHING. Every step is appended to a file instead, which
/// survives the hang and can be read while the process is still stuck.
pub fn trace(what: &str) {
    use std::io::Write;
    let line = format!(
        "{:>8.3}s  {what}\n",
        std::time::UNIX_EPOCH.elapsed().map(|d| d.as_secs_f64() % 86400.0).unwrap_or(0.0)
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("page-composer-publish.log"))
    {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

/// The layouts the Projects collection accepts. Anything else is rejected by
/// Payload's select validation, so the composer never invents one.
const LAYOUTS: [&str; 5] = ["full", "two-up", "split-8-4", "split-5-7", "three-up"];

/// Credentials entered through the sign-in modal, held in memory for this run
/// only. They take precedence over config.json/env so signing in as someone
/// else needs no restart, and they are never written by `Config::save` — only
/// an explicit "remember me" puts anything on disk.
static SESSION: Mutex<Option<(String, String)>> = Mutex::new(None);

/// `services` is a relationship to the editable `service-categories`
/// collection, so the list must come from the CMS rather than a constant here —
/// an editor can add one at any time. Cached briefly.
static SERVICES: Mutex<Option<(std::time::Instant, Vec<ServiceCategory>)>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug)]
pub struct ServiceCategory {
    pub id: String,
    pub label: String,
}

pub async fn service_categories(cfg: &Config) -> Vec<ServiceCategory> {
    if let Ok(guard) = SERVICES.lock() {
        if let Some((at, list)) = guard.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(300) && !list.is_empty() {
                return list.clone();
            }
        }
    }
    let fetched = (|| async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .ok()?;
        let res = client
            .get(api(cfg, "/service-categories?limit=200&sort=label"))
            .send()
            .await
            .ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        Some(
            body["docs"]
                .as_array()?
                .iter()
                .filter_map(|d| {
                    Some(ServiceCategory {
                        id: d["id"].as_str()?.to_string(),
                        label: d["label"].as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>(),
        )
    })()
    .await;

    match fetched {
        Some(list) if !list.is_empty() => {
            if let Ok(mut guard) = SERVICES.lock() {
                *guard = Some((std::time::Instant::now(), list.clone()));
            }
            list
        }
        // Offline is not fatal — the picker shows whatever was last seen.
        _ => SERVICES
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|(_, l)| l.clone()))
            .unwrap_or_default(),
    }
}

/// The composer stores services as labels; Payload wants relationship ids.
/// Unknown names are reported rather than invented — creating categories from a
/// typo would quietly pollute a shared taxonomy.
async fn resolve_services(cfg: &Config, names: &Value) -> (Vec<String>, Vec<String>) {
    let wanted: Vec<String> = names
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if wanted.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let list = service_categories(cfg).await;
    let mut ids = Vec::new();
    let mut unknown = Vec::new();
    for name in wanted {
        match list.iter().find(|s| s.label.trim().eq_ignore_ascii_case(name.trim())) {
            Some(found) => ids.push(found.id.clone()),
            None => unknown.push(name),
        }
    }
    (ids, unknown)
}

fn credentials(cfg: &Config) -> (String, String) {
    if let Ok(guard) = SESSION.lock() {
        if let Some((email, password)) = guard.as_ref() {
            return (email.clone(), password.clone());
        }
    }
    (cfg.payload.email.clone(), cfg.payload.password.clone())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PayloadStatus {
    pub reachable: bool,
    pub url: String,
    pub credentials: bool,
    pub email: String,
}

fn api(cfg: &Config, path: &str) -> String {
    format!("{}/api{}", cfg.payload.url.trim_end_matches('/'), path)
}

pub async fn status(cfg: &Config) -> PayloadStatus {
    let reachable = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    {
        Ok(client) => client
            .get(api(cfg, "/projects?limit=1"))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false),
        Err(_) => false,
    };

    let (email, password) = credentials(cfg);
    PayloadStatus {
        reachable,
        url: cfg.payload.url.clone(),
        credentials: !email.is_empty() && !password.is_empty(),
        email,
    }
}

/// Exchanges a login for a JWT, or fails with Payload's own reason.
async fn authenticate(client: &reqwest::Client, cfg: &Config, email: &str, password: &str) -> Result<Value> {
    let res = client
        .post(api(cfg, "/users/login"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await?;
    if !res.status().is_success() {
        // 401 is a wrong email/password; anything else is the server or network.
        if res.status().as_u16() == 401 {
            bail!("Payload login failed: wrong email or password");
        }
        bail!("Payload login failed: {} {}", res.status(), res.text().await.unwrap_or_default());
    }
    Ok(res.json::<Value>().await?)
}

async fn login(client: &reqwest::Client, cfg: &Config) -> Result<String> {
    let (email, password) = credentials(cfg);
    if email.is_empty() || password.is_empty() {
        bail!("not signed in to Payload — use SIGN IN, or set PAYLOAD_ADMIN_EMAIL and PAYLOAD_ADMIN_PASSWORD");
    }
    let res = client
        .post(api(cfg, "/users/login"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await?;
    if !res.status().is_success() {
        bail!("Payload login failed: {} {}", res.status(), res.text().await.unwrap_or_default());
    }
    res.json::<Value>()
        .await?
        .get("token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("Payload login returned no token"))
}

fn mime_for(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

async fn upload_media(
    client: &reqwest::Client,
    cfg: &Config,
    jwt: &str,
    file: &Path,
    alt: &str,
) -> Result<(String, bool, String)> {
    let name = file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("bad media path"))?;

    // Payload keeps filenames unique, so a re-publish would otherwise pile up
    // `-1` copies of the same asset.
    let found = client
        .get(api(cfg, &format!("/media?where[filename][equals]={}&limit=1", urlencode(&name))))
        .header("Authorization", format!("JWT {jwt}"))
        .send()
        .await?;
    if found.status().is_success() {
        let body: Value = found.json().await?;
        if body.get("totalDocs").and_then(|v| v.as_u64()).unwrap_or(0) > 0 {
            if let Some(id) = body["docs"][0]["id"].as_str() {
                return Ok((id.to_string(), true, name));
            }
        }
    }

    let bytes = std::fs::read(file)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name.clone())
        .mime_str(mime_for(&name))?;
    let form = reqwest::multipart::Form::new()
        .text("alt", alt.to_string())
        .part("file", part);

    let res = client
        .post(api(cfg, "/media"))
        .header("Authorization", format!("JWT {jwt}"))
        .multipart(form)
        .send()
        .await?;
    if !res.status().is_success() {
        bail!("upload {name} failed: {} {}", res.status(), res.text().await.unwrap_or_default());
    }
    let body: Value = res.json().await?;
    let id = body["doc"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("upload {name}: no id in response"))?
        .to_string();
    Ok((id, false, name))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub id: String,
    pub slug: String,
    pub code: String,
    pub order: i64,
    pub url: String,
    pub media_count: usize,
    pub messages: Vec<String>,
}

/// Signs in to the CMS from the app. The password is checked against Payload
/// before anything is kept, so a typo is reported here rather than halfway
/// through a publish. It stays in memory unless `remember` is set.
#[tauri::command]
pub async fn payload_login(
    state: State<'_, AppState>,
    email: String,
    password: String,
    remember: bool,
) -> Result<Value, String> {
    let (cfg, config_path) = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        (guard.clone(), state.config_path.clone())
    };
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("email and password are both required".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let body = authenticate(&client, &cfg, &email, &password)
        .await
        .map_err(|e| e.to_string())?;
    let who = body["user"]["email"].as_str().unwrap_or(&email).to_string();

    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some((email.clone(), password.clone()));
    }

    {
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        // The address alone is safe to keep and saves retyping; the password is
        // only written to disk when explicitly asked for.
        guard.payload.email = email;
        guard.payload.password = if remember { password } else { String::new() };
        guard.save(&config_path).map_err(|e| e.to_string())?;
    }

    Ok(json!({ "ok": true, "email": who, "remembered": remember }))
}

#[tauri::command]
pub async fn payload_logout(state: State<'_, AppState>) -> Result<Value, String> {
    if let Ok(mut guard) = SESSION.lock() {
        *guard = None;
    }
    let config_path = state.config_path.clone();
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    // Forget the stored password but keep the address, so signing back in is
    // one field.
    guard.payload.password = String::new();
    guard.save(&config_path).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn publish_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    fields: Value,
    manifest_path: String,
) -> Result<PublishResult, String> {
    trace("=== publish_project entered ===");
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let out = run_publish(&app, &cfg, fields, &manifest_path)
        .await
        .map_err(|e| e.to_string());
    match &out {
        Ok(_) => trace("=== publish_project returning Ok ==="),
        Err(e) => trace(&format!("=== publish_project returning Err: {e} ===")),
    }
    out
}

/// Publishing used to report nothing until it finished, so a stall anywhere in
/// it looked identical to a hang: the button simply sat on PUBLISHING. Every
/// step is now emitted as it happens, which is the difference between "it is
/// broken" and "it stopped on the project write".
fn say(app: &tauri::AppHandle, messages: &mut Vec<String>, text: impl Into<String>) {
    let text = text.into();
    trace(&text);
    // `emit` is not a fire-and-forget call: it dispatches an eval to the webview
    // and waits on the event loop for the round trip, so a busy front end can
    // block the publish itself. Progress reporting must never be able to stall
    // the thing it is reporting on, so the emit is spawned and this returns now.
    let app = app.clone();
    let payload = serde_json::json!({ "message": text.clone() });
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("publish://progress", payload);
    });
    messages.push(text);
}

async fn run_publish(
    app: &tauri::AppHandle,
    cfg: &Config,
    fields: Value,
    manifest_path: &str,
) -> Result<PublishResult> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(manifest_path)?)?;
    let out_dir = manifest["outDir"].as_str().unwrap_or_default().to_string();
    let items: Vec<&Value> = manifest["items"]
        .as_array()
        .map(|a| a.iter().filter(|i| i["status"] == "done").collect())
        .unwrap_or_default();
    if items.is_empty() {
        bail!("nothing composed — run Compose first");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;
    let mut messages = vec![format!("authenticating with {}", cfg.payload.url)];
    let jwt = login(&client, cfg).await?;

    let title = fields["title"].as_str().unwrap_or_default().to_string();
    let slug = fields["slug"].as_str().unwrap_or_default().to_string();
    if slug.is_empty() {
        bail!("slug is required");
    }

    let mut image: Option<String> = None;
    // Gallery rows are rebuilt from the manifest: every composed tile records the
    // row it belongs to and its slot within that row, so the arrangement made in
    // the rail survives into Payload's `{ layout, images }` shape.
    let mut rows: BTreeMap<u64, (String, Vec<(u64, String)>)> = BTreeMap::new();

    for item in &items {
        let output = item["output"].as_str().unwrap_or_default();
        let role = item["role"].as_str().unwrap_or("gallery");
        let layout = item["layout"].as_str().unwrap_or("full").to_string();
        let row = item["row"].as_u64();
        let slot = item["slot"].as_u64();
        let file = Path::new(&out_dir).join(output);

        say(app, &mut messages, format!("uploading {output}"));
        let (id, reused, name) = upload_media(
            &client,
            cfg,
            &jwt,
            &file,
            &format!("{title} — {}", item["description"].as_str().unwrap_or("asset")),
        )
        .await?;
        say(app, &mut messages, format!("{} {name}", if reused { "reused" } else { "uploaded" }));

        match role {
            // The collection has ONE key image, used as both the work-grid
            // thumbnail and the project hero — there is no separate thumb field.
            "hero" => image = Some(id),
            // Still written to disk (the crop is useful locally), but the CMS
            // only wants the one image, so it is not uploaded into a field.
            "thumb" => {}
            _ => {
                let ri = row.unwrap_or(rows.len() as u64);
                let entry = rows.entry(ri).or_insert_with(|| (layout.clone(), Vec::new()));
                let next = entry.1.len() as u64;
                entry.1.push((slot.unwrap_or(next), id));
            }
        }
    }

    trace("loop done, building gallery rows");
    let gallery: Vec<Value> = rows
        .into_values()
        .map(|(layout, mut slots)| {
            slots.sort_by_key(|(slot, _)| *slot);
            let layout = if LAYOUTS.contains(&layout.as_str()) { layout } else { "full".to_string() };
            json!({
                "layout": layout,
                "images": slots.into_iter().map(|(_, id)| json!({ "image": id })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let image = image.ok_or_else(|| anyhow!("no hero picked — the CMS requires one key image"))?;

    say(app, &mut messages, "resolving services against the CMS list");
    let (service_ids, unknown_services) = resolve_services(cfg, &fields["services"]).await;
    trace("services resolved");
    if !unknown_services.is_empty() {
        say(
            app,
            &mut messages,
            format!("not in the CMS service list, skipped: {}", unknown_services.join(", ")),
        );
    }

    // `writeup` is a Slate rich-text field, so paragraphs are nodes, not strings.
    let mut paragraphs: Vec<String> = Vec::new();
    if let Some(lead) = fields["writeup"]["lead"].as_str() {
        if !lead.trim().is_empty() {
            paragraphs.push(lead.to_string());
        }
    }
    if let Some(body) = fields["writeup"]["body"].as_array() {
        paragraphs.extend(
            body.iter()
                .filter_map(|p| p.as_str())
                .filter(|p| !p.trim().is_empty())
                .map(|p| p.to_string()),
        );
    }
    // The paragraphs are Markdown - that is how formatting survives from the
    // doc through step 04 - so they are converted, not wrapped verbatim.
    trace(&format!("converting {} writeup paragraphs", paragraphs.len()));
    // A panic inside a Tauri command does not surface as a rejected promise —
    // the front end simply waits for a reply that never comes, which is exactly
    // how a byte-boundary panic in here presented: PUBLISHING, forever. The
    // conversion is pure and synchronous, so catching is both safe and enough to
    // turn any future one back into an error somebody can read.
    let writeup: Vec<Value> = std::panic::catch_unwind(|| crate::richtext::paragraphs_to_slate(&paragraphs))
        .map_err(|_| anyhow!("the write-up could not be converted to rich text"))?;
    trace("writeup converted");

    let mut doc = json!({
        "title": title,
        "slug": slug,
        "code": "TEMP", // the collection's beforeChange hook derives the real code
        "status": "published",
        "year": fields["year"].as_str().unwrap_or_default(),
        "capabilities": fields["capabilities"],
        "stats": fields["stats"],
        "credits": fields["credits"],
        "image": image,
        "gallery": gallery,
    });
    if !writeup.is_empty() {
        doc["writeup"] = json!(writeup);
    }
    // Always written, both ways: unticking it on a re-publish has to be able to
    // take a project off the home page, which an "only send it when true" rule
    // could not do.
    doc["featured"] = json!(fields["featured"].as_bool().unwrap_or(false));
    match (doc["featured"].as_bool(), fields["featuredOrder"].as_u64()) {
        (Some(true), Some(n)) => doc["featuredOrder"] = json!(n),
        _ => doc["featuredOrder"] = Value::Null,
    }
    if !service_ids.is_empty() {
        doc["services"] = json!(service_ids);
    }
    for key in ["tour", "collaborator", "summary"] {
        if let Some(v) = fields[key].as_str() {
            if !v.trim().is_empty() {
                doc[key] = json!(v);
            }
        }
    }

    say(app, &mut messages, format!("looking up {slug} in the CMS"));
    trace("sending the lookup request");
    let existing = client
        .get(api(cfg, &format!("/projects?where[slug][equals]={}&limit=1", urlencode(&slug))))
        .header("Authorization", format!("JWT {jwt}"))
        .send()
        .await?;
    let existing_doc: Option<Value> = if existing.status().is_success() {
        existing
            .json::<Value>()
            .await
            .ok()
            .and_then(|b| b["docs"].as_array().and_then(|a| a.first().cloned()))
    } else {
        None
    };

    let res = if let Some(prev) = &existing_doc {
        say(app, &mut messages, format!("updating existing project {slug}"));
        doc["order"] = prev["order"].clone();
        client
            .patch(api(cfg, &format!("/projects/{}", prev["id"].as_str().unwrap_or_default())))
            .header("Authorization", format!("JWT {jwt}"))
            .json(&doc)
            .send()
            .await?
    } else {
        let order = next_order(&client, cfg, &jwt).await;
        doc["order"] = json!(order);
        say(app, &mut messages, format!("creating project {slug} at order {order}"));
        client
            .post(api(cfg, "/projects"))
            .header("Authorization", format!("JWT {jwt}"))
            .json(&doc)
            .send()
            .await?
    };

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("project write failed: {status} {text}");
    }
    let saved: Value = serde_json::from_str(&text)?;
    let saved = saved.get("doc").cloned().unwrap_or(saved);

    say(app, &mut messages, "Payload afterChange hook fired — Astro rebuild queued");

    Ok(PublishResult {
        id: saved["id"].as_str().unwrap_or_default().to_string(),
        slug: saved["slug"].as_str().unwrap_or(&slug).to_string(),
        code: saved["code"].as_str().unwrap_or_default().to_string(),
        order: saved["order"].as_i64().unwrap_or(0),
        url: format!(
            "{}/work/{}",
            cfg.payload.url.trim_end_matches('/'),
            saved["slug"].as_str().unwrap_or(&slug)
        ),
        media_count: items.len(),
        messages,
    })
}

async fn next_order(client: &reqwest::Client, cfg: &Config, jwt: &str) -> i64 {
    let Ok(res) = client
        .get(api(cfg, "/projects?limit=1&sort=-order"))
        .header("Authorization", format!("JWT {jwt}"))
        .send()
        .await
    else {
        return 1;
    };
    let Ok(body) = res.json::<Value>().await else { return 1 };
    body["docs"][0]["order"].as_i64().unwrap_or(0) + 1
}
