//! Markdown → Payload Slate, mirroring `server/richtext.js` node for node.
//!
//! The composer holds write-up paragraphs as Markdown, which is how formatting
//! survives from a Google Doc through step 04. Both backends therefore have to
//! turn that back into Slate at publish; if this one did not, the asterisks
//! would reach the site as literal text.
//!
//! The supported set is exactly what `frontend/src/lib/richtext.ts` renders.
//! Strikethrough is deliberately absent: the site's serializer ignores it.

use serde_json::{json, Value};

/// Inline Markdown → Slate leaves. Links become element nodes, everything else
/// is a leaf carrying marks.
pub fn inline_to_slate(md: &str) -> Vec<Value> {
    let chars: Vec<char> = md.chars().collect();
    let mut nodes: Vec<Value> = Vec::new();
    let mut text = String::new();

    fn push(nodes: &mut Vec<Value>, text: &mut String) {
        if !text.is_empty() {
            nodes.push(json!({ "text": text }));
            text.clear();
        }
    }

    /// Applies a mark to every leaf a nested parse produced.
    fn marked(inner: &str, marks: &[&str]) -> Vec<Value> {
        inline_to_slate(inner)
            .into_iter()
            .map(|mut leaf| {
                if let Some(obj) = leaf.as_object_mut() {
                    for m in marks {
                        obj.insert((*m).to_string(), json!(true));
                    }
                }
                leaf
            })
            .collect()
    }

    /// Index of `needle` in `chars` at or after `from`.
    fn find(chars: &[char], needle: &[char], from: usize) -> Option<usize> {
        if needle.is_empty() || chars.len() < needle.len() {
            return None;
        }
        (from..=chars.len() - needle.len()).find(|&i| &chars[i..i + needle.len()] == needle)
    }

    /// The same, ignoring ASCII case, for HTML tags that may be capitalised.
    fn find_ci(chars: &[char], needle: &[char], from: usize) -> Option<usize> {
        if needle.is_empty() || chars.len() < needle.len() {
            return None;
        }
        (from..=chars.len() - needle.len()).find(|&i| {
            chars[i..i + needle.len()]
                .iter()
                .zip(needle)
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
        })
    }

    let mut i = 0usize;
    while i < chars.len() {
        // A backslash escape keeps the next character literal.
        if chars[i] == '\\' && i + 1 < chars.len() {
            text.push(chars[i + 1]);
            i += 2;
            continue;
        }

        // [label](url)
        if chars[i] == '[' {
            if let Some(close) = find(&chars, &[']'], i + 1) {
                if close + 1 < chars.len() && chars[close + 1] == '(' {
                    if let Some(end) = find(&chars, &[')'], close + 2) {
                        push(&mut nodes, &mut text);
                        let label: String = chars[i + 1..close].iter().collect();
                        let url: String = chars[close + 2..end].iter().collect();
                        let mut kids = inline_to_slate(&label);
                        if kids.is_empty() {
                            kids.push(json!({ "text": "" }));
                        }
                        nodes.push(json!({ "type": "link", "url": url, "children": kids }));
                        i = end + 1;
                        continue;
                    }
                }
            }
        }

        // <u>underlined</u> — Markdown has no underline syntax.
        //
        // Matched over `chars`, never over bytes. `rest[..3]` panicked the whole
        // publish the moment byte 3 was not a character boundary, which one
        // curly apostrophe anywhere in the paragraph is enough to arrange —
        // "band’s" put a three-byte character straight after a one-byte one.
        // Rebuilding `rest` per character was also quadratic for no reason.
        if find_ci(&chars, &['<', 'u', '>'], i) == Some(i) {
            if let Some(close) = find_ci(&chars, &['<', '/', 'u', '>'], i + 3) {
                push(&mut nodes, &mut text);
                let inner: String = chars[i + 3..close].iter().collect();
                nodes.extend(marked(&inner, &["underline"]));
                i = close + 4;
                continue;
            }
        }

        // ***both*** must be tested before **bold**, which would otherwise close
        // on the wrong pair and leave a stray asterisk behind.
        if chars[i..].starts_with(&['*', '*', '*']) {
            if let Some(end) = find(&chars, &['*', '*', '*'], i + 3) {
                push(&mut nodes, &mut text);
                let inner: String = chars[i + 3..end].iter().collect();
                nodes.extend(marked(&inner, &["italic", "bold"]));
                i = end + 3;
                continue;
            }
        }

        if chars[i..].starts_with(&['*', '*']) {
            if let Some(end) = find(&chars, &['*', '*'], i + 2) {
                push(&mut nodes, &mut text);
                let inner: String = chars[i + 2..end].iter().collect();
                nodes.extend(marked(&inner, &["bold"]));
                i = end + 2;
                continue;
            }
        }

        if (chars[i] == '*' || chars[i] == '_') && chars.get(i + 1) != Some(&chars[i]) {
            if let Some(end) = find(&chars, &[chars[i]], i + 1) {
                push(&mut nodes, &mut text);
                let inner: String = chars[i + 1..end].iter().collect();
                nodes.extend(marked(&inner, &["italic"]));
                i = end + 1;
                continue;
            }
        }

        if chars[i] == '`' {
            if let Some(end) = find(&chars, &['`'], i + 1) {
                push(&mut nodes, &mut text);
                let inner: String = chars[i + 1..end].iter().collect();
                nodes.push(json!({ "text": inner, "code": true }));
                i = end + 1;
                continue;
            }
        }

        text.push(chars[i]);
        i += 1;
    }

    push(&mut nodes, &mut text);
    if nodes.is_empty() {
        nodes.push(json!({ "text": "" }));
    }
    nodes
}

