//! Parses a dropped `.docx`/`.md` into the Payload project shape.
//!
//! The `.docx` side reads OOXML directly rather than going through a converter:
//! Word paragraphs carry their heading style in `w:pPr/w:pStyle`, and soft line
//! breaks (`w:br`) inside one paragraph have to be treated as separate lines —
//! otherwise a metadata block collapses and the first key swallows every other
//! field as its value.

use crate::config::Config;
use crate::scan;
use crate::util::slugify;
use crate::AppState;
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;
use tauri::State;

pub const TAXONOMY: &[&str] = &[
    "REAL-TIME CONTENT",
    "SCREENS PRODUCTION",
    "MIXED REALITY",
    "EQUIPMENT RENTAL",
];

// Mirrors the required fields on the live Projects collection: title, slug,
// year and capabilities. `image` is required too, but that is the hero you
// pick on step 02, not something the copy doc can supply.
const REQUIRED: &[&str] = &["title", "slug", "year"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockType {
    Heading,
    P,
    Li,
    /// The value half of a field in the team's doc template, or a stats/credits
    /// grid. Kept as structure rather than flattened to prose.
    Table,
}

#[derive(Debug, Clone, Serialize)]
pub struct Block {
    #[serde(rename = "type")]
    pub kind: BlockType,
    pub text: String,
    /// The same content as Markdown, when the source carried formatting. `text`
    /// stays plain because that is what field matching reads; `rich` is what a
    /// write-up publishes, so bold, italics, underlines and links survive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rich: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<String>>>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stat {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreditEntry {
    /// The role, e.g. CREATIVE DIRECTION. Named `title` because that is what
    /// the collection calls it — this used to be `role`/`handle`, a shape that
    /// exists nowhere, so parsed credits could never publish.
    pub title: String,
    pub name: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreditGroup {
    pub title: String,
    pub entries: Vec<CreditEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Writeup {
    #[serde(default)]
    pub lead: String,
    #[serde(default)]
    pub body: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Fields {
    pub title: Option<String>,
    pub slug: Option<String>,
    pub client: Option<String>,
    pub year: Option<String>,
    pub role: Option<String>,
    pub scope: Option<String>,
    pub tour: Option<String>,
    pub collaborator: Option<String>,
    pub summary: Option<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Held as labels; resolved to relationship ids when publishing.
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub stats: Vec<Stat>,
    #[serde(default)]
    pub credits: Vec<CreditGroup>,
    #[serde(default)]
    pub writeup: Writeup,
}

#[derive(Debug, Serialize)]
pub struct Validation {
    pub ok: bool,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
    pub required: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDoc {
    pub file: String,
    pub rel: String,
    pub fields: Fields,
    pub blocks: Vec<Block>,
    pub validation: Validation,
}

// `Label: value`, `Label — value`
fn kv_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([A-Za-z][A-Za-z .'/\-]{1,34}?)\s*[:\u{2013}\u{2014}]\s*(.+)$").unwrap())
}

fn field_alias(key: &str) -> Option<&'static str> {
    Some(match key {
        "title" | "project" | "artist" | "artist/title" | "name" => "title",
        // The labels the team's own doc template uses, once normalised.
        "artist name/project title" | "project title" | "artist name" => "title",
        "tour name/subtitle" | "tour name" | "subtitle" => "tour",
        "slug" => "slug",
        "year" => "year",
        "capabilities" | "capability" => "capabilities",
        "services" | "service" => "services",
        "tour" => "tour",
        "collaborator" | "collaborators" => "collaborator",
        "summary" | "lede" | "lead" | "short summary" => "summary",
        "body" | "description" => "body",
        _ => return None,
    })
}

fn section_of(heading: &str) -> Option<&'static str> {
    let h = heading.trim().to_lowercase();
    let h = h.trim_end_matches(':').trim();
    Some(match h {
        "write-up" | "writeup" | "write up" | "production notes" | "story" | "the story"
        | "long form" | "narrative" => "writeup",
        "stats" | "numbers" | "by the numbers" | "key stats" => "stats",
        "credits" | "team" | "crew" => "credits",
        "summary" | "lede" | "lead" => "summary",
        _ => return None,
    })
}

fn norm_role(v: &str) -> Option<String> {
    let s = v.trim().to_uppercase();
    let flat = s.replace('-', " ");
    TAXONOMY
        .iter()
        .find(|t| **t == s || t.replace('-', " ") == flat)
        .map(|t| t.to_string())
}

/// A run of lines becomes ONE paragraph, except that every line reading as
/// `Label: value` stands alone.
fn lines_to_blocks_vec(raw: &str, kind: BlockType) -> Vec<Block> {
    let mut out = Vec::new();
    lines_to_blocks(raw, kind, &mut out);
    out
}

/// Characters that would otherwise be read back as Markdown markup.
fn escape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn lines_to_blocks(raw: &str, kind: BlockType, out: &mut Vec<Block>) {
    let mut prose: Vec<String> = Vec::new();
    let flush = |prose: &mut Vec<String>, out: &mut Vec<Block>| {
        if !prose.is_empty() {
            let text = prose.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
            if !text.is_empty() {
                out.push(Block { kind, text, rich: None, rows: None, tag: None });
            }
            prose.clear();
        }
    };

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if kv_re().is_match(line) {
            flush(&mut prose, out);
            out.push(Block { kind, text: line.to_string(), rich: None, rows: None, tag: None });
        } else {
            prose.push(line.to_string());
        }
    }
    flush(&mut prose, out);
}

/// The real copy docs are built from Google Docs TABLES, not `Label: value`
/// lines. Exported to Markdown a field is a label paragraph followed by a
/// one-cell table; stats and credits are multi-column tables. Everything below
/// reads that shape, matching `server/copydoc.js` behaviour for behaviour.
fn is_separator_cell(c: &str) -> bool {
    let t = c.trim().trim_start_matches(':').trim_end_matches(':');
    !t.is_empty() && t.chars().all(|ch| ch == '-')
}

fn is_table_chunk(chunk: &str) -> bool {
    let mut any = false;
    for l in chunk.lines() {
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        any = true;
        if !t.starts_with('|') {
            return false;
        }
    }
    any
}

fn parse_markdown_table(chunk: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for line in chunk.lines() {
        let t = line.trim();
        if !t.starts_with('|') {
            continue;
        }
        let inner = t.trim_start_matches('|').trim_end_matches('|');
        let cells: Vec<String> = inner.split('|').map(|c| unescape_md(c.trim())).collect();
        if cells.iter().all(|c| c.is_empty() || is_separator_cell(c)) {
            continue;
        }
        rows.push(cells);
    }
    rows
}

/// Google Docs escapes `_`, `+` and friends on export; undo that.
fn unescape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&n) = chars.peek() {
                if matches!(n, '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '(' | ')' | '#' | '+' | '-' | '.' | '!') {
                    out.push(n);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// `[label](url)` -> (label, url), for a credit whose name carries the link.
fn split_link(cell: &str) -> (String, String) {
    let t = cell.trim();
    if let Some(rest) = t.strip_prefix('[') {
        if let Some(close) = rest.find("](") {
            if let Some(end) = rest.rfind(')') {
                if end > close + 1 {
                    return (rest[..close].trim().to_string(), rest[close + 2..end].trim().to_string());
                }
            }
        }
    }
    (t.to_string(), String::new())
}

/// Labels carry parentheticals and slashes ("Capabilities (Services Rendered)").
fn norm_label(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    // A label bolded in the Google Doc exports as `**Full Write Up**`, and those
    // markers are part of the text here. A doc that bolded its headings lost its
    // entire write-up section in silence, because the label simply never
    // matched. Heading hashes go the same way.
    let out: String = out
        .trim_start()
        .trim_start_matches('#')
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`'))
        .collect();
    out.to_lowercase()
        .trim_end_matches([':', '.'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The section a label paragraph names, including the credit-group variants.
fn section_for_label(label: &str) -> Option<&'static str> {
    Some(match label {
        "full write up" | "full writeup" => "writeup",
        "team credits" => "credits:ALL OF IT NOW",
        "collaborator credits" | "partner credits" => "credits:COLLABORATORS",
        "press link" | "press links" => "ignore",
        other => return section_of(other),
    })
}

/// The services cell has no delimiter once Google Docs exports it, so the CMS
/// list is the only thing that knows where one name ends. Longest match first;
/// whatever cannot be matched is kept whole and shown as unmatched rather than
/// being guessed at.
fn split_services(value: &str, service_list: &[String]) -> Vec<String> {
    let explicit: Vec<String> = value
        .split([',', ';', '\n'])
        .flat_map(|v| v.split("  "))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    if explicit.len() > 1 || service_list.is_empty() {
        return explicit;
    }
    let mut known: Vec<&String> = service_list.iter().collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.trim().len()));

    let mut rest = value.trim().to_string();
    let mut found = Vec::new();
    let mut guard = 0;
    while !rest.is_empty() && guard < 64 {
        guard += 1;
        let lower = rest.to_lowercase();
        match known.iter().find(|k| lower.starts_with(&k.trim().to_lowercase())) {
            Some(k) => {
                let n = k.trim().len();
                found.push(k.trim().to_string());
                // `get` rather than an index: a name that is not plain ASCII
                // would otherwise slice mid-character and panic the parse.
                rest = match rest.get(n..) {
                    Some(tail) => tail.trim().to_string(),
                    None => break,
                };
            }
            None => break,
        }
    }
    if found.is_empty() {
        return explicit;
    }
    if !rest.is_empty() {
        found.push(rest);
    }
    found
}

/// Capabilities have the same problem as services and for the same reason: the
/// Markdown export joins what were separate lines with single spaces, so
/// "REAL-TIME CONTENT SCREENS PRODUCTION" arrives as one string with no
/// delimiter left to split on. The fixed taxonomy is the only thing that knows
/// where one ends, so it is matched against exactly as the CMS list is.
fn split_capabilities(value: &str) -> Vec<String> {
    let taxonomy: Vec<String> = TAXONOMY.iter().map(|t| t.to_string()).collect();
    let explicit: Vec<String> = value
        .split([',', ';', '/', '\n'])
        .filter_map(norm_role)
        .collect();
    if explicit.len() > 1 {
        return explicit;
    }
    split_services(value, &taxonomy).iter().filter_map(|v| norm_role(v)).collect()
}

/// Writes one parsed value into the field it belongs to.
fn apply_field(f: &mut Fields, field: &str, value: &str, service_list: &[String]) {
    match field {
        "capabilities" => {
            f.capabilities = split_capabilities(value);
        }
        "services" => f.services = split_services(value, service_list),
        "tour" => f.tour = Some(value.to_uppercase()),
        "collaborator" => f.collaborator = Some(value.to_uppercase()),
        "title" => f.title = Some(value.to_uppercase()),
        "slug" => f.slug = Some(value.to_string()),
        "year" => f.year = Some(value.to_string()),
        "summary" => f.summary = Some(value.to_string()),
        "body" => f.body = Some(value.to_string()),
        _ => {}
    }
}

/// `<w:b w:val="0"/>` and friends mean the mark is explicitly OFF.
fn attr_is_off(e: &quick_xml::events::BytesStart) -> bool {
    e.attributes().flatten().any(|a| {
        a.key.local_name().as_ref() == b"val"
            && matches!(
                String::from_utf8_lossy(&a.value).as_ref(),
                "0" | "false" | "none" | "off"
            )
    })
}

/// Word emits one run per formatting change, so a phrase typed in one go can
/// arrive as `**A****B**`. Collapse the seams so the Markdown reads normally.
fn tidy_markers(s: &str) -> String {
    // Only the seams between two runs carrying the SAME mark are closed. Any
    // cleverer rewriting risks changing text that was never formatting.
    let mut out = s.replace("</u><u>", "");
    while out.contains("****") {
        out = out.replace("****", "");
    }
    out
}

/// Reads `word/document.xml` and flattens it into typed blocks.
fn docx_blocks(file: &Path) -> Result<Vec<Block>> {
    let f = std::fs::File::open(file)?;
    let mut zip = zip::ZipArchive::new(f)?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| anyhow!("not a Word document (no word/document.xml)"))?
        .read_to_string(&mut xml)?;

    // Hyperlink targets live in a sibling part, keyed by the r:id on the run.
    // A doc with no links simply has no rels part, which is not an error.
    let mut links: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut rels) = zip.by_name("word/_rels/document.xml.rels") {
        let mut rels_xml = String::new();
        if rels.read_to_string(&mut rels_xml).is_ok() {
            let mut r = Reader::from_str(&rels_xml);
            let mut rbuf = Vec::new();
            loop {
                match r.read_event_into(&mut rbuf) {
                    Ok(Event::Start(e)) | Ok(Event::Empty(e))
                        if e.name().local_name().as_ref() == b"Relationship" =>
                    {
                        let (mut id, mut target) = (String::new(), String::new());
                        for a in e.attributes().flatten() {
                            match a.key.local_name().as_ref() {
                                b"Id" => id = String::from_utf8_lossy(&a.value).to_string(),
                                b"Target" => target = String::from_utf8_lossy(&a.value).to_string(),
                                _ => {}
                            }
                        }
                        if !id.is_empty() && !target.is_empty() {
                            links.insert(id, target);
                        }
                    }
                    Ok(Event::Eof) | Err(_) => break,
                    _ => {}
                }
                rbuf.clear();
            }
        }
    }
    let mut link_stack: Vec<String> = Vec::new();

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);

    let mut out: Vec<Block> = Vec::new();
    let mut buf = Vec::new();
    let mut in_para = false;
    let mut para = String::new();
    // The Markdown twin of `para`, built from the same runs.
    let mut rich = String::new();
    let mut style: Option<String> = None;
    let mut is_list = false;
    let mut in_text = false;
    // Run properties apply to the <w:t> that follows them inside the same run.
    let mut in_rpr = false;
    let (mut bold, mut italic, mut underline) = (false, false, false);

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let local = String::from_utf8_lossy(name.local_name().as_ref()).to_string();
                match local.as_str() {
                    "p" => {
                        in_para = true;
                        para.clear();
                        style = None;
                        is_list = false;
                    }
                    "pStyle" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.local_name().as_ref() == b"val" {
                                style = Some(String::from_utf8_lossy(&attr.value).to_string());
                            }
                        }
                    }
                    "numPr" => is_list = true,
                    // Soft breaks inside a paragraph are real line boundaries.
                    "br" | "cr" => {
                        para.push('\n');
                        rich.push('\n');
                    }
                    "tab" => {
                        para.push(' ');
                        rich.push(' ');
                    }
                    "t" => in_text = true,
                    // A new run starts with no marks until its own rPr says so.
                    "r" => {
                        bold = false;
                        italic = false;
                        underline = false;
                    }
                    "rPr" => in_rpr = true,
                    "b" if in_rpr => bold = !attr_is_off(&e),
                    "i" if in_rpr => italic = !attr_is_off(&e),
                    "u" if in_rpr => underline = !attr_is_off(&e),
                    // <w:hyperlink r:id="rIdN"> — the target lives in the rels.
                    "hyperlink" => {
                        let id = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.local_name().as_ref() == b"id")
                            .map(|a| String::from_utf8_lossy(&a.value).to_string());
                        let target = id.and_then(|i| links.get(&i).cloned()).unwrap_or_default();
                        link_stack.push(target);
                        rich.push('[');
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_text && in_para {
                    let raw = e.unescape().unwrap_or_default().to_string();
                    para.push_str(&raw);
                    // Word splits a formatted phrase across runs, so each run is
                    // wrapped on its own. Adjacent identical markers are tidied
                    // up after the paragraph closes.
                    let mut piece = escape_md(&raw);
                    if !piece.trim().is_empty() {
                        if underline {
                            piece = format!("<u>{piece}</u>");
                        }
                        if italic {
                            piece = format!("*{piece}*");
                        }
                        if bold {
                            piece = format!("**{piece}**");
                        }
                    }
                    rich.push_str(&piece);
                }
            }
            Ok(Event::End(e)) => {
                let local = String::from_utf8_lossy(e.name().local_name().as_ref()).to_string();
                match local.as_str() {
                    "t" => in_text = false,
                    "rPr" => in_rpr = false,
                    "hyperlink" => {
                        let target = link_stack.pop().unwrap_or_default();
                        rich.push_str(&format!("]({target})"));
                    }
                    "p" => {
                        in_para = false;
                        let styled = style.clone().unwrap_or_default().to_lowercase();
                        let is_heading = styled.starts_with("heading") || styled == "title";
                        let text = para.clone();
                        if is_heading {
                            let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
                            if !flat.is_empty() {
                                out.push(Block { kind: BlockType::Heading, text: flat, rich: None, rows: None, tag: None });
                            }
                        } else {
                            let kind = if is_list { BlockType::Li } else { BlockType::P };
                            // Both halves split the same way, so they zip by index.
                            let plain = lines_to_blocks_vec(&text, kind);
                            let rich_blocks = lines_to_blocks_vec(&tidy_markers(&rich), kind);
                            for (i, mut b) in plain.into_iter().enumerate() {
                                b.rich = rich_blocks.get(i).map(|r| r.text.clone());
                                out.push(b);
                            }
                        }
                        para.clear();
                        rich.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow!("malformed .docx: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn markdown_blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    for chunk in text.split("\n\n") {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        if is_table_chunk(chunk) {
            let rows = parse_markdown_table(chunk);
            if !rows.is_empty() {
                let text = rows.iter().map(|r| r.join("  ")).collect::<Vec<_>>().join("\n");
                out.push(Block { kind: BlockType::Table, text, rich: None, rows: Some(rows), tag: None });
            }
            continue;
        }
        if let Some(rest) = chunk.strip_prefix('#') {
            let heading = rest.trim_start_matches('#').trim();
            if !heading.is_empty() {
                out.push(Block {
                    kind: BlockType::Heading,
                    text: heading.split_whitespace().collect::<Vec<_>>().join(" "),
                    rich: None,
                    rows: None,
                    tag: None,
                });
                continue;
            }
        }
        let bulleted = chunk.lines().any(|l| {
            let t = l.trim_start();
            t.starts_with("- ") || t.starts_with("* ")
        });
        if bulleted {
            let stripped: String = chunk
                .lines()
                .map(|l| l.trim_start().trim_start_matches(['-', '*']).trim_start())
                .collect::<Vec<_>>()
                .join("\n");
            lines_to_blocks(&stripped, BlockType::Li, &mut out);
        } else {
            lines_to_blocks(chunk, BlockType::P, &mut out);
        }
    }
    out
}

pub fn parse(file: &Path) -> Result<(Fields, Vec<Block>)> {
    parse_with_services(file, &[])
}

pub fn parse_with_services(file: &Path, service_list: &[String]) -> Result<(Fields, Vec<Block>)> {
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let blocks = if ext == "docx" {
        docx_blocks(file)?
    } else {
        markdown_blocks(&std::fs::read_to_string(file)?.replace("\r\n", "\n"))
    };

    let mut f = Fields::default();
    let mut mapped: Vec<Block> = Vec::new();
    let mut section: Option<&'static str> = None;
    let mut credit_group: Option<usize> = None;

    // A label paragraph is only a label if a table follows it; otherwise it is
    // prose. That look-ahead is why this walks by index.
    let kinds: Vec<BlockType> = blocks.iter().map(|b| b.kind).collect();
    let mut pending_label: Option<String> = None;

    for (bi, b) in blocks.into_iter().enumerate() {
        // ---- the value half of a field, or a stats/credits grid ----
        if b.kind == BlockType::Table {
            let label = pending_label.take().unwrap_or_default();
            let rows = b.rows.clone().unwrap_or_default();
            let single = !rows.is_empty() && rows.iter().all(|r| r.len() == 1);

            if label == "stats" && rows.len() >= 2 {
                let head = rows[0].clone();
                for row in &rows[1..] {
                    for (i, h) in head.iter().enumerate() {
                        let value = row.get(i).map(|v| v.trim()).unwrap_or("");
                        if !h.is_empty() && !value.is_empty() {
                            f.stats.push(Stat { label: h.to_uppercase(), value: value.to_string() });
                        }
                    }
                }
                mapped.push(Block { tag: Some("stats".into()), ..b });
                continue;
            }

            let credit_title = section_for_label(&label)
                .and_then(|sec| sec.strip_prefix("credits:").map(|t| t.to_string()));
            if let Some(title) = credit_title {
                if rows.len() >= 2 {
                    let mut group = CreditGroup { title: title.clone(), entries: Vec::new() };
                    for row in &rows[1..] {
                        let role = row.first().map(|r| r.trim()).unwrap_or("");
                        let (who, link) = split_link(row.get(1).map(|r| r.as_str()).unwrap_or(""));
                        let url = row.get(2).map(|r| r.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or(link);
                        if !role.is_empty() || !who.is_empty() {
                            group.entries.push(CreditEntry { title: role.to_uppercase(), name: who, url });
                        }
                    }
                    if !group.entries.is_empty() {
                        f.credits.push(group);
                    }
                    mapped.push(Block { tag: Some(format!("credits:{title}")), ..b });
                    continue;
                }
            }

            if single {
                let value = rows.iter().filter_map(|r| r.first()).cloned().collect::<Vec<_>>().join(" ");
                let value = value.trim();
                if let Some(field) = field_alias(&label) {
                    if !value.is_empty() {
                        apply_field(&mut f, field, value, service_list);
                        mapped.push(Block { tag: Some(field.to_string()), ..b });
                        continue;
                    }
                }
            }
            mapped.push(Block { tag: None, ..b });
            continue;
        }

        if b.kind == BlockType::Heading {
            if let Some(s) = section_of(&b.text) {
                section = Some(s);
                credit_group = None;
                mapped.push(Block { tag: Some(format!("section:{s}")), ..b });
                continue;
            }
            if section == Some("credits") {
                f.credits.push(CreditGroup { title: b.text.to_uppercase(), entries: Vec::new() });
                credit_group = Some(f.credits.len() - 1);
                mapped.push(Block { tag: Some("credits[].title".into()), ..b });
                continue;
            }
            // A sub-heading inside the write-up belongs TO the write-up. Ending
            // the section here truncated the copy after two paragraphs.
            if section == Some("writeup") {
                f.writeup.body.push(format!("## {}", b.text));
                let tag = format!("writeup.body[{}]", f.writeup.body.len() - 1);
                mapped.push(Block { tag: Some(tag), ..b });
                continue;
            }
            section = None;
            mapped.push(Block { tag: None, ..b });
            continue;
        }

        // A short paragraph naming a section switches section even without a
        // table ("Full Write Up" is a plain line in the template, not a heading).
        let label = norm_label(&b.text);
        if b.text.len() < 60 {
            if let Some(sec) = section_for_label(&label) {
                pending_label = Some(label.clone());
                if sec == "ignore" {
                    section = Some("ignore");
                } else if !sec.starts_with("credits:") {
                    section = Some(sec);
                    credit_group = None;
                }
                mapped.push(Block { tag: Some(format!("section:{sec}")), ..b });
                continue;
            }
            // A short paragraph naming a field labels the table beneath it.
            if let Some(field) = field_alias(&label) {
                if kinds.get(bi + 1) == Some(&BlockType::Table) {
                    pending_label = Some(label.clone());
                    mapped.push(Block { tag: Some(format!("label:{field}")), ..b });
                    continue;
                }
            }
        }

        if section == Some("ignore") {
            mapped.push(Block { tag: None, ..b });
            continue;
        }

        let caps = kv_re().captures(&b.text);
        let key = caps
            .as_ref()
            .map(|c| c[1].trim().to_lowercase())
            .unwrap_or_default();
        let val = caps.as_ref().map(|c| c[2].trim().to_string()).unwrap_or_default();

        if section == Some("credits") && caps.is_some() {
            let idx = match credit_group {
                Some(i) => i,
                None => {
                    f.credits.push(CreditGroup { title: "CREDITS".into(), entries: Vec::new() });
                    credit_group = Some(f.credits.len() - 1);
                    f.credits.len() - 1
                }
            };
            f.credits[idx].entries.push(CreditEntry {
                title: caps.as_ref().unwrap()[1].trim().to_uppercase(),
                name: val,
                url: String::new(),
            });
            mapped.push(Block { tag: Some("credits[].entries".into()), ..b });
            continue;
        }

        if section == Some("stats") && caps.is_some() {
            f.stats.push(Stat {
                label: caps.as_ref().unwrap()[1].trim().to_uppercase(),
                value: val,
            });
            mapped.push(Block { tag: Some("stats[]".into()), ..b });
            continue;
        }

        if let (true, Some(field)) = (caps.is_some(), field_alias(&key)) {
            match field {
                "capabilities" => {
                    f.capabilities = split_capabilities(&val);
                }
                // Kept as written: these are matched against the CMS list at
                // publish, which is the only place that knows what exists.
                "services" => {
                    f.services = val
                        .split([',', ';'])
                        .map(|c| c.trim().to_string())
                        .filter(|c| !c.is_empty())
                        .collect();
                }
                "role" => f.role = Some(norm_role(&val).unwrap_or_else(|| val.to_uppercase())),
                "tour" => f.tour = Some(val.to_uppercase()),
                "collaborator" => f.collaborator = Some(val.to_uppercase()),
                "client" => f.client = Some(val.to_uppercase()),
                "title" => f.title = Some(val),
                "slug" => f.slug = Some(val),
                "year" => f.year = Some(val),
                "scope" => f.scope = Some(val),
                "summary" => f.summary = Some(val),
                "body" => f.body = Some(val),
                _ => {}
            }
            mapped.push(Block { tag: Some(field.to_string()), ..b });
            continue;
        }

        if section == Some("writeup") && b.kind == BlockType::P {
            // The write-up keeps the doc's formatting; every other field is plain.
            let content = b.rich.clone().unwrap_or_else(|| b.text.clone());
            let tag = if f.writeup.lead.is_empty() {
                f.writeup.lead = content;
                "writeup.lead".to_string()
            } else {
                f.writeup.body.push(content);
                format!("writeup.body[{}]", f.writeup.body.len() - 1)
            };
            mapped.push(Block { tag: Some(tag), ..b });
            continue;
        }

        if section == Some("summary") && b.kind == BlockType::P && f.summary.is_none() {
            f.summary = Some(b.text.clone());
            mapped.push(Block { tag: Some("summary".into()), ..b });
            continue;
        }

        mapped.push(Block { tag: None, ..b });
    }

    // A doc with no explicit `Title:` line — take the first heading.
    if f.title.is_none() {
        f.title = mapped
            .iter()
            .find(|b| b.kind == BlockType::Heading)
            .map(|b| b.text.clone());
    }
    if f.slug.is_none() {
        if let Some(t) = &f.title {
            f.slug = Some(slugify(t));
        }
    }
    if let Some(t) = &f.title {
        f.title = Some(t.to_uppercase());
    }
    // `role` is no longer a field on the collection, so it is never derived from
    // capabilities any more - the traffic only ever went the other way.
    if f.capabilities.is_empty() {
        if let Some(r) = &f.role {
            f.capabilities = vec![r.clone()];
        }
    }

    Ok((f, mapped))
}

pub fn validate(f: &Fields) -> Validation {
    let mut missing = Vec::new();
    for key in REQUIRED {
        let v = match *key {
            "title" => &f.title,
            "slug" => &f.slug,
            "client" => &f.client,
            "year" => &f.year,
            "role" => &f.role,
            "scope" => &f.scope,
            _ => &None,
        };
        if v.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            missing.push(key.to_string());
        }
    }
    if f.capabilities.is_empty() {
        missing.push("capabilities".into());
    }

    let mut errors = Vec::new();
    if let Some(role) = &f.role {
        if !role.is_empty() && !TAXONOMY.contains(&role.as_str()) {
            errors.push(format!("role \"{role}\" is not in the taxonomy"));
        }
    }
    for c in &f.capabilities {
        if !TAXONOMY.contains(&c.as_str()) {
            errors.push(format!("capability \"{c}\" is not in the taxonomy"));
        }
    }

    Validation {
        ok: missing.is_empty() && errors.is_empty(),
        missing,
        errors,
        required: REQUIRED.len() + 1,
    }
}

#[tauri::command]
pub async fn read_copy_doc(
    state: State<'_, AppState>,
    id: String,
    rel: Option<String>,
) -> Result<Option<ParsedDoc>, String> {
    let cfg: Config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let project = scan::get_project(&cfg, &id).map_err(|e| e.to_string())?;

    let chosen = rel
        .or_else(|| project.docs.first().map(|d| d.rel.clone()));
    let Some(chosen) = chosen else { return Ok(None) };

    let d = scan::decode_id(&cfg, &id).map_err(|e| e.to_string())?;
    let path = d.resolve(&chosen).map_err(|e| e.to_string())?;
    // The services cell has no delimiter once Google Docs exports it, so the
    // parser is handed the CMS list to split it against.
    let services: Vec<String> = crate::payload::service_categories(&cfg)
        .await
        .into_iter()
        .map(|s| s.label)
        .collect();
    let (fields, blocks) = parse_with_services(&path, &services).map_err(|e| e.to_string())?;
    let validation = validate(&fields);

    Ok(Some(ParsedDoc {
        file: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        rel: chosen,
        fields,
        blocks,
        validation,
    }))
}

#[tauri::command]
pub fn validate_fields(fields: Fields) -> Validation {
    validate(&fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_metadata_block_does_not_collapse_into_one_field() {
        let md = "# Peso Dinastia\n\nClient: Live Nation\nYear: 2026\nRole: Real-Time Content\nScope: LED / Playback\nTour: Dinastia Tour\nCapabilities: Real-Time Content, Screens Production\n";
        let blocks = markdown_blocks(md);
        let mut f = Fields::default();
        // Six KV lines must be six blocks, not one.
        assert_eq!(blocks.iter().filter(|b| b.kind == BlockType::P).count(), 6);
        f.title = Some("x".into());
    }

    /// Reads a real Word file, including soft line breaks inside a paragraph.
    /// `cargo test --lib -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the sample .docx"]
    fn parses_a_real_docx() {
        let file = std::path::PathBuf::from(std::env::var("AOIN_TEST_DOCX").expect("set AOIN_TEST_DOCX"));
        let (f, blocks) = parse(&file).expect("docx should parse");
        println!("blocks: {}", blocks.len());
        for b in &blocks {
            println!("  [{:?}] {:?} -> {:?}", b.kind, b.text, b.tag);
        }
        println!("{:#?}", f);

        assert_eq!(f.title.as_deref(), Some("PESO DINASTIA"));
        assert_eq!(f.client.as_deref(), Some("LIVE NATION"));
        assert_eq!(f.year.as_deref(), Some("2026"));
        assert_eq!(f.role.as_deref(), Some("REAL-TIME CONTENT"));
        assert_eq!(f.tour.as_deref(), Some("DINASTIA TOUR"));
        assert_eq!(f.capabilities.len(), 2);
        assert_eq!(f.stats.len(), 3);
        assert_eq!(f.credits.len(), 1);
        assert_eq!(f.credits[0].entries.len(), 2);
        assert!(!f.writeup.lead.is_empty());
        assert!(validate(&f).ok, "validation: {:?}", validate(&f));
    }


    /// Builds a .docx the way a Google Docs export looks, with real run
    /// formatting and a hyperlink, and checks the Markdown that comes back.
    /// The expectations here mirror design/test-richtext.mjs on purpose: the two
    /// backends must produce the same write-up from the same document.
    #[test]
    fn word_formatting_survives_as_markdown() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let run = |text: &str, props: &str| {
            let rpr = if props.is_empty() { String::new() } else { format!("<w:rPr>{props}</w:rPr>") };
            format!("<w:r>{rpr}<w:t xml:space=\"preserve\">{text}</w:t></w:r>")
        };
        let body = format!(
            "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr>{}</w:p><w:p>{}{}{}{}{}{}{}{}</w:p>",
            run("Write-up", ""),
            run("The ", ""),
            run("Dinastia", "<w:b/>"),
            run(" tour used ", ""),
            run("real-time", "<w:i/>"),
            run(" content and an ", ""),
            run("underlined", "<w:u w:val=\"single\"/>"),
            run(" note, see ", ""),
            format!(
                "<w:hyperlink r:id=\"rL1\">{}</w:hyperlink>{}",
                run("allofitnow.com", ""),
                run(".", "")
            ),
        );
        let doc = format!(
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body>{body}</w:body></w:document>"
        );
        let rels = "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rL1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://allofitnow.com\" TargetMode=\"External\"/></Relationships>";

        let dir = std::env::temp_dir().join("aoin-docx-fmt-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fmt.docx");
        {
            let f = std::fs::File::create(&file).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            z.start_file("word/document.xml", opts).unwrap();
            z.write_all(doc.as_bytes()).unwrap();
            z.start_file("word/_rels/document.xml.rels", opts).unwrap();
            z.write_all(rels.as_bytes()).unwrap();
            z.finish().unwrap();
        }

        let (f, _) = parse(&file).unwrap();
        assert_eq!(
            f.writeup.lead,
            "The **Dinastia** tour used *real-time* content and an <u>underlined</u> note, see [allofitnow.com](https://allofitnow.com)."
        );
    }


    #[test]
    fn adjacent_runs_with_the_same_mark_join_up() {
        // Word emits one run per formatting change, so a phrase bolded in one
        // go can arrive split. The seam must close, not double up.
        assert_eq!(tidy_markers("**A****B**"), "**AB**");
        assert_eq!(tidy_markers("a <u>x</u><u>y</u> b"), "a <u>xy</u> b");
        // Ordinary prose must come through untouched.
        assert_eq!(tidy_markers("a **b** c"), "a **b** c");
        assert_eq!(tidy_markers("***both***"), "***both***");
        assert_eq!(tidy_markers(r"2 \* 3 \* 4"), r"2 \* 3 \* 4");
    }


    /// The copy-doc format the team actually writes: Google Docs TABLES, not
    /// `Label: value` lines. Mirrors design/test-copydoc.mjs so the two backends
    /// cannot drift on the one input that matters most.
    /// Renee Rapp's doc bolded its section headings, so the write-up label came
    /// through as `**Full Write Up**`, matched nothing, and the entire body was
    /// dropped without a word. Everything else on that page published fine,
    /// which is what made it hard to notice.
    #[test]
    fn a_bolded_label_still_names_its_section() {
        assert_eq!(norm_label("**Full Write Up**"), "full write up");
        assert_eq!(norm_label("## Full Write Up"), "full write up");
        assert_eq!(norm_label("Capabilities (Services Rendered)"), "capabilities");
        assert_eq!(norm_label("*Stats*:"), "stats");
    }

    #[test]
    fn capabilities_joined_by_single_spaces_still_split() {
        // What a two-line Google Docs cell looks like after the Markdown export.
        assert_eq!(
            split_capabilities("REAL-TIME CONTENT SCREENS PRODUCTION"),
            vec!["REAL-TIME CONTENT".to_string(), "SCREENS PRODUCTION".to_string()]
        );
        // Explicit delimiters still win, and one value stays one value.
        assert_eq!(
            split_capabilities("REAL-TIME CONTENT, MIXED REALITY"),
            vec!["REAL-TIME CONTENT".to_string(), "MIXED REALITY".to_string()]
        );
        assert_eq!(split_capabilities("EQUIPMENT RENTAL"), vec!["EQUIPMENT RENTAL".to_string()]);
        // Nothing recognisable must not invent anything.
        assert!(split_capabilities("SOMETHING ELSE ENTIRELY").is_empty());
    }

    #[test]
    fn google_docs_tables_map_to_fields() {
        let doc = concat!(
            "Artist Name/Project Title\n\n| LINKIN PARK |\n| :---- |\n\n",
            "Tour Name/Subtitle\n\n| FROM ZERO TOUR |\n| :---- |\n\n",
            "Year\n\n| 2024 |\n| :---- |\n\n",
            "Collaborator\n\n| STURDY. |\n| :---- |\n\n",
            "Capabilities (Services Rendered)\n\n| REAL-TIME CONTENT  |\n| :---- |\n\n",
            "Services\n\n| Notch IMAG Design Notch Content Design |\n| :---- |\n\n",
            "Summary (1-2 sentences)\n\n| A dynamic IMAG system was developed. |\n| :---- |\n\n",
            "Stats\n\n| Shows | Tickets Sold |\n| :---- | :---- |\n| 80 | 2.2M |\n\n",
            "Team Credits\n\n| Role | Name | Socials Link |\n| :---- | :---- | :---- |\n",
            "| Notch Designer | Berto Mora | https://insta.com/berto\\_mora/ |\n\n",
            "Collaborator Credits\n\n| Role | Company | Socials Link |\n| :---- | :---- | :---- |\n",
            "| Artist | [Linkin Park](https://fromzero.linkinpark.com/) |  |\n\n",
            "Full Write Up\n\nThe band's resurgence.\n\n## AOIN Involvement\n\nAOIN was enlisted.\n\n",
            "Press Links\n\n| Notch | LINKIN PARK |\n| :---- | :---- |\n"
        );

        let dir = std::env::temp_dir().join("aoin-copydoc-tables-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("copy.md");
        std::fs::write(&file, doc).unwrap();

        let services = vec!["Notch IMAG Design".to_string(), "Notch Content Design".to_string()];
        let (f, _blocks) = parse_with_services(&file, &services).unwrap();

        // Label paragraph + one-cell table = a field. None of this mapped before.
        assert_eq!(f.title.as_deref(), Some("LINKIN PARK"));
        assert_eq!(f.tour.as_deref(), Some("FROM ZERO TOUR"));
        assert_eq!(f.year.as_deref(), Some("2024"));
        assert_eq!(f.collaborator.as_deref(), Some("STURDY."));
        // The label carries a parenthetical, which must not stop it matching.
        assert_eq!(f.capabilities, vec!["REAL-TIME CONTENT".to_string()]);
        assert!(f.summary.as_deref().unwrap_or_default().starts_with("A dynamic"));

        // Google Docs joins services with plain spaces; the CMS list splits them.
        assert_eq!(f.services, vec!["Notch IMAG Design".to_string(), "Notch Content Design".to_string()]);

        // Stats: header row names them, the row beneath holds the values.
        assert_eq!(f.stats.len(), 2);
        assert_eq!(f.stats[0].label, "SHOWS");
        assert_eq!(f.stats[0].value, "80");

        // Credits become groups, with the export's backslash escapes undone and
        // a markdown link split into name + url.
        assert_eq!(f.credits.len(), 2);
        assert_eq!(f.credits[0].title, "ALL OF IT NOW");
        assert_eq!(f.credits[0].entries[0].title, "NOTCH DESIGNER");
        assert_eq!(f.credits[0].entries[0].name, "Berto Mora");
        assert_eq!(f.credits[0].entries[0].url, "https://insta.com/berto_mora/");
        assert_eq!(f.credits[1].title, "COLLABORATORS");
        assert_eq!(f.credits[1].entries[0].name, "Linkin Park");
        assert_eq!(f.credits[1].entries[0].url, "https://fromzero.linkinpark.com/");

        // The write-up runs to the end and keeps its sub-headings; a heading
        // used to end the section and truncate the copy.
        let paras: Vec<String> = std::iter::once(f.writeup.lead.clone())
            .chain(f.writeup.body.iter().cloned())
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(paras.len(), 3, "paras were {paras:?}");
        assert!(paras.iter().any(|p| p == "## AOIN Involvement"));
        assert!(paras.last().unwrap().starts_with("AOIN was enlisted"));
    }

    #[test]
    fn prose_lines_still_join_into_one_paragraph() {
        let mut out = Vec::new();
        lines_to_blocks("The brief was a stage\nthat reads as one instrument.", BlockType::P, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "The brief was a stage that reads as one instrument.");
    }

    #[test]
    fn sections_map_to_the_payload_shape() {
        let md = "# Peso Dinastia\n\nClient: Live Nation\nYear: 2026\nRole: Real-Time Content\nScope: LED / Playback\nCapabilities: Real-Time Content, Screens Production\n\n## Summary\n\nA touring LED package.\n\n## Write-up\n\nLead paragraph here.\n\nBody paragraph one.\n\n## Stats\n\nLED Surface: 1,240m2\nShows: 38\n\n## Credits\n\n### All Of It Now\n\nCreative Direction: @somebody\nPlayback: @another\n";
        let dir = std::env::temp_dir().join("aoin-copydoc-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("w.md");
        std::fs::write(&file, md).unwrap();

        let (f, _) = parse(&file).unwrap();
        assert_eq!(f.title.as_deref(), Some("PESO DINASTIA"));
        assert_eq!(f.slug.as_deref(), Some("peso-dinastia"));
        assert_eq!(f.year.as_deref(), Some("2026"));
        // Client, Role and Scope were removed from the Projects collection, so a
        // doc line for them is deliberately left unmapped rather than parsed into
        // a field that cannot be published.
        assert_eq!(f.client.as_deref(), None);
        assert_eq!(f.role.as_deref(), None);
        assert_eq!(f.scope.as_deref(), None);
        assert_eq!(f.capabilities.len(), 2);
        assert_eq!(f.summary.as_deref(), Some("A touring LED package."));
        assert_eq!(f.writeup.lead, "Lead paragraph here.");
        assert_eq!(f.writeup.body, vec!["Body paragraph one."]);
        assert_eq!(f.stats.len(), 2);
        assert_eq!(f.stats[0].label, "LED SURFACE");
        assert_eq!(f.credits.len(), 1);
        assert_eq!(f.credits[0].entries.len(), 2);
        assert!(validate(&f).ok);
    }
}
