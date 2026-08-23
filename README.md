# AOIN — Page Composer

Bridges a project's **asset folder** and its **copy doc** into a finished
portfolio page on the AOIN site. Pick a project, build the carousel visually,
see the real page layout before you commit, then convert, rename and publish.

```bash
npm install
npm start
```

Then open <http://localhost:4545>. It reads the A: drive directly — nothing is
uploaded until you press Publish.

---

## The five steps

| | | |
|---|---|---|
| **01 Pick** | Lists every project under the roots in `config.json`, with still/video counts and whether a copy doc was found. |
| **02 Compose** | Contact sheet of every asset in the folder tree. Click a tile to add it to the carousel — it takes the next index, Instagram-style. Switch the mode chip to assign the **hero**. Arrange rows in the right rail; filenames rewrite live. |
| **03 Previz** | The real project-page grid, at the true columns and aspect ratios of each row's layout, so you can see which assets land full-width before publishing. |
| **04 Copy** | Parses a `.docx`/`.md` dropped in the project folder into the Payload fields, shown next to the source text so you can see what mapped where. Everything is editable. |
| **05 Export** | Converts and renames, then (separately) publishes to the CMS. |

## Naming

Outputs follow `project-name-tour_description##`:

```
peso-dinastia-dinastia-tour_hero.webp
peso-dinastia-dinastia-tour_thumb.webp
peso-dinastia-dinastia-tour_gallery01.webp
peso-dinastia-dinastia-tour_gallery04.mp4
```

The base (`project-name-tour`) is derived from the folder name plus the **Tour**
field, and is editable in the right rail — once you edit it, it stops
auto-updating. The `##` index is only appended when more than one asset shares a
description, so a lone hero stays `_hero.webp`.

## Gallery rows and layouts

The gallery is a list of **rows**, and each row picks one of the **five layouts
the CMS offers**. The rail stores exactly what Payload stores, so nothing is
translated at publish time:

```
gallery: [ { layout: "split-8-4", images: [{image}, {image}] }, ... ]
```

| Layout | Columns | Aspects |
|---|---|---|
| `full` | 12 | fixed band height |
| `two-up` | 6 + 6 | 4:3 |
| `split-8-4` | 8 + 4 | 16:9 + 1:1, second slot on the baseline |
| `split-5-7` | 5 + 7 | 4:3 + 16:9, second slot on the baseline |
| `three-up` | 4 + 4 + 4 | 4:3 |

Every layout fills all 12 columns, so a row can never be short. In the **Page
Order** rail:

- **Click tiles** and they pair up on their own, alternating `split-8-4` and
  `split-5-7` — the site's own rhythm — so clicking and publishing gives a
  sensible page with no dragging at all.
- **Drag a tile onto a row** to add it there; the row grows `full` -> `two-up` ->
  `three-up`. A rectangle previews which half it will take, and the half you drop
  on decides the order.
- **Drag the seam** to change the ratio. A free-form ratio has nowhere to go in
  the CMS, so it snaps to the layouts that exist: dragging right widens the left
  image 5 -> 6 -> 8 columns, i.e. `split-5-7`, `two-up`, `split-8-4`. The seam is
  drawn 7px wide but grabs from 5px either side.
- **Click a row's layout name** to cycle the layouts its image count allows.
- **Drop between rows** to move a tile without changing any arrangement.
- `three-up` is as wide as the CMS goes, so a fourth image dropped on one gets
  its own row rather than silently falling out of the arrangement.

> There is deliberately **no way to make an arbitrary ratio** such as 9/3. The
> site cannot render one, and Payload's select would reject it.

## What Compose writes

Converted files land **in the project folder**, next to the originals — not in a
parallel export tree. Originals are never modified or deleted.

- stills → `.webp`, quality 82, long edge capped at 2560
- thumb → `.webp`, quality 80, cropped to 1200×800
- video → `.mp4`, h264 CRF 23, width capped at 1920, `+faststart`, AAC 128k

Every run also writes `_compose-manifest.json` recording each source → output
mapping, so you can always trace a published file back to the frame it came
from. Recipes live in `config.json`.

Set a subfolder in the **writing into** field on step 05 if you'd rather keep
outputs separate (e.g. `06_Web`).

## Publishing

Publish is deliberately a second, separate button, and stays locked until the
compose run finishes cleanly and the required copy fields are filled. It then
uploads each composed file to Payload's media collection (reusing an existing
doc if the filename already exists), creates **or updates** the project by slug,
and lets Payload's own `afterChange` hook trigger the Astro rebuild.

### Signing in

Click **SIGN IN** in the top bar, or just press Publish — if you are not signed
in it raises the modal rather than failing. The password is checked against
Payload before anything is kept, so a typo is reported there and then.

