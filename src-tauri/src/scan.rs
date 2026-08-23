//! Project discovery and asset walking.

use crate::config::{Config, Root};
use crate::util::{kind_of, parse_folder_name, Kind, SKIP_DIRS};
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use walkdir::WalkDir;

/// A NUL byte separates the parts: no filename can contain one, so folder names
/// with spaces ("26024_STURDY_The Kid Laroi") round-trip intact. Matches the
/// Node implementation so the same front end works against either backend.
const SEP: char = '\u{0}';

pub fn encode_id(root_label: &str, folder: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{root_label}{SEP}{folder}"))
}

pub struct Decoded {
    pub root: Root,
    pub folder: String,
    pub dir: PathBuf,
}

pub fn decode_id(cfg: &Config, id: &str) -> Result<Decoded> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(id)
        .map_err(|_| anyhow!("unknown project id"))?;
    let decoded = String::from_utf8(bytes).map_err(|_| anyhow!("unknown project id"))?;
    let (label, folder) = decoded
        .split_once(SEP)
        .ok_or_else(|| anyhow!("unknown project id"))?;
    let root = cfg
        .find_root(label)
        .ok_or_else(|| anyhow!("unknown project root: {label}"))?;
    if folder.is_empty() {
        return Err(anyhow!("unknown project id"));
    }
    Ok(Decoded {
        dir: Path::new(&root.path).join(folder),
        root,
        folder: folder.to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Asset {
    pub rel: String,
    pub name: String,
    pub dir: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime: f64,
    pub ext: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub dir: String,
    pub images: usize,
    pub videos: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub root: String,
    pub folder: String,
    pub job_code: String,
    pub slug: String,
    pub title: String,
    pub stills: usize,
    pub videos: usize,
    pub copy_doc: Option<String>,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root: String,
    pub folder: String,
    pub dir: String,
    pub job_code: String,
    pub slug: String,
    pub title: String,
    pub tree: Vec<TreeNode>,
    pub assets: Vec<Asset>,
    pub docs: Vec<Asset>,
}

#[derive(Clone)]
struct Scanned {
    assets: Vec<Asset>,
    docs: Vec<Asset>,
}

/// Some folders hold thousands of stills; re-walking every one on each picker
/// load is the slow path. Compose invalidates its own project on write.
const TTL: Duration = Duration::from_secs(5 * 60);

static CACHE: Mutex<Option<HashMap<PathBuf, (Instant, Scanned)>>> = Mutex::new(None);

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn walk(dir: &Path) -> Scanned {
    let mut assets = Vec::new();
    let mut docs = Vec::new();

    let walker = WalkDir::new(dir)
        .max_depth(7)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 0 {
                return true;
            }
            if name.starts_with('.') || name.starts_with("~$") {
                return false;
            }
            if e.file_type().is_dir() && SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                return false;
            }
            true
        });

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(kind) = kind_of(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };

        let rel = entry
            .path()
            .strip_prefix(dir)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let parent = match rel.rfind('/') {
            Some(i) => rel[..i].to_string(),
            None => "/".to_string(),
        };
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_ascii_lowercase()))
            .unwrap_or_default();

        let asset = Asset {
            rel,
            name,
            dir: parent,
            kind,
            size: meta.len(),
            mtime: mtime_ms(&meta),
            ext,
        };
        if kind == Kind::Doc {
            docs.push(asset);
        } else {
            assets.push(asset);
        }
    }

    assets.sort_by(|a, b| a.rel.cmp(&b.rel));
    docs.sort_by(|a, b| a.rel.cmp(&b.rel));
    Scanned { assets, docs }
}

fn scan_project(dir: &Path) -> Scanned {
    {
        let mut guard = CACHE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some((at, hit)) = map.get(dir) {
            if at.elapsed() < TTL {
                return hit.clone();
            }
        }
    }
    let value = walk(dir);
    let mut guard = CACHE.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(dir.to_path_buf(), (Instant::now(), value.clone()));
    value
}

pub fn invalidate(dir: &Path) {
    if let Some(map) = CACHE.lock().unwrap().as_mut() {
        map.remove(dir);
    }
}

pub fn invalidate_all() {
    if let Some(map) = CACHE.lock().unwrap().as_mut() {
        map.clear();
    }
}

pub fn list_projects(cfg: &Config) -> Vec<ProjectSummary> {
    let mut out = Vec::new();

    for root in cfg.online_roots() {
        let Ok(entries) = std::fs::read_dir(&root.path) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_string();
            if folder.starts_with('.') {
                continue;
            }
            let dir = entry.path();
            let parsed = parse_folder_name(&folder);
            let scanned = scan_project(&dir);
            let mtime = entry.metadata().map(|m| mtime_ms(&m)).unwrap_or(0.0);

            out.push(ProjectSummary {
                id: encode_id(&root.label, &folder),
                root: root.label.clone(),
                folder,
                job_code: parsed.job_code,
                slug: parsed.slug,
                title: parsed.title.to_uppercase(),
                stills: scanned.assets.iter().filter(|a| a.kind == Kind::Image).count(),
                videos: scanned.assets.iter().filter(|a| a.kind == Kind::Video).count(),
                copy_doc: scanned.docs.first().map(|d| d.rel.clone()),
                mtime,
            });
        }
    }

    out.sort_by(|a, b| b.job_code.cmp(&a.job_code).then(a.folder.cmp(&b.folder)));
    out
}

