//! Convert + rename, with progress streamed to the window as events.
//!
//! Outputs land in the project folder next to the originals — never a parallel
//! export tree — and the originals are never modified or deleted.

use crate::config::Config;
use crate::media;
use crate::scan;
use crate::util::{build_name, safe_join, Kind};
use crate::AppState;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub rel: String,
    pub role: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub layout: Option<String>,
    // The hero and thumb carry no row/slot at all — they are not gallery tiles —
    // so these have to default rather than being required on the wire.
    #[serde(default)]
    pub row: Option<u32>,
    #[serde(default)]
    pub slot: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub rel: String,
    pub role: String,
    pub description: String,
    pub layout: Option<String>,
    pub row: Option<u32>,
    pub slot: Option<u32>,
    pub kind: Kind,
    pub source: String,
    pub source_name: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub output: String,
    pub output_path: String,
    pub exists: bool,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub out_dir: String,
    pub steps: Vec<Step>,
}

fn resolve_out_dir(project_dir: &Path, out_dir: &Option<String>) -> Result<PathBuf> {
    match out_dir {
        Some(rel) if !rel.trim().is_empty() => safe_join(project_dir, rel.trim()),
        _ => Ok(project_dir.to_path_buf()),
    }
}

/// Works out every output filename up front so the UI can show the whole plan
/// (and catch collisions) before a single byte is written.
fn plan(cfg: &Config, project_id: &str, base: &str, items: &[Item], out_dir: &Path) -> Result<Vec<Step>> {
    let project = scan::get_project(cfg, project_id)?;
    // Sources, not one directory: a page may draw assets from several folders,
    // and each rel knows which one it came from.
    let decoded = scan::decode_id(cfg, project_id)?;

    let described: Vec<(String, &Item)> = items
        .iter()
        .map(|it| {
            let desc = it.description.clone().unwrap_or_default();
            let desc = if desc.trim().is_empty() {
                if it.role == "gallery" { "gallery".to_string() } else { it.role.clone() }
            } else {
                desc
            };
            (desc, it)
        })
        .collect();

    let mut group_size: HashMap<String, usize> = HashMap::new();
    for (desc, _) in &described {
        *group_size.entry(desc.clone()).or_insert(0) += 1;
    }

    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut steps = Vec::new();

    for (desc, it) in described {
        let idx = *seen.get(&desc).unwrap_or(&0);
        seen.insert(desc.clone(), idx + 1);

        let asset = project
            .assets
            .iter()
            .find(|a| a.rel == it.rel)
            .ok_or_else(|| anyhow!("asset not in project: {}", it.rel))?;

        let ext = if asset.kind == Kind::Video { "mp4" } else { "webp" };
        let output = build_name(base, &desc, idx, group_size[&desc], ext);
        let output_path = out_dir.join(&output);

        steps.push(Step {
            rel: it.rel.clone(),
            role: it.role.clone(),
            description: desc,
            layout: it.layout.clone(),
            row: it.row,
            slot: it.slot,
            kind: asset.kind,
            source: decoded.resolve(&asset.rel)?.to_string_lossy().to_string(),
            source_name: asset.name.clone(),
            bytes_in: asset.size,
            bytes_out: 0,
            exists: output_path.exists(),
            output,
            output_path: output_path.to_string_lossy().to_string(),
            status: "queued".into(),
            message: String::new(),
        });
    }
    Ok(steps)
}

#[tauri::command]
pub fn plan_compose(
    state: State<'_, AppState>,
    project_id: String,
    base: String,
    items: Vec<Item>,
    out_dir: Option<String>,
) -> Result<Plan, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?.clone();
    let project = scan::get_project(&cfg, &project_id).map_err(|e| e.to_string())?;
    let dir = resolve_out_dir(Path::new(&project.dir), &out_dir).map_err(|e| e.to_string())?;
    let steps = plan(&cfg, &project_id, &base, &items, &dir).map_err(|e| e.to_string())?;
    Ok(Plan {
        out_dir: dir.to_string_lossy().to_string(),
        steps,
    })
}

fn convert_image(cfg: &Config, step: &Step, role: &str) -> Result<()> {
    let r = &cfg.recipe;
    let img = media::load_oriented(Path::new(&step.source))?;

    let (encoded, quality) = if role == "thumb" {
        let spec = &r.thumb;
        // Cover-crop to the exact thumb box, without enlarging a small source.
        let (tw, th) = (spec.width.max(1), spec.height.max(1));
        let cropped = if img.width() >= tw && img.height() >= th {
            img.resize_to_fill(tw, th, image::imageops::FilterType::Lanczos3)
        } else {
            img
        };
        (cropped, spec.quality)
    } else {
        let spec = if role == "hero" { &r.hero } else { &r.gallery };
        (media::resize_within(img, spec.max_width), spec.quality)
    };

    let rgba = encoded.to_rgba8();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    let out = encoder.encode(quality);
    std::fs::write(&step.output_path, &*out)?;
    Ok(())
}

fn convert_video(cfg: &Config, step: &Step) -> Result<()> {
    let v = &cfg.recipe.video;
    let args: Vec<std::ffi::OsString> = vec![
        "-y".into(),
        "-i".into(),
        Path::new(&step.source).into(),
        "-vf".into(),
        format!("scale='min({},iw)':-2", v.max_width).into(),
        "-c:v".into(),
        "libx264".into(),
        "-crf".into(),
        v.crf.to_string().into(),
        "-preset".into(),
        v.preset.clone().into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        v.audio.clone().into(),
        Path::new(&step.output_path).into(),
    ];
    media::run_ffmpeg(cfg, &args)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<Step>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<Vec<Step>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_path: Option<String>,
}