By default the login lasts only as long as the app is running. Ticking
**remember my login on this device** writes it to `config.json`, in **plain
text** — the modal says so where you tick it. **SIGNED IN** in the top bar
doubles as sign-out, which forgets the password but keeps the address.

Environment variables still work and still win, for unattended runs:

```bash
set PAYLOAD_ADMIN_EMAIL=you@example.com
set PAYLOAD_ADMIN_PASSWORD=...
npm start
```

Credentials sourced from the environment are never written to `config.json`.

## What the CMS expects

Nothing needs deploying to `.245` for this — the layout model was already live
there. The composer simply matches the shipped `Projects` collection:

- **one `image`**, used as both the work-grid thumbnail and the project hero.
  There is no separate `hero`/`thumb` pair any more. Compose still writes a
  local `_thumb.webp` crop, it is just not uploaded into a field.
- `gallery` rows as above
- `writeup` is **Slate rich text** (`[{children:[{text}]}]`), not `[{paragraph}]`
- required: `title`, `slug`, `year`, `capabilities`, `image`
- `services` is a **relationship** to `service-categories` — see below
- **gone from the collection**, so the composer no longer sends or parses them:
  `client`, `role`, `scope`, `body`

### Capabilities vs services

Two different fields that are easy to confuse:

- **`capabilities`** — a fixed set of four. Indexing only: it drives the
  work-grid filters, tile tags and list chips. **Not shown on the project page.**
- **`services`** — an *editable* taxonomy (a relationship to
  `service-categories`), and the one that actually prints in the project page's
  meta block.

Because services are editable in the CMS, the composer fetches the list from
Payload rather than hard-coding it, and shows it as a filterable chip cloud on
step 04. It stores **labels**, not ids — they survive a doc being re-parsed and
read properly in the UI — and resolves them to relationship ids at publish,
matching case-insensitively.

A name the CMS has never heard of is **flagged and skipped, never created**:
auto-creating a category from a typo would quietly pollute a taxonomy the whole
site shares. Step 04 warns about unmatched names before you publish, and the
publish log repeats them.

To pick services up from a copy doc, add a line like:

```
Services: XR Integration, Media Server Operation
```

### The copy-doc format

AOIN's copy docs are built from **Google Docs tables**, not `Label: value`
lines. Exported to Markdown a field is a label paragraph followed by a one-cell
table, and that is what the parser reads:

```
Year

| 2024 |
| :---- |
```

- **Labels tolerate parentheticals and slashes** — `Capabilities (Services
  Rendered)` and `Artist Name/Project Title` both match.
- **Stats** are a multi-column table: the header row names them, the row beneath
  holds the values.
- **Team Credits** and **Collaborator Credits** become the `ALL OF IT NOW` and
  `COLLABORATORS` groups. A markdown link in the name column is split into the
  name and its URL, and Google Docs' backslash escapes (`berto\_mora`,
  `Notch \+ Embergen`) are undone.
- **Full Write Up** runs to the end of the doc, and `##` sub-headings inside it
  stay part of the write-up rather than ending it.
- **Press Links** has no field on the collection, so it stays deliberately
  unmapped rather than being forced somewhere.

Step 04 shows every source block beside what it mapped to, so anything the
parser got wrong is visible before you publish.

> **Services are the one ambiguous case.** The export joins them with plain
> spaces — `Notch IMAG Design Notch Content Design Interactive Content` — so
> there is no delimiter left to split on. They are matched longest-first against
> the CMS service list, and whatever cannot be matched is kept whole and flagged
> rather than guessed at. If a service is missing, add it in the CMS first.

### Formatting from the doc

Bold, italics, underline, links, headings, quotes and lists set in **Google Docs
survive** into the published write-up. Export the doc as `.docx` (or `.md` —
Google Docs exports that too) and drop it in the project folder.

The formatting is carried through as **Markdown**, which is what step 04's
write-up boxes show and what you edit. That choice buys three things: it stays
editable in a plain textarea, a `.md` export needs no conversion at all, and one
converter (Markdown → Slate) then serves both sources. At publish it becomes
Payload's Slate rich text.

The supported set is deliberately exactly what the site can render (see
`frontend/src/lib/richtext.ts`):

| Markdown | Renders as |
|---|---|
| `**bold**` | `<strong>` |
| `*italic*` or `_italic_` | `<em>` |
| `<u>underline</u>` | `<u>` (Markdown has no syntax for it) |
| `` `code` `` | `<code>` |
| `[text](url)` | `<a href>` |
| `# ` … `###### ` | `<h1>`–`<h6>` |
| `> quote` | `<blockquote>` |
| `- item` / `1. item` | `<ul>` / `<ol>` |

**Strikethrough is deliberately not supported.** Payload's editor offers it, but
the site's serializer ignores it, so parsing it would silently drop formatting
somebody could see in the CMS.