pub fn get_project(cfg: &Config, id: &str) -> Result<Project> {
    let d = decode_id(cfg, id)?;
    let scanned = scan_project(&d.dir);
    let parsed = parse_folder_name(&d.folder);

    // Folder tree with counts, for the source rail.
    let mut order: Vec<String> = Vec::new();
    let mut by_dir: HashMap<String, TreeNode> = HashMap::new();
    for a in &scanned.assets {
        let node = by_dir.entry(a.dir.clone()).or_insert_with(|| {
            order.push(a.dir.clone());
            TreeNode { dir: a.dir.clone(), images: 0, videos: 0 }
        });
        if a.kind == Kind::Image {
            node.images += 1;
        } else {
            node.videos += 1;
        }
    }
    let mut tree: Vec<TreeNode> = order.into_iter().filter_map(|k| by_dir.remove(&k)).collect();
    tree.sort_by(|a, b| a.dir.cmp(&b.dir));

    Ok(Project {
        id: id.to_string(),
        root: d.root.label,
        folder: d.folder,
        dir: d.dir.to_string_lossy().to_string(),
        job_code: parsed.job_code,
        slug: parsed.slug,
        title: parsed.title.to_uppercase(),
        tree,
        assets: scanned.assets,
        docs: scanned.docs,
    })
}

/// Sub-folders of `path`, for the settings folder browser.
#[derive(Serialize)]
pub struct Browse {
    pub path: String,
    pub parent: Option<String>,
    pub online: bool,
    pub dirs: Vec<BrowseDir>,
}

#[derive(Serialize)]
pub struct BrowseDir {
    pub name: String,
    pub path: String,
}

pub fn browse(target: &str) -> Browse {
    let p = Path::new(target);
    let parent = p
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .filter(|x| !x.is_empty() && x != target);

    if target.trim().is_empty() || !p.is_dir() {
        return Browse {
            path: target.to_string(),
            parent,
            online: false,
            dirs: Vec::new(),
        };
    }

    let mut dirs: Vec<BrowseDir> = std::fs::read_dir(p)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || name.starts_with('$') {
                        return None;
                    }
                    Some(BrowseDir {
                        path: e.path().to_string_lossy().to_string(),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Browse {
        path: target.to_string(),
        parent,
        online: true,
        dirs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_folders_containing_spaces() {
        let mut cfg = Config::default();
        cfg.apply_roots(vec![Root { label: "2026".into(), path: "A:/x".into() }]);
        let id = encode_id("2026", "26024_STURDY_The Kid Laroi");
        let d = decode_id(&cfg, &id).unwrap();
        assert_eq!(d.folder, "26024_STURDY_The Kid Laroi");
        assert_eq!(d.root.label, "2026");
    }

    /// Parity check against the Node backend on the real asset drive.
    /// `cargo test --lib -- --ignored --nocapture` (needs the A: drive mounted).
    #[test]
    #[ignore = "needs the real asset drive"]
    fn matches_the_node_backend_on_the_real_drive() {
        let mut cfg = Config::default();
        cfg.apply_roots(vec![
            Root { label: "2026".into(), path: "A:/AOIN Brand and Marketing/!-Project Assets/z-2026- Projects".into() },
            Root { label: "2025".into(), path: "A:/AOIN Brand and Marketing/!-Project Assets/z-2025-Projects".into() },
            Root { label: "2024".into(), path: "A:/AOIN Brand and Marketing/!-Project Assets/z-2024-Projects".into() },
        ]);

        let list = list_projects(&cfg);
        println!("projects: {}", list.len());
        for p in list.iter().take(6) {
            println!("  {} | {} | {} | stills {} vid {}", p.job_code, p.title, p.slug, p.stills, p.videos);
        }

        let peso = list
            .iter()
            .find(|p| p.slug == "peso-dinastia")
            .expect("peso-dinastia should be discoverable");
        println!("peso: stills {} videos {}", peso.stills, peso.videos);

        let project = get_project(&cfg, &peso.id).expect("project should resolve");
        println!("assets: {}  docs: {}", project.assets.len(), project.docs.len());
        for t in &project.tree {
            println!("  tree {} ({}i/{}v)", t.dir, t.images, t.videos);
        }

        // Numbers the Node backend reports for the same folder.
        assert_eq!(peso.stills, 17);
        assert_eq!(peso.videos, 34);
        assert_eq!(project.assets.len(), 51);
        assert_eq!(project.title, "PESO DINASTIA");
        // AE logs must not register as the project's write-up.
        assert!(project.docs.is_empty());
    }

    #[test]
    fn an_unknown_root_is_an_error_not_a_panic() {
        let cfg = Config::default();
        assert!(decode_id(&cfg, &encode_id("nope", "x")).is_err());
        assert!(decode_id(&cfg, "not-base64!!").is_err());
    }
}
