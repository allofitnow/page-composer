//! Persistent settings. Lives in the OS app-config dir rather than next to the
//! binary, so an installed copy can still write it.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Root {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootStatus {
    pub label: String,
    pub path: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payload {
    #[serde(default = "default_payload_url")]
    pub url: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub password: String,
}

fn default_payload_url() -> String {
    "http://192.168.30.245".into()
}

// The front end reads `maxWidth`, but files written before that was true hold
// `max_width` — so serialize the camelCase spelling and accept both on read.
// A blanket `rename_all` would change deserialization too and silently orphan
// every existing config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRecipe {
    #[serde(default, rename = "maxWidth", alias = "max_width")]
    pub max_width: u32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default = "default_quality")]
    pub quality: f32,
}

fn default_quality() -> f32 {
    82.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoRecipe {
    #[serde(default, rename = "maxWidth", alias = "max_width")]
    pub max_width: u32,
    pub crf: u32,
    pub preset: String,
    pub audio: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub hero: ImageRecipe,
    pub thumb: ImageRecipe,
    pub gallery: ImageRecipe,
    pub video: VideoRecipe,
}

impl Default for Recipe {
    fn default() -> Self {
        Self {
            hero: ImageRecipe { max_width: 2560, width: 0, height: 0, quality: 82.0 },
            thumb: ImageRecipe { max_width: 0, width: 1200, height: 800, quality: 80.0 },
            gallery: ImageRecipe { max_width: 2560, width: 0, height: 0, quality: 82.0 },
            video: VideoRecipe {
                max_width: 1920,
                crf: 23,
                preset: "medium".into(),
                audio: "128k".into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub roots: Vec<Root>,
    #[serde(default = "default_payload")]
    pub payload: Payload,
    #[serde(default)]
    pub recipe: Recipe,
    #[serde(default)]
    pub ffmpeg: Option<String>,
    #[serde(default)]
    pub ffprobe: Option<String>,
}

fn default_payload() -> Payload {
    Payload {
        url: default_payload_url(),
        email: String::new(),
        password: String::new(),
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            payload: default_payload(),
            recipe: Recipe::default(),
            ffmpeg: None,
            ffprobe: None,
        }
    }
}

pub fn reachable(p: &str) -> bool {
    if p.trim().is_empty() {
        return false;
    }
    Path::new(p).is_dir()
}

impl Config {
    pub fn load(path: &Path) -> Self {
        let mut cfg = match std::fs::read_to_string(path) {
            Err(_) => Config::default(),
            Ok(text) => match serde_json::from_str::<Config>(&text) {
                Ok(c) => c,
                Err(e) => {
                    // Falling back to defaults would drop someone's roots the
                    // next time anything saves. Keep a copy and say so loudly.
                    let backup = path.with_extension("json.bak");
                    let _ = std::fs::copy(path, &backup);
                    eprintln!(
                        "page-composer: could not read {} ({e}) — kept a copy at {}",
                        path.display(),
                        backup.display()
                    );
                    Config::default()
                }
            },
        };

        // Environment always wins, so credentials never have to sit on disk.
        if let Ok(v) = std::env::var("PAYLOAD_URL") {
            cfg.payload.url = v;
        }
        if let Ok(v) = std::env::var("PAYLOAD_ADMIN_EMAIL") {
            cfg.payload.email = v;
        }
        if let Ok(v) = std::env::var("PAYLOAD_ADMIN_PASSWORD") {
            cfg.payload.password = v;
        }
        cfg
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Never persist credentials that came from the environment.
        let mut on_disk = self.clone();
        if std::env::var("PAYLOAD_ADMIN_EMAIL").is_ok() {
            on_disk.payload.email = String::new();
        }
        if std::env::var("PAYLOAD_ADMIN_PASSWORD").is_ok() {
            on_disk.payload.password = String::new();
        }
        std::fs::write(path, serde_json::to_string_pretty(&on_disk)? + "\n")?;
        Ok(())
    }

    /// Normalise labels (they form part of every project id, so they must be
    /// unique) and strip trailing separators without damaging a UNC prefix.
    pub fn apply_roots(&mut self, list: Vec<Root>) {
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();

        for (i, r) in list.into_iter().enumerate() {
            let mut path = r.path.trim().to_string();
            while (path.ends_with('\\') || path.ends_with('/')) && !is_bare_unc_prefix(&path) {
                path.pop();
            }
            if path.is_empty() {
                continue;
            }

            let mut label = r.label.trim().to_string();
            if label.is_empty() {
                label = Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("ROOT {}", i + 1));
            }
            while seen.contains(&label) {
                label.push('*');
            }
            seen.push(label.clone());
            out.push(Root { label, path });
        }
        self.roots = out;
    }

    /// Only roots that resolve right now — a NAS being offline must never be
    /// fatal, so unreachable ones stay in the config but are skipped.
    pub fn online_roots(&self) -> Vec<Root> {
        self.roots
            .iter()
            .filter(|r| reachable(&r.path))
            .cloned()
            .collect()
    }

    pub fn root_statuses(&self) -> Vec<RootStatus> {
        self.roots
            .iter()
            .map(|r| RootStatus {
                label: r.label.clone(),
                path: r.path.clone(),
                online: reachable(&r.path),
            })
            .collect()
    }

    pub fn find_root(&self, label: &str) -> Option<Root> {
        self.roots.iter().find(|r| r.label == label).cloned()
    }
}

/// `\\` or `\\server` — popping further would destroy the share reference.
fn is_bare_unc_prefix(p: &str) -> bool {
    p.starts_with("\\\\") && p.trim_start_matches('\\').split('\\').count() <= 1
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_paths_survive_normalisation() {
        let mut cfg = Config::default();
        cfg.apply_roots(vec![Root {
            label: "NAS".into(),
            path: "\\\\nas01\\projects\\z-2026\\".into(),
        }]);
        assert_eq!(cfg.roots[0].path, "\\\\nas01\\projects\\z-2026");
    }

    #[test]
    fn duplicate_labels_are_disambiguated() {
        let mut cfg = Config::default();
        cfg.apply_roots(vec![
            Root { label: "NAS".into(), path: "\\\\a\\b".into() },
            Root { label: "NAS".into(), path: "\\\\c\\d".into() },
        ]);
        assert_eq!(cfg.roots[0].label, "NAS");
        assert_eq!(cfg.roots[1].label, "NAS*");
    }

    /// A config written before the camelCase rename must still load, or the
    /// user's roots disappear on the next save.
    #[test]
    fn reads_both_spellings_of_max_width() {
        let old = r#"{"roots":[{"label":"NAS","path":"\\\\nas01\\projects"}],
            "recipe":{"hero":{"max_width":2560,"width":0,"height":0,"quality":82.0},
            "thumb":{"max_width":0,"width":1200,"height":800,"quality":80.0},
            "gallery":{"max_width":2560,"width":0,"height":0,"quality":82.0},
            "video":{"max_width":1920,"crf":23,"preset":"medium","audio":"128k"}}}"#;
        let cfg: Config = serde_json::from_str(old).expect("legacy config must still parse");
        assert_eq!(cfg.roots.len(), 1, "roots survived");
        assert_eq!(cfg.recipe.gallery.max_width, 2560);
        assert_eq!(cfg.recipe.video.max_width, 1920);

        // And it round-trips out as camelCase for the front end.
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"maxWidth\":2560"));
        let again: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(again.recipe.gallery.max_width, 2560);
    }

    #[test]
    fn blank_label_falls_back_to_the_folder_name() {
        let mut cfg = Config::default();
        cfg.apply_roots(vec![Root { label: "  ".into(), path: "A:/assets/z-2026".into() }]);
        assert_eq!(cfg.roots[0].label, "z-2026");
    }
}