fn strip_prefix_re(line: &str, bullet: bool) -> String {
    let t = line.trim_start();
    if bullet {
        return t.trim_start_matches(['-', '*']).trim().to_string();
    }
    // "1. " or "1) "
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    t[digits.len()..].trim_start_matches(['.', ')']).trim().to_string()
}

fn is_bullet(line: &str) -> bool {
    let t = line.trim_start();
    (t.starts_with("- ") || t.starts_with("* ")) && t.len() > 2
}

fn is_numbered(line: &str) -> bool {
    let t = line.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return false;
    }
    let after = &t[digits.len()..];
    after.starts_with(". ") || after.starts_with(") ")
}

/// One stored paragraph → one Slate block. A paragraph may itself hold a list,
/// because that is how a bulleted run out of a Word doc arrives.
fn block_to_slate(raw: &str) -> Option<Value> {
    let lines: Vec<&str> = raw
        .split('\n')
        .map(|l| l.trim_end())
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }

    if lines.iter().all(|l| is_bullet(l)) {
        let kids: Vec<Value> = lines
            .iter()
            .map(|l| json!({ "type": "li", "children": inline_to_slate(&strip_prefix_re(l, true)) }))
            .collect();
        return Some(json!({ "type": "ul", "children": kids }));
    }
    if lines.iter().all(|l| is_numbered(l)) {
        let kids: Vec<Value> = lines
            .iter()
            .map(|l| json!({ "type": "li", "children": inline_to_slate(&strip_prefix_re(l, false)) }))
            .collect();
        return Some(json!({ "type": "ol", "children": kids }));
    }

    let joined = lines.join(" ");

    // A heading that runs to a paragraph is not a heading.
    // 
    //    mammoth maps a Word/Docs HEADING STYLE to `## `, so a body paragraph that
    //    someone styled as Heading 2 in the doc arrives here indistinguishable from a
    //    real heading — and three published write-ups came out as nothing but
    //    headings because of it (Renée Rapp, Bad Omens, GRiZ).
    // 
    //    The two populations do not overlap. Measured on the live CMS: real headings
    //    run 16-20 characters ("AOIN Involvement", "Technical Challenges"); the
    //    mis-styled ones run 499-850. 120 sits between them with room either side.
    let hashes = joined.chars().take_while(|c| *c == '#').count();
    let marked = hashes >= 1 && hashes <= 6 && joined.chars().nth(hashes) == Some(' ');
    // The marker comes off either way — a demoted block must not publish with
    // its hashes showing, which would be worse than the heading it replaced.
    let body: String = if marked {
        joined.chars().skip(hashes + 1).collect::<String>().trim().to_string()
    } else {
        joined.clone()
    };
    if marked && body.chars().count() <= MAX_HEADING {
        return Some(json!({
            "type": format!("h{hashes}"),
            "children": inline_to_slate(&body),
        }));
    }

    if let Some(q) = body.strip_prefix("> ") {
        return Some(json!({ "type": "blockquote", "children": inline_to_slate(q) }));
    }

    // A block with no type is a paragraph, which is what Slate expects.
    Some(json!({ "children": inline_to_slate(&body) }))
}

/// The stored paragraph list → the Slate value Payload holds for `writeup`.
/// The longest a `## ` block may be and still be treated as a heading.
/// See the note in `block_to_slate`.
const MAX_HEADING: usize = 120;

