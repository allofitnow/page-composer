//! AOIN page composer — Tauri backend.
//!
//! The front end in `web/` is shared with the Node/Express build: it talks to a
//! transport shim that maps each call either to `fetch('/api/…')` or to the
//! commands below, so the two backends must keep the same shapes.

mod richtext;
mod compose;
mod config;
mod copydoc;
mod media;
mod payload;
mod scan;
mod util;

use config::{Config, Root, RootStatus};
use scan::{Browse, Project, ProjectSummary};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct AppState {
    pub config: Mutex<Config>,
    pub config_path: PathBuf,
    pub cache_dir: PathBuf,
}

/// Commands return a plain string error; the shim surfaces it as a toast.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    roots: Vec<Root>,
    offline: Vec<Root>,
    ffmpeg: media::FfmpegStatus,
    payload: payload::PayloadStatus,
    taxonomy: Vec<String>,
    services: Vec<payload::ServiceCategory>,
    recipe: config::Recipe,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    roots: Vec<RootStatus>,
    payload: SettingsPayload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    url: String,
    credentials: bool,
}

fn settings_of(cfg: &Config) -> Settings {
    Settings {
        roots: cfg.root_statuses(),
        payload: SettingsPayload {
            url: cfg.payload.url.clone(),
            credentials: !cfg.payload.email.is_empty() && !cfg.payload.password.is_empty(),
        },
    }
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> CmdResult<Status> {
    let (cfg, online) = {
        let guard = state.config.lock().map_err(err)?;
        (guard.clone(), guard.online_roots())
    };
    let offline: Vec<Root> = cfg
        .roots
        .iter()
        .filter(|r| !online.iter().any(|o| o.path == r.path))
        .cloned()
        .collect();

    Ok(Status {
        roots: online,
        offline,
        ffmpeg: media::status(&cfg),
        payload: payload::status(&cfg).await,
        taxonomy: copydoc::TAXONOMY.iter().map(|s| s.to_string()).collect(),
        // The editable services taxonomy, straight from the CMS.
        services: payload::service_categories(&cfg).await,
        recipe: cfg.recipe.clone(),
    })
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let cfg = state.config.lock().map_err(err)?;
    Ok(settings_of(&cfg))
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    roots: Vec<Root>,
    payload_url: Option<String>,
) -> CmdResult<Settings> {
    let mut cfg = state.config.lock().map_err(err)?;
    cfg.apply_roots(roots);
    // A root added after startup has to reach the asset scope too, or the
    // preview would work for the roots you launched with and silently fail for
    // the one you just picked.
    allow_roots(&app.asset_protocol_scope(), &cfg);
    if let Some(url) = payload_url {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            cfg.payload.url = trimmed;
        }
    }
    cfg.save(&state.config_path).map_err(err)?;
    scan::invalidate_all();
    Ok(settings_of(&cfg))
}

/// Every configured root, into the asset-protocol scope. Failures are ignored
/// on purpose: an offline NAS share must not stop the app from starting, and
/// the preview is not what the app is for.
fn allow_roots(scope: &tauri::scope::fs::Scope, cfg: &Config) {
    for root in &cfg.roots {
        if root.path.trim().is_empty() {
            continue;
        }
        let _ = scope.allow_directory(&root.path, true);
    }
}

#[tauri::command]
fn browse_dir(path: String) -> CmdResult<Browse> {
    Ok(scan::browse(&path))
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectSummary>> {
    let cfg = state.config.lock().map_err(err)?;
    Ok(scan::list_projects(&cfg))
}

/// Several picked folders as one project id. Kept on the backend because the
/// id is base64 of UTF-8 text, and getting that wrong in the browser would
/// break exactly the folder names with accents that nobody tests with.
#[tauri::command]
fn merge_project_ids(ids: Vec<String>) -> CmdResult<String> {
    scan::merge_ids(&ids).map_err(err)
}

#[tauri::command]
fn get_project(state: State<'_, AppState>, id: String) -> CmdResult<Project> {
    let cfg = state.config.lock().map_err(err)?;
    scan::get_project(&cfg, &id).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // A publish takes minutes on a tour's worth of video, so nobody watches
        // it finish -- they switch away and come back to guess whether it
        // worked. The toast only exists while the window is in front.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let config_path = config::config_path(&dir);
            let cfg = Config::load(&config_path);

            let cache_dir = app.path().app_cache_dir()?.join("thumbs");
            std::fs::create_dir_all(&cache_dir)?;

            // Thumbnails are served straight off disk through the asset
            // protocol, so the cache directory is allowed — which covers what
            // previous runs left behind, and ONLY that: the call records the
            // files present right now rather than a rule about the directory,
            // so anything generated later has to allow itself (see media::serve).
            app.asset_protocol_scope().allow_directory(&cache_dir, true)?;
            // ...and so are the asset roots, which the preview overlay reads
            // from directly. `allow_directory` only records a glob, so this
            // costs nothing even on a NAS share with a hundred thousand files.
            allow_roots(&app.asset_protocol_scope(), &cfg);

            app.manage(AppState {
                config: Mutex::new(cfg),
                config_path,
                cache_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_settings,
            save_settings,
            browse_dir,
            list_projects,
            get_project,
            merge_project_ids,
            media::thumbnail,
            media::source_path,
            media::preview_video,
            media::preview_bytes,
            media::probe_media,
            copydoc::read_copy_doc,
            copydoc::validate_fields,
            compose::plan_compose,
            compose::start_compose,
            payload::publish_project,
            payload::payload_login,
            payload::payload_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AOIN page composer");
}
