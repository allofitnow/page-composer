//! ffmpeg discovery, video probing, and the thumbnail cache.

use crate::config::Config;
use crate::scan;
use crate::util::{safe_join, Kind};
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::Path;
use std::process::Command;
use std::sync::{Condvar, Mutex};
use tauri::State;

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

fn command(bin: &str) -> Command {
    let cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

/// The chocolatey shims on some Windows machines are blocked by Application
/// Control while the real binaries underneath run fine, so probe real paths
/// before falling back to PATH.
///
/// The same probing is what makes this work on macOS at all: a GUI app launched
/// from Finder does not inherit a shell's PATH, so a bare `ffmpeg` resolves to
/// nothing even when the terminal finds it. Homebrew's two prefixes are listed
/// explicitly — /opt/homebrew on Apple Silicon, /usr/local on Intel.
fn candidates(which: &str, cfg: &Config) -> Vec<String> {
    let configured = if which == "ffmpeg" {
        cfg.ffmpeg.clone()
    } else {
        cfg.ffprobe.clone()
    };
    let mut out: Vec<String> = configured.into_iter().collect();
    out.extend(
        [
            format!("C:/ProgramData/chocolatey/lib/ffmpeg-full/tools/ffmpeg/bin/{which}.exe"),
            format!("C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/{which}.exe"),
            format!("C:/ffmpeg/bin/{which}.exe"),
            format!("/opt/homebrew/bin/{which}"),
            format!("/usr/local/bin/{which}"),
            format!("/usr/bin/{which}"),
            format!("/opt/local/bin/{which}"),
            which.to_string(),
        ]
        .into_iter(),
    );
    out
}

fn resolve(which: &str, cfg: &Config) -> Option<String> {
    for cand in candidates(which, cfg) {
        if cand.contains(['/', '\\']) && !Path::new(&cand).exists() {
            continue;
        }
        if command(&cand).arg("-version").output().is_ok_and(|o| o.status.success()) {
            return Some(cand);
        }
    }
    None
}

pub fn ffmpeg_path(cfg: &Config) -> Option<String> {
    resolve("ffmpeg", cfg)
}

#[derive(Serialize, Clone)]
pub struct FfmpegStatus {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub ok: bool,
}

pub fn status(cfg: &Config) -> FfmpegStatus {
    let ffmpeg = resolve("ffmpeg", cfg);
    let ffprobe = resolve("ffprobe", cfg);
    FfmpegStatus {
        ok: ffmpeg.is_some(),
        ffmpeg,
        ffprobe,
    }
}

pub fn probe(cfg: &Config, file: &Path) -> Option<String> {
    let bin = resolve("ffprobe", cfg)?;
    let out = command(&bin)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

pub fn run_ffmpeg(cfg: &Config, args: &[std::ffi::OsString]) -> Result<()> {
    let bin = ffmpeg_path(cfg)
        .ok_or_else(|| anyhow!("ffmpeg not found — set \"ffmpeg\" in config.json to its full path"))?;
    let out = command(&bin).args(args).output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        bail!("{}", tail.into_iter().rev().collect::<Vec<_>>().join(" "));
    }
    Ok(())
}

// --- concurrency gate ------------------------------------------------------
// Opening a project fires one request per asset, and a video poster means
// decoding a frame out of a file that can be tens of gigabytes. Three at a time
// keeps the grid filling in steadily instead of stalling.
const MAX_CONCURRENT: usize = 3;
static ACTIVE: Mutex<usize> = Mutex::new(0);
static FREED: Condvar = Condvar::new();

struct Slot;

impl Slot {
    fn acquire() -> Self {
        let mut active = ACTIVE.lock().unwrap();
        while *active >= MAX_CONCURRENT {
            active = FREED.wait(active).unwrap();
        }
        *active += 1;
        Slot
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap() -= 1;
        FREED.notify_one();
    }
}

fn cache_key(file: &Path, mtime: f64, width: u32) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}|{}|{}", file.to_string_lossy(), mtime, width));
    format!("{}.jpg", hex::encode(hasher.finalize()))
}