fn stamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

/// Kicks the run off on a worker thread and streams `compose://progress`
/// events; returns the resolved output directory immediately.
#[tauri::command]
pub async fn start_compose(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    base: String,
    items: Vec<Item>,
    out_dir: Option<String>,
) -> Result<Plan, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?.clone();
    let project = scan::get_project(&cfg, &project_id).map_err(|e| e.to_string())?;
    let project_dir = PathBuf::from(&project.dir);
    let dir = resolve_out_dir(&project_dir, &out_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut steps = plan(&cfg, &project_id, &base, &items, &dir).map_err(|e| e.to_string())?;
    let reply = Plan {
        out_dir: dir.to_string_lossy().to_string(),
        steps: steps.clone(),
    };

    let folder = project.folder.clone();
    let base_for_manifest = base.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |p: Progress| {
            let _ = app.emit("compose://progress", p);
        };

        emit(Progress {
            kind: "log".into(),
            message: Some(format!("{}  writing into {}", stamp(), dir.display())),
            index: None, step: None, steps: None, manifest_path: None,
        });

        for i in 0..steps.len() {
            steps[i].status = "running".into();
            emit(Progress {
                kind: "step".into(),
                index: Some(i),
                step: Some(steps[i].clone()),
                message: None, steps: None, manifest_path: None,
            });
            emit(Progress {
                kind: "log".into(),
                message: Some(format!("{}  {} -> {}", stamp(), steps[i].source_name, steps[i].output)),
                index: None, step: None, steps: None, manifest_path: None,
            });

            let result = if steps[i].kind == Kind::Video {
                if let Some(meta) = media::probe(&cfg, Path::new(&steps[i].source)) {
                    emit(Progress {
                        kind: "log".into(),
                        message: Some(format!("{}  transcoding {meta} to h264", stamp())),
                        index: None, step: None, steps: None, manifest_path: None,
                    });
                }
                convert_video(&cfg, &steps[i])
            } else {
                let role = steps[i].role.clone();
                convert_image(&cfg, &steps[i], &role)
            };

            match result {
                Ok(()) => {
                    steps[i].bytes_out = std::fs::metadata(&steps[i].output_path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    steps[i].status = "done".into();
                }
                Err(e) => {
                    let msg = e.to_string();
                    steps[i].message = msg.clone();
                    steps[i].status = "failed".into();
                    emit(Progress {
                        kind: "log".into(),
                        message: Some(format!("{}  FAILED {} — {msg}", stamp(), steps[i].output)),
                        index: None, step: None, steps: None, manifest_path: None,
                    });
                }
            }

            emit(Progress {
                kind: "step".into(),
                index: Some(i),
                step: Some(steps[i].clone()),
                message: None, steps: None, manifest_path: None,
            });
        }

        let manifest = serde_json::json!({
            "generatedAt": chrono::Utc::now().to_rfc3339(),
            "project": folder,
            "base": base_for_manifest,
            "outDir": dir.to_string_lossy(),
            "convention": "project-name-tour_description##",
            "note": "Source files are untouched. Delete an output and re-compose to regenerate it.",
            "items": steps.iter().map(|s| serde_json::json!({
                "role": s.role,
                "description": s.description,
                "layout": s.layout,
                "row": s.row,
                "slot": s.slot,
                "source": s.rel,
                "output": s.output,
                "kind": s.kind,
                "bytesIn": s.bytes_in,
                "bytesOut": s.bytes_out,
                "status": s.status,
            })).collect::<Vec<_>>(),
        });

        let manifest_path = dir.join("_compose-manifest.json");
        let _ = std::fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        );
        emit(Progress {
            kind: "log".into(),
            message: Some(format!(
                "{}  wrote _compose-manifest.json — {} mappings, originals untouched",
                stamp(),
                steps.len()
            )),
            index: None, step: None, steps: None, manifest_path: None,
        });

        scan::invalidate(&project_dir);
        emit(Progress {
            kind: "done".into(),
            steps: Some(steps),
            manifest_path: Some(manifest_path.to_string_lossy().to_string()),
            index: None, step: None, message: None,
        });
    });

    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact JSON `selectedItems()` in web/app.js sends. The two backends
    /// share this wire shape and nothing else checks it, so a field that the
    /// frontend stops sending — or starts sending as a different type — only
    /// shows up as a runtime "invalid args" once somebody presses Compose.
    #[test]
    fn the_frontends_items_deserialize() {
        // A hero has no layout/row/slot: it is not a gallery tile.
        let hero: Item = serde_json::from_str(
            r#"{"rel":"01_Photos/a.jpg","role":"hero","description":"hero"}"#,
        )
        .expect("hero item must deserialize without gallery fields");
        assert_eq!(hero.role, "hero");
        assert_eq!(hero.row, None);
        assert_eq!(hero.slot, None);

        // A gallery tile carries the arrangement it belongs to.
        let tile: Item = serde_json::from_str(
            r#"{"rel":"b.jpg","role":"gallery","description":"gallery","layout":"split-8-4","row":0,"slot":1}"#,
        )
        .expect("gallery item must deserialize");
        assert_eq!(tile.layout.as_deref(), Some("split-8-4"));
        assert_eq!(tile.row, Some(0));
        assert_eq!(tile.slot, Some(1));
    }
}
