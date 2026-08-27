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
const LAYOUTS: [&str; 10] = [
    "full",
    "full-16-9",
    "full-2-1",
    "full-3-1",
    "full-19-5",
    "full-27-4",
    "two-up",
    "split-8-4",
    "split-5-7",
    "three-up",
];

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
) -> Result<(String, &'static str, String)> {
    let name = file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("bad media path"))?;

    let local_size = std::fs::metadata(file)?.len();

    // Payload keeps filenames unique, so a re-publish would otherwise pile up
    // `-1` copies of the same asset.
    //
    // But matching on the NAME alone was wrong, and quietly so. Output names are
    // positional -- `..._gallery02.webp` is whatever sits second in the rail --
    // so re-composing a different image, or merely reordering the carousel,
    // produces the same filenames holding different pictures. Reusing on the
    // name meant the CMS kept serving the old file and the page never changed;
    // reordering actively published the WRONG images under the right names.
    //
    // Size is the discriminator: a re-encode of the same source at the same
    // settings is byte-identical, and any other picture differs. When it does
    // differ the file on the existing doc is replaced rather than a new doc
    // created, so the media id stays stable and nothing referencing it breaks.
    let mut existing: Option<String> = None;
    let found = client
        .get(api(cfg, &format!("/media?where[filename][equals]={}&limit=1", urlencode(&name))))
        .header("Authorization", format!("JWT {jwt}"))
        .send()
        .await?;
    if found.status().is_success() {
        let body: Value = found.json().await?;
        if body.get("totalDocs").and_then(|v| v.as_u64()).unwrap_or(0) > 0 {
            if let Some(id) = body["docs"][0]["id"].as_str() {
                let remote_size = body["docs"][0]["filesize"].as_u64();
                if remote_size == Some(local_size) {
                    return Ok((id.to_string(), "reused", name));
                }
                existing = Some(id.to_string());
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

    // Replacing in place keeps the id, so every project already pointing at this
    // media doc picks the new file up too.
    let res = match &existing {
        Some(id) => {
            client
                .patch(api(cfg, &format!("/media/{id}")))
                .header("Authorization", format!("JWT {jwt}"))
                .multipart(form)
                .send()
                .await?
        }
        None => {
            client
                .post(api(cfg, "/media"))
                .header("Authorization", format!("JWT {jwt}"))
                .multipart(form)
                .send()
                .await?
        }
    };
    if !res.status().is_success() {
        bail!("upload {name} failed: {} {}", res.status(), res.text().await.unwrap_or_default());
    }
    if let Some(id) = existing {
        return Ok((id, "replaced", name));
    }
    let body: Value = res.json().await?;
    let id = body["doc"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("upload {name}: no id in response"))?
        .to_string();
    Ok((id, "uploaded", name))
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
        let (id, action, name) = upload_media(
            &client,
            cfg,
            &jwt,
            &file,
            &format!("{title} — {}", item["description"].as_str().unwrap_or("asset")),
        )
        .await?;
        say(app, &mut messages, format!("{action} {name}"));

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
        // An explicit pick on step 04 wins; blank means "as stored", which for a
        // new project is published and for an existing one is whatever the update
        // branch below puts back -- so re-publishing never re-lists an unlisted page.
        "status": match fields["status"].as_str() {
            Some(s) if !s.is_empty() => s,
            _ => "published",
        },
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
    // Only meaningful on a create -- the update branch below puts the stored
    // values back, because this form has no idea what they are.
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
        // Same reasoning as `order`: the form cannot know the document's status,
        // and `unlisted` is a deliberate editorial choice (the page builds, but
        // nothing on the site links to it). Forcing "published" here would quietly
        // undo that on every re-publish. Archive carries over for the same reason.
        if fields["status"].as_str().unwrap_or_default().is_empty() {
            doc["status"] = match prev["status"].as_str() {
                Some(s) if !s.is_empty() => json!(s),
                _ => json!("published"),
            };
        }
        // The publish form is built from the asset folder and the copy doc,
        // never from the document, so the Featured box reads unticked whatever
        // the CMS holds. Sending that back would drop the project off the home
        // marquee as a side effect of re-publishing it -- so an unticked box
        // carries the stored values over instead, the same as `order` directly
        // above. Ticking still features, because that one the operator meant.
        // Taking a project off the marquee is a CMS-side edit now.
        if !fields["featured"].as_bool().unwrap_or(false) {
            doc["featured"] = json!(prev["featured"].as_bool().unwrap_or(false));
            doc["featuredOrder"] = match prev["featuredOrder"].as_u64() {
                Some(n) => json!(n),
                None => Value::Null,
            };
        }
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

// ---------------------------------------------------------------------------
// The WORK page's running order.
//
// Reading is unauthenticated on purpose: the collection allows public reads, so
// the screen opens and shows the real grid before anyone signs in. Writing
// needs the login, and says so in the UI rather than failing at the end.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkProject {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub code: String,
    pub year: String,
    pub order: Option<f64>,
    pub featured: bool,
    /// Absolute url of the key image, or empty when the project has none.
    pub image: String,
}

/// Sorts a project list the way the site builds it: the manual `order` decides,
/// lowest first, and the year only settles a tie between two projects sharing a
/// number. Mirrors `getProjects` in frontend/src/lib/payload.ts — if that
/// comparator changes, this one has to follow, or the app would show an order
/// the site does not.
fn sort_like_the_site(list: &mut [WorkProject]) {
    list.sort_by(|a, b| {
        let ya: i64 = a.year.trim().parse().unwrap_or(0);
        let yb: i64 = b.year.trim().parse().unwrap_or(0);
        a.order
            .unwrap_or(0.0)
            .partial_cmp(&b.order.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(yb.cmp(&ya))
    });
}

fn work_project_from(cfg: &Config, doc: &Value) -> Option<WorkProject> {
    let image = doc["image"]["url"].as_str().unwrap_or_default();
    Some(WorkProject {
        id: doc["id"].as_str()?.to_string(),
        title: doc["title"].as_str().unwrap_or_default().to_string(),
        slug: doc["slug"].as_str().unwrap_or_default().to_string(),
        code: doc["code"].as_str().unwrap_or_default().to_string(),
        year: doc["year"].as_str().unwrap_or_default().to_string(),
        order: doc["order"].as_f64(),
        featured: doc["featured"].as_bool().unwrap_or(false),
        image: if image.is_empty() {
            String::new()
        } else if image.starts_with("http") {
            image.to_string()
        } else {
            format!("{}{image}", cfg.payload.url.trim_end_matches('/'))
        },
    })
}

async fn work_order(client: &reqwest::Client, cfg: &Config) -> Result<Vec<WorkProject>> {
    let res = client
        .get(api(cfg, "/projects?limit=200&depth=1&sort=order&where[status][equals]=published"))
        .send()
        .await?;
    if !res.status().is_success() {
        bail!("could not read the work page: {} {}", res.status(), res.text().await.unwrap_or_default());
    }
    let body: Value = res.json().await?;
    let mut list: Vec<WorkProject> = body["docs"]
        .as_array()
        .map(|a| a.iter().filter_map(|d| work_project_from(cfg, d)).collect())
        .unwrap_or_default();
    sort_like_the_site(&mut list);
    Ok(list)
}

#[tauri::command]
pub async fn list_work_order(state: State<'_, AppState>) -> Result<Vec<WorkProject>, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    work_order(&client, &cfg).await.map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct OrderChange {
    pub id: String,
    pub order: f64,
}

/// Writes the planned `order` values, one document at a time, and reports each
/// one as it lands.
///
/// One at a time is not caution, it is the only correct way: Payload's
/// afterChange hook runs the site build SYNCHRONOUSLY, so two writes in flight
/// would be two builds fighting over the same checkout. It also means a write
/// takes about as long as a build, which is why the progress event exists —
/// there is nothing else to distinguish a legitimate five-minute save from a
/// hang.
///
/// Only `order` is sent. A partial update leaves `data.title` unset, so the
/// collection's beforeChange hook returns early and the project's generated
/// code is left alone; sending the whole document back would put that at risk
/// for no gain.
#[tauri::command]
pub async fn save_work_order(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    changes: Vec<OrderChange>,
) -> Result<Vec<WorkProject>, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        // A single write waits for a whole Astro build, so this is a build
        // timeout rather than a request timeout.
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let jwt = login(&client, &cfg).await.map_err(|e| e.to_string())?;

    let titles: std::collections::HashMap<String, String> = work_order(&client, &cfg)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|p| (p.id, p.title))
        .collect();

    let total = changes.len();
    for (i, change) in changes.iter().enumerate() {
        let title = titles.get(&change.id).cloned().unwrap_or_else(|| change.id.clone());
        emit_reorder(&app, i, total, &title);
        let res = client
            .patch(api(&cfg, &format!("/projects/{}", change.id)))
            .header("Authorization", format!("JWT {jwt}"))
            .json(&json!({ "order": change.order }))
            .send()
            .await
            .map_err(|e| format!("{title}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!(
                "{title}: {} {}",
                res.status(),
                res.text().await.unwrap_or_default()
            ));
        }
        emit_reorder(&app, i + 1, total, &title);
    }

    // Re-read rather than patching the list held in the front end: the CMS is
    // the thing being edited, so the screen should come back showing what it
    // actually says.
    work_order(&client, &cfg).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// One published project's gallery, for rearranging in place.
//
// This is the other half of the work-page screen: the running order decides
// which projects come first, this decides what a project's own page looks like
// once you are inside it. Nothing is uploaded — every image here is already in
// the CMS, so a reflow is one document write rather than a re-compose.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GalleryImage {
    pub id: String,
    pub url: String,
    pub name: String,
    pub video: bool,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GalleryRow {
    pub layout: String,
    pub images: Vec<GalleryImage>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CmsProject {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub year: String,
    pub url: String,
    /// The upload name every file of this project shares, which is how the rest
    /// of its media is found again. Empty when nothing could be read off.
    pub base: String,
    /// The key image, so the library can say so rather than offering it as if
    /// it were spare.
    pub key_image: String,
    pub gallery: Vec<GalleryRow>,
}

/// The shared half of an upload name.
///
/// The composer writes `{base}_{role}{nn}.{ext}` — `linkin-park-from-zero-tour`
/// plus `_gallery03.mp4` — so everything before the first underscore groups a
/// project's files. It is not the slug: a slug is `kid-laroi` where the files
/// are `the-kid-laroi-a-perfect-world-tour`, which is why this is read off a
/// real filename rather than derived.
fn upload_base(filename: &str) -> String {
    match filename.find('_') {
        Some(at) if at > 0 => filename[..at].to_string(),
        _ => String::new(),
    }
}

fn absolute(cfg: &Config, url: &str) -> String {
    if url.is_empty() || url.starts_with("http") {
        url.to_string()
    } else {
        format!("{}{url}", cfg.payload.url.trim_end_matches('/'))
    }
}

fn gallery_image(cfg: &Config, media: &Value) -> Option<GalleryImage> {
    // At depth 2 the relation is the media document; a project saved another
    // way can still leave a bare id behind, and an entry that is only an id has
    // no url to show, so it is dropped rather than rendered as a hole.
    let id = media["id"].as_str()?;
    let mime = media["mimeType"].as_str().unwrap_or_default();
    let url = media["url"].as_str().unwrap_or_default();
    Some(GalleryImage {
        id: id.to_string(),
        url: absolute(cfg, url),
        name: media["filename"].as_str().unwrap_or_default().to_string(),
        video: mime.starts_with("video/"),
        width: media["width"].as_u64(),
        height: media["height"].as_u64(),
    })
}

#[tauri::command]
pub async fn cms_project(state: State<'_, AppState>, id: String) -> Result<CmsProject, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(api(&cfg, &format!("/projects/{}?depth=2", urlencode(&id))))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("could not read the project: {}", res.status()));
    }
    let doc: Value = res.json().await.map_err(|e| e.to_string())?;

    let gallery = doc["gallery"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let images: Vec<GalleryImage> = row["images"]
                        .as_array()
                        .map(|imgs| imgs.iter().filter_map(|i| gallery_image(&cfg, &i["image"])).collect())
                        .unwrap_or_default();
                    let layout = row["layout"].as_str().unwrap_or("full").to_string();
                    GalleryRow {
                        layout: if LAYOUTS.contains(&layout.as_str()) { layout } else { "full".into() },
                        images,
                    }
                })
                // A row whose images all failed to resolve would render as an
                // empty band nobody could drag out of.
                .filter(|r| !r.images.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // The key image first, because it is the one file a project is guaranteed
    // to have; a gallery entry is the fallback for anything odd.
    let base = [doc["image"]["filename"].as_str().unwrap_or_default()]
        .into_iter()
        .chain(
            doc["gallery"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|r| r["images"].as_array().into_iter().flatten())
                .map(|i| i["image"]["filename"].as_str().unwrap_or_default()),
        )
        .map(upload_base)
        .find(|b| !b.is_empty())
        .unwrap_or_default();

    let slug = doc["slug"].as_str().unwrap_or_default().to_string();
    Ok(CmsProject {
        id: doc["id"].as_str().unwrap_or(&id).to_string(),
        title: doc["title"].as_str().unwrap_or_default().to_string(),
        year: doc["year"].as_str().unwrap_or_default().to_string(),
        url: format!("{}/work/{slug}", cfg.payload.url.trim_end_matches('/')),
        base,
        key_image: doc["image"]["id"].as_str().unwrap_or_default().to_string(),
        slug,
        gallery,
    })
}

/// Everything in the CMS whose filename contains `query` — the rest of a
/// project's uploads, so an image taken out of a gallery can be put back and
/// one that was never used can be brought in.
///
/// Nothing is uploaded from here. A file that is not in the CMS yet has to go
/// through compose and publish, which is a different job entirely.
#[tauri::command]
pub async fn cms_media(state: State<'_, AppState>, query: String) -> Result<Vec<GalleryImage>, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(api(
            &cfg,
            &format!(
                "/media?limit=200&depth=0&sort=filename&where[filename][like]={}",
                urlencode(&query)
            ),
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("could not read the media library: {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(body["docs"]
        .as_array()
        .map(|docs| docs.iter().filter_map(|m| gallery_image(&cfg, m)).collect())
        .unwrap_or_default())
}

#[derive(serde::Deserialize)]
pub struct SavedRow {
    pub layout: String,
    /// Media ids, in slot order.
    pub images: Vec<String>,
}

/// Writes a rearranged gallery back.
///
/// Only `gallery` is sent. A partial update leaves `data.title` unset, so the
/// collection's beforeChange hook returns early and the project's generated
/// code is left alone — the same reason the running order sends only `order`.
#[tauri::command]
pub async fn save_cms_gallery(
    state: State<'_, AppState>,
    id: String,
    rows: Vec<SavedRow>,
) -> Result<CmsProject, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        // The write blocks on a whole Astro build, so this is a build timeout
        // rather than a request timeout.
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let jwt = login(&client, &cfg).await.map_err(|e| e.to_string())?;

    let gallery: Vec<Value> = rows
        .iter()
        .filter(|r| !r.images.is_empty())
        .map(|r| {
            let layout = if LAYOUTS.contains(&r.layout.as_str()) { r.layout.clone() } else { "full".to_string() };
            json!({
                "layout": layout,
                "images": r.images.iter().map(|i| json!({ "image": i })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let res = client
        .patch(api(&cfg, &format!("/projects/{}", urlencode(&id))))
        .header("Authorization", format!("JWT {jwt}"))
        .json(&json!({ "gallery": gallery }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!(
            "gallery write failed: {} {}",
            res.status(),
            res.text().await.unwrap_or_default()
        ));
    }

    // Read it back rather than trusting the request: the screen should come
    // back showing what the CMS actually stored.
    cms_project(state, id).await
}

fn emit_reorder(app: &tauri::AppHandle, done: usize, total: usize, title: &str) {
    let app = app.clone();
    let payload = json!({ "done": done, "total": total, "title": title });
    tauri::async_runtime::spawn(async move {
        let _ = app.emit("reorder://progress", payload);
    });
}

/// Puts freshly composed files into the CMS and hands back what a gallery row
/// needs to show them.
///
/// The publish path does this too, but as one leg of a much bigger job: it
/// rebuilds the entire project document from the manifest — hero, write-up,
/// services, the whole gallery — which is exactly what must NOT happen here.
/// The page is already published and only wants two more pictures on the end,
/// so this uploads and stops. The rows are arranged on screen and saved by
/// `save_cms_gallery`, which writes the gallery field and nothing else.
///
/// Nothing is overwritten: `plan` numbered these past the end of what is
/// already up, so every filename here is new to the collection.
#[tauri::command]
pub async fn upload_composed(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    manifest_path: String,
    alt: String,
) -> Result<Vec<GalleryImage>, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    run_upload_composed(&app, &cfg, &manifest_path, &alt)
        .await
        .map_err(|e| e.to_string())
}

async fn run_upload_composed(
    app: &tauri::AppHandle,
    cfg: &Config,
    manifest_path: &str,
    alt: &str,
) -> Result<Vec<GalleryImage>> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(manifest_path)?)?;
    let out_dir = manifest["outDir"].as_str().unwrap_or_default().to_string();
    let items: Vec<&Value> = manifest["items"]
        .as_array()
        .map(|a| a.iter().filter(|i| i["status"] == "done").collect())
        .unwrap_or_default();
    if items.is_empty() {
        bail!("nothing composed — every file failed to convert");
    }

    // Videos are the slow part and they are megabytes each, so this gets the
    // publish timeout rather than the thirty seconds a read would use.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;
    let mut messages = vec![format!("authenticating with {}", cfg.payload.url)];
    let jwt = login(&client, cfg).await?;

    let mut out = Vec::new();
    for item in &items {
        let output = item["output"].as_str().unwrap_or_default();
        let file = Path::new(&out_dir).join(output);
        say(app, &mut messages, format!("uploading {output}"));
        let (id, action, name) = upload_media(
            &client,
            cfg,
            &jwt,
            &file,
            &format!("{alt} — {}", item["description"].as_str().unwrap_or("asset")),
        )
        .await?;
        say(app, &mut messages, format!("{action} {name}"));

        // `upload_media` hands back an id, not the document, and a row needs the
        // url and the mime type to draw itself — so the doc is read back. It
        // also confirms the file really landed, which a returned id alone does
        // not.
        let doc = client
            .get(api(cfg, &format!("/media/{}?depth=0", urlencode(&id))))
            .header("Authorization", format!("JWT {jwt}"))
            .send()
            .await?
            .json::<Value>()
            .await?;
        out.push(
            gallery_image(cfg, &doc)
                .ok_or_else(|| anyhow!("uploaded {name} but the CMS did not return it"))?,
        );
    }
    say(app, &mut messages, format!("{} uploaded", out.len()));
    Ok(out)
}

/// Where a brand new project lands: the FRONT of the run.
///
/// It used to be the back (highest order plus one), which was harmless while
/// the year sort came first and put new work near the top regardless. Now that
/// `order` decides the page outright, the back would bury every new project at
/// the bottom of the work grid — so a new page opens the run and can be dragged
/// from there.
async fn next_order(client: &reqwest::Client, cfg: &Config, jwt: &str) -> i64 {
    let Ok(res) = client
        .get(api(cfg, "/projects?limit=1&sort=order"))
        .header("Authorization", format!("JWT {jwt}"))
        .send()
        .await
    else {
        return 1;
    };
    let Ok(body) = res.json::<Value>().await else { return 1 };
    // floor, so a fractional order left by a drag still yields a value below it
    body["docs"][0]["order"].as_f64().unwrap_or(1.0).floor() as i64 - 1
}

// ---------------------------------------------------------------------------
// Editing a project that is ALREADY in the CMS.
//
// The Rust twin of cmsProjects / cmsProjectFields / saveCmsFields in
// server/payload.js. The rest of this module builds a project up from an asset
// folder and a copy doc; these three go the other way -- list what the CMS
// holds, read one back into the shape step 04 edits, and write just the fields
// that changed. Kept in step with the Node side deliberately: the two are the
// same feature behind two transports.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CmsListProject {
    pub id: String,
    pub title: String,
    pub slug: String,
    pub code: String,
    pub year: String,
    pub status: String,
    pub order: Option<f64>,
    pub featured: bool,
    pub image: String,
    pub has_writeup: bool,
}

/// Every project in the CMS, in the running order, for the step 01 list.
#[tauri::command]
pub async fn cms_projects(state: State<'_, AppState>) -> Result<Vec<CmsListProject>, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(api(&cfg, "/projects?limit=200&depth=1&sort=order"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("could not read the CMS: {}", res.status()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let mut list: Vec<CmsListProject> = body["docs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| {
                    let image = d["image"]["url"].as_str().unwrap_or_default();
                    // The node COUNT is not the test for a write-up: an empty
                    // rich-text field is stored as one BLANK paragraph, not as
                    // an empty array, and most of the live projects are in that
                    // state -- they would every one have advertised prose that
                    // is not there.
                    let (paras, _) = crate::richtext::slate_to_paragraphs(&d["writeup"]);
                    CmsListProject {
                        id: d["id"].as_str().unwrap_or_default().to_string(),
                        title: d["title"].as_str().unwrap_or_default().to_string(),
                        slug: d["slug"].as_str().unwrap_or_default().to_string(),
                        code: d["code"].as_str().unwrap_or_default().to_string(),
                        year: d["year"].as_str().unwrap_or_default().to_string(),
                        status: d["status"].as_str().unwrap_or("published").to_string(),
                        order: d["order"].as_f64(),
                        featured: d["featured"].as_bool().unwrap_or(false),
                        image: if image.is_empty() {
                            String::new()
                        } else if image.starts_with("http") {
                            image.to_string()
                        } else {
                            format!("{}{image}", cfg.payload.url.trim_end_matches('/'))
                        },
                        has_writeup: !paras.is_empty(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    // The manual running order decides; the year only breaks a tie.
    list.sort_by(|a, b| {
        let oa = a.order.unwrap_or(0.0);
        let ob = b.order.unwrap_or(0.0);
        oa.partial_cmp(&ob)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let ya: i64 = b.year.parse().unwrap_or(0);
                let yb: i64 = a.year.parse().unwrap_or(0);
                ya.cmp(&yb)
            })
    });
    Ok(list)
}

/// One CMS project read back into the `fields` shape step 04 edits.
///
/// `services` come back as LABELS, not ids, because that is what the form holds
/// and what resolve_services expects on the way in. The original Slate is
/// returned alongside the converted paragraphs as `writeupOriginal`, because the
/// conversion cannot represent an `upload` node -- an image or clip dropped into
/// the prose from the Payload admin. When the operator has not touched the
/// write-up, save sends the original back verbatim so those blocks survive.
#[tauri::command]
pub async fn cms_project_fields(state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(api(&cfg, &format!("/projects/{}?depth=2", urlencode(&id))))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("could not read the project: {}", res.status()));
    }
    let doc: Value = res.json().await.map_err(|e| e.to_string())?;
    let (paragraphs, dropped) = crate::richtext::slate_to_paragraphs(&doc["writeup"]);

    // At depth 2 a service is the populated category document.
    let services: Vec<String> = doc["services"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    if v.is_object() {
                        v["label"].as_str().map(|s| s.to_string())
                    } else {
                        v.as_str().map(|s| s.to_string())
                    }
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let key_image = doc["image"]["url"].as_str().unwrap_or_default();
    let key_image_url = if key_image.is_empty() {
        String::new()
    } else if key_image.starts_with("http") {
        key_image.to_string()
    } else {
        format!("{}{key_image}", cfg.payload.url.trim_end_matches('/'))
    };

    let fields = json!({
        "title": doc["title"].as_str().unwrap_or_default(),
        "slug": doc["slug"].as_str().unwrap_or_default(),
        "year": doc["year"].as_str().unwrap_or_default(),
        "tour": doc["tour"].as_str().unwrap_or_default(),
        "collaborator": doc["collaborator"].as_str().unwrap_or_default(),
        "summary": doc["summary"].as_str().unwrap_or_default(),
        "capabilities": doc["capabilities"].as_array().cloned().unwrap_or_default(),
        "services": services,
        "stats": doc["stats"].as_array().cloned().unwrap_or_default(),
        "credits": doc["credits"].as_array().cloned().unwrap_or_default(),
        "writeup": { "lead": "", "body": paragraphs },
        "writeupColumns": if doc["writeupColumns"].as_str() == Some("2") { "2" } else { "1" },
        "status": doc["status"].as_str().unwrap_or("published"),
        "featured": doc["featured"].as_bool().unwrap_or(false),
        "featuredOrder": doc["featuredOrder"].as_u64(),
    });

    Ok(json!({
        "id": doc["id"].as_str().unwrap_or(id.as_str()),
        "fields": fields,
        "writeupOriginal": doc["writeup"].as_array().cloned().unwrap_or_default(),
        "writeupDropped": dropped,
        "order": doc["order"].as_f64(),
        "code": doc["code"].as_str().unwrap_or_default(),
        "keyImage": doc["image"]["id"].as_str().unwrap_or_default(),
        "keyImageUrl": key_image_url,
        "url": format!("{}/work/{}", cfg.payload.url.trim_end_matches('/'), doc["slug"].as_str().unwrap_or_default()),
    }))
}

