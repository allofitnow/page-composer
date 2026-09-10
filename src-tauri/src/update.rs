//! Self-update, from the GitHub release.
//!
//! The repo is public, so the latest release's `latest.json` is the update
//! source (`plugins.updater.endpoints` in tauri.conf.json); GitHub Actions
//! builds and signs every tagged version for Windows and macOS. The updater
//! plugin verifies every download against the public key in tauri.conf.json,
//! so nothing unsigned can ever be installed, whatever is on the release.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
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

/// Asks GitHub whether a newer build is up. `None` means this is the latest;
/// an error means it could not be asked (offline, say), which the settings
/// screen shows and the startup check keeps quiet about.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
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