pub fn paragraphs_to_slate(paragraphs: &[String]) -> Vec<Value> {
    paragraphs.iter().filter_map(|p| block_to_slate(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Publishing Linkin Park stopped dead here and the button sat on
    /// PUBLISHING forever. The write-up is ordinary prose - its only unusual
    /// feature is a curly apostrophe, and one of those was enough, because the
    /// underline probe sliced the remaining text by *byte* index. A panic inside
    /// a command never reaches the front end: the promise simply never settles,
    /// which is why it looked like a hang rather than an error.
    #[test]
    fn a_curly_apostrophe_does_not_take_the_publish_down() {
        // One ASCII byte then a three-byte character is the shape that breaks,
        // because byte 3 lands in the middle of the second character.
        let out = inline_to_slate("the band\u{2019}s redefined sound");
        assert_eq!(out, vec![json!({"text": "the band\u{2019}s redefined sound"})]);
        // The em dash and ellipsis the copy docs are full of, for the same reason.
        assert_eq!(inline_to_slate("a\u{2014}b"), vec![json!({"text": "a\u{2014}b"})]);
        assert_eq!(inline_to_slate("x\u{2026}"), vec![json!({"text": "x\u{2026}"})]);
        // Underline still has to work, including a capitalised tag.
        assert_eq!(
            inline_to_slate("a <U>b</U> c\u{2019}d"),
            vec![
                json!({"text": "a "}),
                json!({"text": "b", "underline": true}),
                json!({"text": " c\u{2019}d"}),
            ]
        );
    }

    /// The exact write-up that hung, straight out of the copy doc.
    #[test]
    fn the_linkin_park_writeup_converts() {
        let paragraphs: Vec<String> = vec![
            "The *From Zero* tour was crafted in three distinct phases: the *Launch and Livestream Event*, the *Arena Tour*, and the *Stadium Tour*. Each phase builds upon the previous, culminating in an expansive, visually stunning experience that captures the band\u{2019}s redefined sound and vision.".into(),
            "## AOIN Involvement".into(),
            "Another technical feat was integrating live data from Joe Hahn\u{2019}s DJ Pioneer CDJ controller to control Notch effects in real-time.".into(),
        ];
        let out = paragraphs_to_slate(&paragraphs);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["type"], "h2");
        // The italics survived rather than reaching the site as literal asterisks.
        assert_eq!(out[0]["children"][1], json!({"text": "From Zero", "italic": true}));
    }

    /// mammoth turns a Word paragraph STYLED as Heading 2 into "## <paragraph>",
    /// which is how three published write-ups came out as nothing but headings.
    /// Real headings and mis-styled paragraphs do not overlap in length: on the
    /// live CMS the real ones run 16-20 characters and the broken ones 499-850.
    #[test]
    fn a_paragraph_styled_as_a_heading_is_still_a_paragraph() {
        let real = paragraphs_to_slate(&["## AOIN Involvement".to_string()]);
        assert_eq!(real[0]["type"], "h2");

        // The opening of the Renée Rapp write-up, as mammoth delivered it.
        let long = format!("## {}", "For Renee Rapp's Bite Me Tour, All Of It Now worked alongside our client to develop the creative and technical approach for a show built almost entirely around real-time Notch camera content.");
        let out = paragraphs_to_slate(&[long]);
        assert!(out[0].get("type").is_none(), "a 190-character heading is a paragraph");
        // ...and the hashes must not survive into the text.
        let text = out[0]["children"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("For Renee Rapp"), "got {text}");
    }

    #[test]
    fn the_heading_cutoff_is_where_it_says_it_is() {
        let at = format!("## {}", "x".repeat(MAX_HEADING));
        assert_eq!(paragraphs_to_slate(&[at])[0]["type"], "h2");
        let over = format!("## {}", "x".repeat(MAX_HEADING + 1));
        assert!(paragraphs_to_slate(&[over])[0].get("type").is_none());
    }

    #[test]
    fn marks_match_the_js_implementation() {
        assert_eq!(inline_to_slate("hello"), vec![json!({"text": "hello"})]);
        assert_eq!(
            inline_to_slate("a **b** c"),
            vec![json!({"text": "a "}), json!({"text": "b", "bold": true}), json!({"text": " c"})]
        );
        assert_eq!(inline_to_slate("_b_"), vec![json!({"text": "b", "italic": true})]);
        assert_eq!(
            inline_to_slate("***x***"),
            vec![json!({"text": "x", "italic": true, "bold": true})]
        );
        assert_eq!(inline_to_slate("<u>u</u>"), vec![json!({"text": "u", "underline": true})]);
        assert_eq!(inline_to_slate("`c`"), vec![json!({"text": "c", "code": true})]);
    }

    #[test]
    fn links_become_elements() {
        assert_eq!(
            inline_to_slate("[AOIN](https://aoin.com)"),
            vec![json!({"type": "link", "url": "https://aoin.com", "children": [{"text": "AOIN"}]})]
        );
    }

    #[test]
    fn a_stray_marker_stays_literal() {
        // "2 * 3" must not swallow the rest of the paragraph looking for a pair.
        assert_eq!(inline_to_slate("2 * 3"), vec![json!({"text": "2 * 3"})]);
        assert_eq!(inline_to_slate("2 \\* 3"), vec![json!({"text": "2 * 3"})]);
    }

    #[test]
    fn blocks_carry_their_type() {
        assert_eq!(
            paragraphs_to_slate(&["## The Build".to_string()]),
            vec![json!({"type": "h2", "children": [{"text": "The Build"}]})]
        );
        assert_eq!(
            paragraphs_to_slate(&["- one\n- two".to_string()]),
            vec![json!({"type": "ul", "children": [
                {"type": "li", "children": [{"text": "one"}]},
                {"type": "li", "children": [{"text": "two"}]}
            ]})]
        );
        assert_eq!(
            paragraphs_to_slate(&["1. one\n2. two".to_string()]),
            vec![json!({"type": "ol", "children": [
                {"type": "li", "children": [{"text": "one"}]},
                {"type": "li", "children": [{"text": "two"}]}
            ]})]
        );
        assert_eq!(
            paragraphs_to_slate(&["> quoted".to_string()]),
            vec![json!({"type": "blockquote", "children": [{"text": "quoted"}]})]
        );
        // A plain paragraph carries no type at all.
        assert_eq!(
            paragraphs_to_slate(&["prose".to_string()]),
            vec![json!({"children": [{"text": "prose"}]})]
        );
    }

    #[test]
    fn empty_paragraphs_are_dropped() {
        assert_eq!(paragraphs_to_slate(&["".to_string(), "   ".to_string()]), Vec::<Value>::new());
    }
}

// ---------------------------------------------------------------------------
// Slate -> Markdown. The inverse of paragraphs_to_slate/inline_to_slate above,
// used when a project is opened FROM the CMS rather than built from a copy doc:
// the stored `writeup` has to come back as the plain paragraph list step 04
// edits. Kept in step with slateToParagraphs in server/richtext.js.
//
// It is not a general Slate renderer. It inverts exactly the shapes
// block_to_slate can produce and COUNTS anything else as dropped rather than
// guessing -- in practice `upload` nodes, the inline images and clips an editor
// dropped into the prose, which no paragraph of text can represent.
// ---------------------------------------------------------------------------

/// Characters that would otherwise be read back as markup.
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

/// One run of inline leaves/elements back to Markdown.
fn inline_to_markdown(nodes: Option<&Vec<Value>>) -> String {
    let Some(nodes) = nodes else { return String::new() };
    let mut out = String::new();
    for n in nodes {
        if n["type"].as_str() == Some("link") {
            let inner = inline_to_markdown(n["children"].as_array());
            out.push_str(&format!("[{}]({})", inner, n["url"].as_str().unwrap_or_default()));
            continue;
        }
        let text = n["text"].as_str().unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let mut t = escape_md(text);
        let bold = n["bold"].as_bool().unwrap_or(false);
        let italic = n["italic"].as_bool().unwrap_or(false);
        // Order mirrors the parser: the both-marks case is written `***x***`,
        // which inline_to_slate tests before `**`.
        if bold && italic {
            t = format!("***{t}***");
        } else if bold {
            t = format!("**{t}**");
        } else if italic {
            t = format!("*{t}*");
        }
        if n["underline"].as_bool().unwrap_or(false) {
            t = format!("<u>{t}</u>");
        }
        if n["code"].as_bool().unwrap_or(false) {
            t = format!("`{t}`");
        }
        out.push_str(&t);
    }
    out
}

/// A `ul`/`ol` back to one marker-prefixed line per item.
fn list_to_markdown(node: &Value) -> String {
    let ordered = node["type"].as_str() == Some("ol");
    node["children"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(i, li)| {
                    let marker = if ordered { format!("{}.", i + 1) } else { "-".to_string() };
                    format!("{} {}", marker, inline_to_markdown(li["children"].as_array()))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// The CMS `writeup` value -> (paragraphs, dropped).
///
/// `dropped` counts blocks that cannot survive the trip. The caller keeps the
/// original Slate and only sends the converted paragraphs when the operator has
/// actually edited them, so those blocks are not silently deleted.
pub fn slate_to_paragraphs(value: &Value) -> (Vec<String>, usize) {
    let mut paragraphs = Vec::new();
    let mut dropped = 0usize;
    let Some(nodes) = value.as_array() else { return (paragraphs, dropped) };
    for node in nodes {
        if !node.is_object() {
            continue;
        }
        let ty = node["type"].as_str();
        match ty {
            Some("ul") | Some("ol") => {
                let t = list_to_markdown(node);
                if !t.trim().is_empty() {
                    paragraphs.push(t);
                }
            }
            Some("blockquote") => {
                let t = inline_to_markdown(node["children"].as_array());
                if !t.trim().is_empty() {
                    paragraphs.push(format!("> {}", t.trim()));
                }
            }
            Some("upload") => dropped += 1,
            Some(h) if h.len() == 2 && h.starts_with('h') && h[1..].chars().all(|c| c.is_ascii_digit()) => {
                let level: usize = h[1..].parse().unwrap_or(2);
                let t = inline_to_markdown(node["children"].as_array());
                if !t.trim().is_empty() {
                    paragraphs.push(format!("{} {}", "#".repeat(level), t.trim()));
                }
            }
            // An explicitly typed paragraph is still a paragraph -- without this it
            // would fall to the catch-all and be counted as dropped, unlike the JS
            // side, which tests `type !== 'paragraph'` before dropping.
            Some(_) if ty != Some("paragraph") => dropped += 1,
            _ => {
                let t = inline_to_markdown(node["children"].as_array());
                if !t.trim().is_empty() {
                    paragraphs.push(t);
                }
            }
        }
    }
    (paragraphs, dropped)
}

#[cfg(test)]
mod slate_to_paragraphs_tests {
    use super::*;

    /// paragraphs_to_slate -> slate_to_paragraphs must be the identity for every
    /// shape block_to_slate can produce. These are the same cases the JS side is
    /// checked against in server/richtext.js, so the two stay in step.
    fn round_trip(src: &str) -> (String, usize) {
        let slate = paragraphs_to_slate(&[src.to_string()]);
        let (paras, dropped) = slate_to_paragraphs(&Value::Array(slate));
        (paras.first().cloned().unwrap_or_default(), dropped)
    }

    #[test]
    fn round_trips_every_supported_shape() {
        for src in [
            "A plain paragraph of prose.",
            "Some **bold** and *italic* and ***both*** together.",
            "A [link to somewhere](https://example.com) inline.",
            "## AOIN Involvement",
            "> A pulled quote.",
            "- one\n- two\n- three",
            "1. first\n2. second",
            "Underlined <u>text</u> here.",
        ] {
            let (out, dropped) = round_trip(src);
            assert_eq!(out, src, "round trip changed the block");
            assert_eq!(dropped, 0, "nothing should be dropped for {src:?}");
        }
    }

    /// An `upload` node is the one shape text cannot hold. It must be COUNTED,
    /// never silently discarded -- that count is what stops the composer from
    /// converting a write-up and deleting its inline media.
    #[test]
    fn counts_upload_nodes_rather_than_dropping_them_silently() {
        let value = json!([
            { "children": [{ "text": "before" }] },
            { "type": "upload", "value": { "id": "x" }, "children": [{ "text": "" }] },
            { "children": [{ "text": "after" }] }
        ]);
        let (paras, dropped) = slate_to_paragraphs(&value);
        assert_eq!(paras, vec!["before".to_string(), "after".to_string()]);
        assert_eq!(dropped, 1);
    }

    /// An explicitly typed paragraph is still a paragraph. Without the guard for
    /// this it falls to the catch-all and is reported as dropped media, which
    /// would make the composer warn about losing something that is only text.
    #[test]
    fn explicit_paragraph_type_is_not_counted_as_dropped() {
        let value = json!([{ "type": "paragraph", "children": [{ "text": "hello" }] }]);
        let (paras, dropped) = slate_to_paragraphs(&value);
        assert_eq!(paras, vec!["hello".to_string()]);
        assert_eq!(dropped, 0);
    }

    /// An empty rich-text field is stored as ONE BLANK paragraph, not an empty
    /// array. Most live projects are in that state, so this must come back empty
    /// or every one of them advertises a write-up it does not have.
    #[test]
    fn blank_paragraph_yields_nothing() {
        let value = json!([{ "children": [{ "text": "" }] }]);
        let (paras, dropped) = slate_to_paragraphs(&value);
        assert!(paras.is_empty());
        assert_eq!(dropped, 0);
    }
}