/// Decodes, honours EXIF orientation, and resizes without enlarging.
pub fn load_oriented(file: &Path) -> Result<image::DynamicImage> {
    let mut decoder = image::ImageReader::open(file)?
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = image::ImageDecoder::orientation(&mut decoder)?;
    let mut img = image::DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

pub fn resize_within(img: image::DynamicImage, max_width: u32) -> image::DynamicImage {
    if max_width == 0 || img.width() <= max_width {
        return img;
    }
    let height = ((img.height() as f64) * (max_width as f64) / (img.width() as f64)).round() as u32;
    img.resize_exact(max_width, height.max(1), image::imageops::FilterType::Lanczos3)
}

fn build(cfg: &Config, source: &Path, kind: Kind, width: u32, out: &Path) -> Result<()> {
    if kind == Kind::Video {
        let w = width.to_string();
        // `-ss` BEFORE `-i` is an input seek, so this stays cheap on masters.
        let seek: Vec<std::ffi::OsString> = vec![
            "-y".into(), "-ss".into(), "1".into(), "-i".into(), source.into(),
            "-frames:v".into(), "1".into(), "-vf".into(), format!("scale={w}:-2").into(),
            "-q:v".into(), "4".into(), out.into(),
        ];
        if run_ffmpeg(cfg, &seek).is_ok() {
            return Ok(());
        }
        // Clips shorter than the seek point: fall back to the first frame.
        let first: Vec<std::ffi::OsString> = vec![
            "-y".into(), "-i".into(), source.into(),
            "-frames:v".into(), "1".into(), "-vf".into(), format!("scale={w}:-2").into(),
            "-q:v".into(), "4".into(), out.into(),
        ];
        return run_ffmpeg(cfg, &first);
    }

    let img = resize_within(load_oriented(source)?, width);
    let mut file = std::fs::File::create(out)?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 72);
    img.into_rgb8().write_with_encoder(encoder)?;
    Ok(())
}

/// Returns the absolute path of a cached JPEG thumbnail. The front end turns it
/// into an `asset:` URL — the cache dir is the only directory in scope.
#[tauri::command]
pub async fn thumbnail(
    state: State<'_, AppState>,
    id: String,
    rel: String,
    w: Option<u32>,
) -> Result<String, String> {
    let width = w.unwrap_or(420).min(1800);
    let (cfg, cache_dir) = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        (guard.clone(), state.cache_dir.clone())
    };

    // `__first` lets the picker show a project without knowing its contents, and
    // is the only case that needs the asset list. Every grid tile already knows
    // its own path, so resolve those directly — walking and cloning a project of
    // several thousand assets once per tile is what made a full sheet crawl.
    let (source, kind, mtime) = if rel == "__first" {
        let project = scan::get_project(&cfg, &id).map_err(|e| e.to_string())?;
        let asset = project
            .assets
            .iter()
            .find(|a| a.kind == Kind::Image)
            .or_else(|| project.assets.first())
            .ok_or_else(|| "project has no assets".to_string())?;
        (
            safe_join(Path::new(&project.dir), &asset.rel).map_err(|e| e.to_string())?,
            asset.kind,
            asset.mtime,
        )
    } else {
        let d = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
        let source = safe_join(&d.dir, &rel).map_err(|e| e.to_string())?;
        let kind = crate::util::kind_of(&rel).ok_or_else(|| format!("not a media file: {rel}"))?;
        let meta = std::fs::metadata(&source).map_err(|e| format!("{rel}: {e}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        (source, kind, mtime)
    };

    let out = cache_dir.join(cache_key(&source, mtime, width));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _slot = Slot::acquire();
        if out.exists() {
            return Ok(out.to_string_lossy().to_string());
        }
        build(&cfg, &source, kind, width, &out)
            .map(|_| out.to_string_lossy().to_string())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
