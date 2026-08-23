//! Path, naming and slug helpers.
//!
//! These mirror `server/util.js` and `web/app.js` exactly — the UI predicts the
//! filename before anything is written, so all three have to agree. If you
//! change a rule here, change it there too.

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "tif", "tiff", "avif", "bmp"];
pub const VIDEO_EXT: &[&str] = &["mov", "mp4", "m4v", "mxf", "avi", "mkv", "webm"];
pub const DOC_EXT: &[&str] = &["docx", "md", "markdown"];

/// Machine droppings, never assets. RAW/master folders are deliberately NOT
/// skipped — the composer transcodes anyway, and silently hiding a source is
/// worse than a long list you can filter in the UI.
pub const SKIP_DIRS: &[&str] = &[
    ".cache",
    "node_modules",
    "_web",
    ".git",
    "Adobe After Effects Auto-Save",
    "Logs",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Image,
    Video,
    Doc,
}

pub fn kind_of(name: &str) -> Option<Kind> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    if IMAGE_EXT.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if VIDEO_EXT.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else if DOC_EXT.contains(&ext.as_str()) {
        Some(Kind::Doc)
    } else {
        None
    }
}

/// `MorganWallen` -> `morgan-wallen`, `Peso Dinastia!` -> `peso-dinastia`.
pub fn slugify(s: &str) -> String {
    // Split camelCase first, so folder names written without separators still
    // read as words.
    let mut split = String::with_capacity(s.len() + 8);
    let chars: Vec<char> = s.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_uppercase() {
            let prev = chars[i - 1];
            if prev.is_lowercase() || prev.is_ascii_digit() {
                split.push('-');
            }
        }
        split.push(*c);
    }

    let lower = split.to_lowercase().replace(['\'', '"'], "");
    let mut out = String::with_capacity(lower.len());
    let mut pending_dash = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out
}

pub struct FolderName {
    pub job_code: String,
    pub slug: String,
    pub title: String,
}

/// `26013_peso-dinastia` -> job 26013, slug `peso-dinastia`.
/// `26002_MG26_Martin Garrix` -> job 26002, slug `martin-garrix`.
/// Only ever a DEFAULT — the UI lets you edit the name base before writing.
pub fn parse_folder_name(folder: &str) -> FolderName {
    let mut job_code = String::new();
    let mut rest = folder.to_string();

    let digits: String = folder.chars().take_while(|c| c.is_ascii_digit()).collect();
    if (4..=6).contains(&digits.len()) {
        let after = &folder[digits.len()..];
        if let Some(stripped) = after.strip_prefix(['_', '-', ' ']) {
            job_code = digits;
            rest = stripped.trim_start_matches(['_', '-', ' ']).to_string();
        }
    }

    let segs: Vec<&str> = rest
        .split('_')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    let last = segs.last().copied().unwrap_or(rest.as_str());
    let last_alnum = last.chars().filter(|c| c.is_alphanumeric()).count();

    let chosen = if segs.len() > 1 && last_alnum >= 4 {
        last.to_string()
    } else {
        segs.join("-")
    };

    let slug = slugify(&chosen);
    let title = slug.replace('-', " ");
    FolderName {
        job_code,
        slug,
        title,
    }
}

pub fn pad2(n: usize) -> String {
    if n < 10 {
        format!("0{n}")
    } else {
        n.to_string()
    }
}

/// The AOIN convention: `project-name-tour_description##`. The index is only
/// appended when a description is shared by more than one asset, so a lone hero
/// stays `..._hero.webp`.
pub fn build_name(base: &str, description: &str, index: usize, group_size: usize, ext: &str) -> String {
    let desc = {
        let d = slugify(description);
        if d.is_empty() {
            "asset".to_string()
        } else {
            d
        }
    };
    let suffix = if group_size > 1 { pad2(index + 1) } else { String::new() };
    format!("{}_{}{}.{}", slugify(base), desc, suffix, ext)
}

/// Guard against `..` escaping the project folder.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let joined = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    // `canonicalize` would fail for a path we are about to create, so normalise
    // by hand instead and reject any parent traversal outright.
    let mut normalised = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                if !normalised.pop() {
                    bail!("path escapes project root: {rel}");
                }
            }
            other => normalised.push(other.as_os_str()),
        }
    }
    if !normalised.starts_with(root) {
        bail!("path escapes project root: {rel}");
    }
    Ok(normalised)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_match_the_js_implementation() {
        assert_eq!(slugify("MorganWallen"), "morgan-wallen");
        assert_eq!(slugify("Peso Dinastia"), "peso-dinastia");
        assert_eq!(slugify("STURDY_The Kid Laroi"), "sturdy-the-kid-laroi");
        assert_eq!(slugify("  --Dinastia  Tour-- "), "dinastia-tour");
        // No split inside an all-caps run: the boundary is lowercase-or-digit
        // followed by uppercase, so "MG26" stays one word (matches the JS).
        assert_eq!(slugify("MG26"), "mg26");
        assert_eq!(slugify("26002_MG26_Martin Garrix"), "26002-mg26-martin-garrix");
    }

    #[test]
    fn folder_names_resolve_to_the_project() {
        let a = parse_folder_name("26013_peso-dinastia");
        assert_eq!(a.job_code, "26013");
        assert_eq!(a.slug, "peso-dinastia");

        let b = parse_folder_name("26002_MG26_Martin Garrix");
        assert_eq!(b.job_code, "26002");
        assert_eq!(b.slug, "martin-garrix");

        let c = parse_folder_name("26024_STURDY_The Kid Laroi");
        assert_eq!(c.slug, "the-kid-laroi");

        // Last segment too short to stand alone — keep the whole thing.
        let d = parse_folder_name("26025_mm_tour_26");
        assert_eq!(d.slug, "mm-tour-26");

        let e = parse_folder_name("26012_MorganWallen");
        assert_eq!(e.slug, "morgan-wallen");
        assert_eq!(e.title, "morgan wallen");
    }

    #[test]
    fn names_follow_the_convention() {
        // Singleton: no index.
        assert_eq!(
            build_name("peso-dinastia-dinastia-tour", "hero", 0, 1, "webp"),
            "peso-dinastia-dinastia-tour_hero.webp"
        );
        // Shared description: two-digit index.
        assert_eq!(
            build_name("peso-dinastia-dinastia-tour", "gallery", 3, 6, "webp"),
            "peso-dinastia-dinastia-tour_gallery04.webp"
        );
        assert_eq!(
            build_name("peso-dinastia", "gallery", 11, 12, "mp4"),
            "peso-dinastia_gallery12.mp4"
        );
    }

    #[test]
    fn traversal_is_rejected() {
        let root = Path::new("A:/projects/26013");
        assert!(safe_join(root, "01_Photos/a.jpg").is_ok());
        assert!(safe_join(root, "../../windows/system32").is_err());
    }
}
