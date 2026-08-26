//! ffmpeg discovery, video probing, and the thumbnail cache.

use crate::config::Config;
use crate::scan;
use crate::util::Kind;
use crate::AppState;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::Path;
use std::process::Command;
use std::sync::{Condvar, Mutex};
use tauri::{Manager, State};

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

/// Where an asset actually lives on disk, for the preview overlay.
///
/// The webview reads it through the asset protocol rather than through a
/// command, because a video has to be *streamed* — handing back bytes would
/// mean loading a 300MB ProRes file into memory before a single frame drew,
/// and seeking would be impossible. The roots are added to the asset scope at
/// startup and whenever they change (see lib.rs).
#[tauri::command]
pub fn source_path(state: State<'_, AppState>, id: String, rel: String) -> Result<String, String> {
    let cfg = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let decoded = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
    let path = decoded.resolve(&rel).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

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

/// What a frame-accurate timeline needs from a source file.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub fps_num: u32,
    pub fps_den: u32,
    pub fps: f64,
    pub duration: f64,
    pub frames: u64,
}

/// "30000/1001" -> (30000, 1001). Anything unusable is None.
pub fn parse_rate(text: &str) -> Option<(u32, u32)> {
    let (a, b) = text.trim().split_once('/')?;
    let num: u32 = a.trim().parse().ok()?;
    let den: u32 = b.trim().parse().ok()?;
    if num == 0 || den == 0 {
        None
    } else {
        Some((num, den))
    }
}

/// Build the info from ffprobe's csv, in the field order asked for below.
///
/// `avg_frame_rate` is preferred over `r_frame_rate`: r_frame_rate is the
/// smallest rate that can express every timestamp, so one odd timestamp turns
/// it into something like 1000/1 and the ruler would grow a thousand ticks a
/// second. `nb_frames` is missing from plenty of containers, so the count falls
/// back to duration x rate.
pub fn video_info_from(
    width: u32,
    height: u32,
    codec: &str,
    avg_rate: &str,
    r_rate: &str,
    nb_frames: &str,
    duration: f64,
) -> VideoInfo {
    let rate = parse_rate(avg_rate).or_else(|| parse_rate(r_rate));
    let (fps_num, fps_den) = rate.unwrap_or((0, 1));
    let fps = if fps_den > 0 { fps_num as f64 / fps_den as f64 } else { 0.0 };
    let counted: u64 = nb_frames.trim().parse().unwrap_or(0);
    let frames = if counted > 0 {
        counted
    } else {
        ((duration * fps).round() as i64).max(1) as u64
    };
    VideoInfo {
        width,
        height,
        codec: codec.to_string(),
        fps_num,
        fps_den,
        fps,
        duration,
        frames,
    }
}

/// Frame rate and frame count for the trim timeline. Always the SOURCE, never
/// the proxy: the frame numbers an editor sets have to mean the same thing to
/// ffmpeg at compose time, and compose reads the source.
#[tauri::command]
pub fn probe_media(state: State<'_, AppState>, id: String, rel: String) -> Result<VideoInfo, String> {
    let cfg = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let decoded = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
    let source = decoded.resolve(&rel).map_err(|e| e.to_string())?;
    let bin = resolve("ffprobe", &cfg).ok_or_else(|| "ffprobe not found".to_string())?;

    let out = command(&bin)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,codec_name,avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1",
        ])
        .arg(&source)
        .output()
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut f = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            f.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    // The stream carries a duration on some containers and not others; the
    // format-level one is the fallback, and "N/A" parses to 0 either way.
    let duration = get("duration")
        .parse::<f64>()
        .ok()
        .filter(|d| *d > 0.0)
        .unwrap_or_else(|| get("duration").parse::<f64>().unwrap_or(0.0));
    let duration = if duration > 0.0 {
        duration
    } else {
        text.lines()
            .rev()
            .find_map(|l| l.strip_prefix("duration="))
            .and_then(|d| d.trim().parse::<f64>().ok())
            .unwrap_or(0.0)
    };

    let info = video_info_from(
        get("width").parse().unwrap_or(0),
        get("height").parse().unwrap_or(0),
        &get("codec_name"),
        &get("avg_frame_rate"),
        &get("r_frame_rate"),
        &get("nb_frames"),
        duration,
    );
    if info.fps <= 0.0 {
        return Err(format!("no frame rate in {rel}"));
    }
    Ok(info)
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

fn preview_key(file: &Path, mtime: f64) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}|{}|preview", file.to_string_lossy(), mtime));
    format!("{}.mp4", hex::encode(hasher.finalize()))
}