/// Fields this command is willing to write. Anything else is ignored rather than
/// passed through, so a stray key in the form state cannot reach the CMS.
const EDITABLE_FIELDS: &[&str] = &[
    "title", "slug", "year", "tour", "collaborator", "summary",
    "capabilities", "services", "stats", "credits",
    "writeup", "writeupColumns", "status", "featured", "featuredOrder",
];

/// Writes back ONLY the keys named in `changed`.
///
/// A partial update, the same shape save_cms_gallery uses and for the same
/// reason: leaving `data.title` unset makes the collection's beforeChange hook
/// return early, so the generated code is left alone. Sending the whole document
/// would also mean sending fields this form never loaded, which is how
/// re-publishing used to wipe things.
///
/// `writeup_slate`, when given, is sent verbatim instead of converting the
/// paragraph list -- the untouched-write-up path that preserves inline media.
#[tauri::command]
pub async fn save_cms_fields(
    state: State<'_, AppState>,
    id: String,
    fields: Value,
    changed: Vec<String>,
    writeup_slate: Option<Value>,
) -> Result<Value, String> {
    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let keys: Vec<String> = changed
        .into_iter()
        .filter(|k| EDITABLE_FIELDS.contains(&k.as_str()))
        .collect();
    if keys.is_empty() {
        return Ok(json!({ "id": id, "written": Vec::<String>::new() }));
    }

    let client = reqwest::Client::builder()
        // The write blocks on a whole Astro build, so this is a build timeout
        // rather than a request timeout.
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let jwt = login(&client, &cfg).await.map_err(|e| e.to_string())?;

    let mut doc = json!({});
    for k in &keys {
        match k.as_str() {
            "writeup" => {
                if let Some(slate) = writeup_slate.as_ref().filter(|v| v.is_array()) {
                    doc["writeup"] = slate.clone();
                } else {
                    let mut paragraphs: Vec<String> = Vec::new();
                    if let Some(lead) = fields["writeup"]["lead"].as_str() {
                        if !lead.trim().is_empty() {
                            paragraphs.push(lead.trim().to_string());
                        }
                    }
                    if let Some(body) = fields["writeup"]["body"].as_array() {
                        for p in body {
                            if let Some(t) = p.as_str() {
                                if !t.trim().is_empty() {
                                    paragraphs.push(t.trim().to_string());
                                }
                            }
                        }
                    }
                    doc["writeup"] = json!(crate::richtext::paragraphs_to_slate(&paragraphs));
                }
            }
            "services" => {
                let (ids, _unknown) = resolve_services(&cfg, &fields["services"]).await;
                doc["services"] = json!(ids);
            }
            "stats" => {
                let kept: Vec<Value> = fields["stats"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|s| {
                                !s["label"].as_str().unwrap_or_default().is_empty()
                                    && !s["value"].as_str().unwrap_or_default().is_empty()
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                doc["stats"] = json!(kept);
            }
            "credits" => {
                let kept: Vec<Value> = fields["credits"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|c| c["entries"].as_array().map(|e| !e.is_empty()).unwrap_or(false))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                doc["credits"] = json!(kept);
            }
            "featuredOrder" => {
                doc["featuredOrder"] = match fields["featuredOrder"].as_u64() {
                    Some(n) => json!(n),
                    None => Value::Null,
                };
            }
            other => {
                doc[other] = fields[other].clone();
            }
        }
    }

    let res = client
        .patch(api(&cfg, &format!("/projects/{}", urlencode(&id))))
        .header("Authorization", format!("JWT {jwt}"))
        .json(&doc)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("field write failed: {status} {text}"));
    }
    let saved: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    Ok(json!({ "id": id, "written": keys, "doc": saved["doc"].clone() }))
}