Note that mammoth discards underline by default — Word writers use it
inconsistently — so `copydoc.js` maps it back explicitly. The Rust backend
reads the OOXML runs directly and its test asserts the *same Markdown string*
from the same document, so the two backends cannot drift.

Run the composer's checks with:

```bash
node design/test-layouts.mjs
```

```bash
node design/test-attrs.mjs
```

```bash
node design/test-services.mjs
```

```bash
node design/test-richtext.mjs
```

```bash
node design/test-copydoc.mjs
```

`test-services` talks to the live CMS and skips itself if it cannot reach it.

> Before ever deploying anything to `.245`, diff against what is actually
> running there. The local `allofitnow-website` checkout has drifted more than a
> hundred commits behind `origin/integration` before now, and scp-ing from a
> stale tree would revert the live CMS schema.

## Asset roots (local drive or NAS)

A **root** is a folder that holds project folders. Click **ROOTS** in the top
bar to add, edit, remove or re-point them without touching a file or restarting.

Roots can be a local path, a mapped drive, or a **UNC share on the project NAS**:

```
\\nas01\projects\z-2026
```

Type or paste a path and press **Browse** to drill into it and pick the exact
folder. Each row shows `ONLINE` or `UNREACHABLE` live, and **Save and rescan**
rebuilds the project list immediately.

An unreachable root — NAS offline, VPN down, share not mounted — is **skipped,
not fatal**: the rest keep working and the picker shows a banner naming what is
missing. Roots stay in `config.json` while unreachable, so nothing is lost when
the share comes back.

> The root's **label** is part of every project's internal id, so renaming a
> label invalidates that project's saved selection. The path can change freely.

## Config

`config.json` (the ROOTS panel writes `roots` and the CMS url here):

- `roots` — project folders to scan, in order
- `port` — default 4545
- `recipe` — conversion settings above
- `ffmpeg` / `ffprobe` — explicit binary paths. Leave `null` to auto-detect.
  On this machine the chocolatey **shims** are blocked by Application Control,
  so detection deliberately probes the real binaries under
  `chocolatey/lib/ffmpeg-full/tools/...` before falling back to `PATH`.

## Desktop build (Tauri)

The same `web/` folder runs against two backends. `web/transport.js` is the only
file that knows which: it maps every call either to `fetch('/api/…')` or to a
Tauri `invoke('…')`, so the UI code is identical in both.

```bash
npm run desktop:dev     # run the desktop app
npm run desktop:build   # produce an installer (NSIS, per-user)
```

The Rust backend in `src-tauri/src/` mirrors `server/` module for module:

| Node | Rust | Notes |
|---|---|---|
| `scan.js` | `scan.rs` | `walkdir`; identical base64url project ids, so both backends accept the same ones |
| `thumbs.js` | `media.rs` | `image` crate; same 3-at-a-time gate and path+mtime cache key |
| `compose.js` | `compose.rs` | `webp` crate for stills, ffmpeg for video; same `_compose-manifest.json` |
| `copydoc.js` | `copydoc.rs` | reads OOXML directly instead of mammoth |
| `payload.js` | `payload.rs` | `reqwest` multipart |
| `ffmpeg.js` | `media.rs` | same real-binary-before-PATH probing |

What the desktop build adds: a **native folder picker** (network locations,
mapped drives, recent places) in place of the typed-path browser, drag-and-drop,
a desktop icon, and an installer.

Settings live in `%APPDATA%\com.allofitnow.pagecomposer\config.json` — the OS
app-config dir, not next to the binary, so an installed copy can write it. The
desktop build therefore starts with **no roots**: add them from the ROOTS panel,
where the button opens the real Windows folder dialog.

> **Building needs Smart App Control off.** It refuses to execute the build
> scripts cargo compiles (`os error 4551`, *"did not meet the Enterprise signing
> level requirements"*) regardless of where the target directory lives. Check
> with:
> ```
> (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy").VerifiedAndReputablePolicyState
> ```
> `0` means off and the build works; `1` means enforced and it will not. Turning
> it off is **irreversible** without reinstalling Windows.

### Debugging the desktop window

The window is a WebView2, so it can be driven the same way the browser build is:

```bash
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
npm run desktop:dev
node design/drive-tauri.mjs "(async()=>window.__TAURI__.core.invoke('get_status'))()"
```

## Notes

- Selections persist per project in `localStorage`, so closing the tab
  mid-compose loses nothing.
- Thumbnails cache to `.cache/` keyed by path + mtime, and generation is capped
  at 3 concurrent — a video poster means decoding a frame out of a file that can
  be tens of gigabytes.
- Nothing is hidden from the contact sheet, including `RAWs`. Use the folder and
  stills/video filters to narrow it.