/// A web-playable proxy of a source video, cached beside the thumbnails.
///
/// Quick Look tries the original first — a lot of what comes off the NAS is
/// already h.264 mp4 and plays instantly. This is the fallback for what the
/// webview cannot decode at all: ProRes, most .mov, HEVC. 1280 wide at CRF 28
/// is a preview, not a deliverable; the real encode still happens in compose.
/// The proxy's BYTES, for the webview to wrap in a blob.
///
/// The asset protocol serves the source roots happily, but everything in the
/// app's own cache directory answers 403 — including a freshly generated
/// thumbnail, so it is the directory and not the file type. A proxy is small by
/// construction, so shipping it over the IPC as raw bytes is cheap and, unlike
/// the scope, cannot silently stop working.
#[tauri::command]
pub async fn preview_bytes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let path = preview_video(app, state, id, rel).await?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn preview_video(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    rel: String,
) -> Result<String, String> {
    let (cfg, cache_dir) = {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        (guard.clone(), state.cache_dir.clone())
    };
    let decoded = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
    let source = decoded.resolve(&rel).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&source).map_err(|e| format!("{rel}: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);

    let out = cache_dir.join(preview_key(&source, mtime));
    if out.exists() {
        serve(&app, &out);
        return Ok(out.to_string_lossy().to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _slot = Slot::acquire();
        if out.exists() {
            return Ok(out.to_string_lossy().to_string());
        }
        // Written aside and renamed: a half-encoded file at the real path
        // would be served on the next request and treated as complete.
        // `-f mp4` is not optional — ffmpeg picks the container from the output
        // extension, and this one ends in `.part`.
        let part = out.with_extension("part");
        let args: Vec<std::ffi::OsString> = vec![
            "-y".into(), "-i".into(), (&source).into(),
            "-vf".into(), "scale='min(1280,iw)':-2".into(),
            "-c:v".into(), "libx264".into(), "-crf".into(), "28".into(),
            "-preset".into(), "veryfast".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            "-movflags".into(), "+faststart".into(),
            "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(),
            "-f".into(), "mp4".into(), (&part).into(),
        ];
        if let Err(e) = run_ffmpeg(&cfg, &args) {
            let _ = std::fs::remove_file(&part);
            return Err(e.to_string());
        }
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        serve(&app, &out);
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A thumbnail of a KEY IMAGE that lives in the CMS rather than on a root.
///
/// The reorder screen shows published projects, whose artwork is on the Payload
/// server. The webview cannot load it directly — the content policy allows
/// `asset:` and `data:` for images and nothing over the network, and the CMS
/// address is a runtime setting, so it could not be named in the policy in any
/// case. Fetching it here and caching a small jpeg puts it exactly where every
/// other thumbnail in the app already comes from.
#[tauri::command]
pub async fn cms_thumb(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    w: Option<u32>,
) -> Result<String, String> {
    let cache_dir = state.cache_dir.clone();
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let width = w.unwrap_or(420).clamp(64, 2000);

    let mut hasher = Sha1::new();
    hasher.update(format!("cms|{url}|{width}"));
    let out = cache_dir.join(format!("{}.jpg", hex::encode(hasher.finalize())));
    if out.exists() {
        serve(&app, &out);
        return Ok(out.to_string_lossy().to_string());
    }

    let cfg = { state.config.lock().map_err(|e| e.to_string())?.clone() };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url}: {}", res.status()));
    }
    // The server's own answer decides, and the extension is only the fallback:
    // a gallery is mostly video, and a clip mislabelled as a still would fail
    // to decode and read as a missing thumbnail.
    let served_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let is_video = served_type.starts_with("video/")
        || (served_type.is_empty()
            && matches!(
                url.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str(),
                "mp4" | "mov" | "m4v" | "webm"
            ));
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let _slot = Slot::acquire();
        if is_video {
            // ffmpeg reads a file, not a buffer, and it has to seek to find a
            // frame worth showing — so the clip is staged on disk and removed
            // again whether or not the frame comes out.
            let staged = out.with_extension("src");
            std::fs::write(&staged, &bytes).map_err(|e| e.to_string())?;
            let made = build(&cfg, &staged, Kind::Video, width, &out);
            let _ = std::fs::remove_file(&staged);
            made.map_err(|e| {
                let _ = std::fs::remove_file(&out);
                e.to_string()
            })?;
            return Ok::<_, String>(out);
        }
        // From memory for a still: these are the app's own composed uploads,
        // already upright, so there is no EXIF orientation left to honour.
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let img = resize_within(img, width);
        let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 72);
        img.into_rgb8().write_with_encoder(encoder).map_err(|e| {
            // Half a jpeg on disk would be served forever after.
            let _ = std::fs::remove_file(&out);
            e.to_string()
        })?;
        Ok::<_, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|out| {
        serve(&app, &out);
        out.to_string_lossy().to_string()
    })
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
/// Hands a generated file to the asset protocol.
///
/// Allowing the CACHE DIRECTORY at startup is not enough, and the way it fails
/// is quiet: `allow_directory` records the files that are in the directory at
/// that moment, not a rule about the directory, so anything written afterwards
/// comes back 403. Proved by copying a served thumbnail to a new name in the
/// same directory — byte for byte identical, and the copy 403s while the
/// original loads.
///
/// That is why the Page Order rail was the visible casualty: its thumbnails are
/// 320px wide, a size nothing else asks for, so they are always generated fresh
/// and were never in the startup snapshot. The contact sheet mostly survived on
/// thumbnails left over from previous sessions.
fn serve(app: &tauri::AppHandle, file: &Path) {
    let _ = app.asset_protocol_scope().allow_file(file);
}

#[tauri::command]
pub async fn thumbnail(
    app: tauri::AppHandle,
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
        let d = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
        (
            d.resolve(&asset.rel).map_err(|e| e.to_string())?,
            asset.kind,
            asset.mtime,
        )
    } else {
        let d = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
        // Goes through the source list: a rel may name a secondary folder.
        let source = d.resolve(&rel).map_err(|e| e.to_string())?;
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
        serve(&app, &out);
        return Ok(out.to_string_lossy().to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _slot = Slot::acquire();
        if out.exists() {
            serve(&app, &out);
            return Ok(out.to_string_lossy().to_string());
        }
        build(&cfg, &source, kind, width, &out).map_err(|e| e.to_string())?;
        serve(&app, &out);
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
