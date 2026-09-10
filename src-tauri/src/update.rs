//! Self-update, from the CMS host the app is pointed at.
//!
//! The repo is private, so GitHub releases are no use as an update source —
//! the app could not fetch them without a token baked in. The CMS host is the
//! one address every copy of the app already talks to and can only be reached
//! from the studio network, which is exactly where updates should live. nginx
//! serves `/composer/` there; `scripts/release.mjs` builds, signs and uploads.
//!
//! The updater plugin verifies every download against the public key in
//! tauri.conf.json, so nothing unsigned can ever be installed, whatever is on
//! the server.

use crate::AppState;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// The update found by the last check, held so install does not fetch twice.
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub date: String,
    pub url: String,
}

/// Where `latest.json` lives on a CMS host.
pub fn endpoint(base: &str) -> String {
    format!("{}/composer/latest.json", base.trim_end_matches('/'))
}

/// Asks the CMS host whether a newer build is up. `None` means this is the
/// latest; an error means the host could not be asked, which the settings
/// screen shows and the startup check keeps quiet about.
#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<Option<UpdateInfo>, String> {
    let base = { state.config.lock().map_err(|e| e.to_string())?.payload.url.clone() };
    let url = endpoint(&base).parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()).unwrap_or_default(),
        url: u.download_url.to_string(),
    });
    *app.state::<PendingUpdate>().0.lock().map_err(|e| e.to_string())? = found;
    Ok(info)
}

/// Downloads and installs the update found by the last check, reporting
/// progress as `update://progress`, then relaunches into the new build.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = { app.state::<PendingUpdate>().0.lock().map_err(|e| e.to_string())?.clone() }
        .ok_or_else(|| "no update has been checked for".to_string())?;
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update://progress", serde_json::json!({ "downloaded": downloaded, "total": total }));
            },
            move || {
                let _ = finished.emit("update://progress", serde_json::json!({ "done": true }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
