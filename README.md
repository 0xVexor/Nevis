<div align="center">

<img src="spike/tiptap/src-tauri/icons/128x128.png" alt="Noviq" width="96" height="96">

# Noviq.

**A local-first notes workspace with first-class Persian and right-to-left support.**

Block editor · backlinks and graph · spaced-repetition flashcards · optional Google Drive sync · no server, no account.

[![Build installers](https://github.com/AliMirzad/noviq/actions/workflows/release.yml/badge.svg)](https://github.com/AliMirzad/noviq/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/AliMirzad/noviq?include_prereleases&label=release)](https://github.com/AliMirzad/noviq/releases)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-6c72ff)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)

[Download](https://github.com/AliMirzad/noviq/releases) · [Website](https://alimirzad.github.io/noviq/) · [Privacy](https://alimirzad.github.io/noviq/privacy.html) · [فارسی](README.fa.md)

<br>

<img src="docs/screenshots/editor.png" alt="Noviq editor with a Persian note, tags, status and the formatting toolbar" width="100%">

</div>

---

## Why Noviq

Most note apps treat right-to-left text as an afterthought: mixed Persian and English lines scramble punctuation, tables flip the wrong way, and code blocks inherit the wrong direction. Noviq was built the other way round. Direction is decided **per block**, mixed-language text renders correctly, and everything else (tables, lists, callouts, formulas, diagrams) follows.

Your notes are plain files in a folder you own. There is no Noviq server and no sign-up. If you want your notes on more than one machine, Noviq can sync that folder through your own Google Drive.

## Features

### Editor

- **Per-block text direction**: `/rtl`, `/ltr`, `/auto`, `Ctrl+Shift+←/→`, and the Word-style left/right `Ctrl+Shift` shortcut.
- **Rich blocks**: headings, lists, checklists, quotes, RTL tables, callouts, collapsible toggles, images, and horizontal rules.
- **Math**: inline and block formulas with KaTeX (`$x$`, `$$`).
- **Diagrams**: write [Mermaid](https://mermaid.js.org/) text and get a live diagram, with zoom/pan and one-click conversion back to code. Pasting Mermaid text is detected automatically.
- **Code blocks**: 24 languages with syntax highlighting, auto-detection, and sensible `Tab` / `Enter` indentation.
- **Markdown-native**: live shortcuts as you type, and raw Markdown paste.
- **Command menu** on `/` and `Ctrl+/` (also works on a Persian keyboard layout); with text selected it transforms the selection.
- **Page links** with `[[`, `@`, or `/link`, plus automatic **backlinks** on every page.
- **Find in page** (`Ctrl+F`) that understands Persian letter variants and ZWNJ.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/editor-blocks.png" alt="Code block, inline and block math, a Mermaid diagram, flashcard toggles and backlinks"></td>
<td width="50%"><img src="docs/screenshots/reader.png" alt="Reading mode showing a page like a sheet of paper"></td>
</tr>
<tr>
<td align="center"><sub>Code, KaTeX formulas, Mermaid diagrams, toggles and backlinks</sub></td>
<td align="center"><sub>Reading mode: distraction-free, adjustable text size and width, progress</sub></td>
</tr>
</table>

### Workspace

- **Pages, sub-pages and folders** with drag and drop, favorites, icons and gradient or image covers.
- **Tags and status** (to do / in progress / done) on every page, and a sortable, filterable **Pages table**.
- **Graph view** of how your pages link together, for the whole vault or around the current page.
- **Quick search and command palette** on `Ctrl+K`.
- **Templates**: lecture, chapter summary, exercise, meeting notes, to-do list.
- **Reading mode** (`Ctrl+.`): a read-only, paper-like view with outline and progress.
- **Print / PDF** with clean print styles.
- **Appearance**: light, dark or system theme, accent colors, backgrounds, editor fonts, and an English / Persian interface.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/graph.png" alt="Graph view of linked pages"></td>
<td width="50%"><img src="docs/screenshots/table.png" alt="Pages table with tags, status and word counts"></td>
</tr>
<tr>
<td align="center"><sub>Graph view</sub></td>
<td align="center"><sub>Pages table</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/search.png" alt="Quick search with highlighted matches"></td>
<td width="50%"><img src="docs/screenshots/templates.png" alt="Template gallery"></td>
</tr>
<tr>
<td align="center"><sub>Quick search (<code>Ctrl+K</code>)</sub></td>
<td align="center"><sub>Templates</sub></td>
</tr>
</table>

### Study

- **Flashcards from your notes**: every toggle block is a card (title is the question, content is the answer).
- **Spaced repetition** (SM-2 style) with *again / hard / good / easy* grading, per page or across the whole vault.

<img src="docs/screenshots/flashcards.png" alt="Flashcard review showing a question and the Show answer button" width="70%">

### Your data

- **Open files, not a database.** Pages are JSON, attachments are content-addressed files.
- **Version history**: up to 40 versions per page, with preview and restore.
- **30-day trash**; unreferenced images are cleaned up after a grace period.
- **Import** Markdown files and **Obsidian vaults** (folders, `[[links|alias]]`, `![[images]]`, `#tags`, front matter, callouts).
- **Export** to a zip (folder structure, `assets/`, front matter) or a JSON backup.

### Make it yours

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dark.png" alt="Dark theme"></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="Appearance settings with themes, accent colors and backgrounds"></td>
</tr>
<tr>
<td align="center"><sub>Dark theme</sub></td>
<td align="center"><sub>Themes, accent colors and backgrounds</sub></td>
</tr>
</table>

<img src="docs/screenshots/home.png" alt="Noviq home screen with recent pages, pinned pages and quick actions" width="100%">

## Download

Get the latest installer from the **[Releases](https://github.com/AliMirzad/noviq/releases)** page:

| Platform | File |
|---|---|
| Windows 10 / 11 | `.exe` (NSIS) or `.msi` |
| macOS (Intel and Apple Silicon) | `.dmg` (universal) |

> **First-run warnings.** Installers are not code-signed yet.
> On **Windows**, SmartScreen may show *Unknown publisher*: choose *More info → Run anyway*.
> On **macOS**, right-click the app and choose *Open* the first time.

## Google Drive sync

Sync is optional and works without any Noviq server.

1. Click the workspace card at the bottom of the sidebar to open **Workspaces**, then sign in with your Google account.
2. Noviq keeps your vault in step with a hidden app folder in *your* Google Drive.
3. Install Noviq on another computer, sign in, and the same vault appears.

What it can and cannot see:

- Noviq requests only the **`drive.appdata`** scope (plus your email address, to show which account is connected). It can reach its own hidden application folder and **nothing else** in your Drive.
- The sign-in token is stored in the operating system's credential store (Windows Credential Manager / macOS Keychain).
- Your notes travel directly between your device and Google. See the **[Privacy Policy](https://alimirzad.github.io/noviq/privacy.html)**.

Two devices editing the same page never silently lose work: the newer edit wins and the older one is kept in that page's history. Different pages never conflict.

## How your data is stored

A **vault** is an ordinary folder (default `Documents/Noviq`), the single source of truth. Everything else is derived and rebuildable.

```
MyVault/
  .noviq/vault.json            vault format version
  pages/<id>.json              one file per page or folder (TipTap document + metadata)
  files/ab/<sha256>            attachments, content-addressed (never conflict)
  history/<pageId>/<ts>.json   previous versions of a page (up to 40)
  kv/<key>.json                synced settings (e.g. flashcard schedule)
  .trash/                      deleted items, purged after 30 days
```

Design notes: file names are IDs, not titles, so renames and moves never create conflicts; every write is atomic (temp file → `fsync` → rename); one edit touches exactly one file. The reasoning is in [ADR-0003](docs/adr/0003-vault-and-sync.md).

## Built with

| | |
|---|---|
| Shell | [Tauri 2](https://tauri.app/) (Rust) |
| UI | React 19, TypeScript, Vite |
| Editor | [TipTap 3](https://tiptap.dev/) (ProseMirror) |
| Math / diagrams | KaTeX, Mermaid |
| Storage | Plain files in a vault folder; IndexedDB when run in a browser |
| Sync | Google Drive API (`appDataFolder`), OAuth 2.0 with PKCE |

## Build from source

**Prerequisites:** Node.js 22.18+, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Windows: Visual Studio Build Tools with *Desktop development with C++*; on macOS: Xcode Command Line Tools).

```bash
git clone https://github.com/AliMirzad/noviq.git
cd noviq/spike/tiptap
npm install
```

Run the desktop app in development:

```bash
npm run tauri dev
```

Or run just the web UI in a browser (uses IndexedDB and its own sample content):

```bash
npm run dev          # http://localhost:5173
```

Build installers for your platform (output in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

### Google Drive sync in your own build

The OAuth client belongs to the app, not to the user. Create a **Desktop app** OAuth client in Google Cloud (Drive API enabled, scope `drive.appdata`), then either:

- set `NOVIQ_GOOGLE_CLIENT_ID` and `NOVIQ_GOOGLE_CLIENT_SECRET` as environment variables at build time, or
- drop the downloaded JSON as `google-oauth.json` into the app-data folder.

Without credentials the app still works fully offline; only the sync button is unavailable.

### Tests

```bash
# Node 22.18+ (uses node:sqlite and runs TypeScript directly)
for t in schema crash zip detect srs mermaid-detect; do node db/test-$t.mjs; done
node db/check-i18n.mjs                         # t('…') strings missing a Persian translation
cd spike/tiptap/src-tauri && cargo test        # Rust: vault, index, sync
cd .. && npx tsc -b                            # type check
```

## Releasing

Installers for Windows and macOS are built by [GitHub Actions](.github/workflows/release.yml).

1. Bump `version` in `spike/tiptap/src-tauri/tauri.conf.json`, `Cargo.toml` and `package.json`.
2. Add the Google credentials as repository secrets `NOVIQ_GOOGLE_CLIENT_ID` and `NOVIQ_GOOGLE_CLIENT_SECRET`.
3. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. Review the draft release that the workflow creates, then publish it.

## Repository layout

| Path | Contents |
|---|---|
| `spike/tiptap/` | The app: React UI (`src/`) and the Tauri shell (`src-tauri/`) |
| `spike/tiptap/src-tauri/src/` | Rust: `vault`, `index`, `registry`, `legacy` migration, and `sync/` (Google auth and Drive) |
| `db/` | SQLite migrations, Persian normalization, and the Node test suite |
| `docs/` | Design docs, [architecture decision records](docs/adr/), and the project site |

## Roadmap

- Code-signed installers (Windows and macOS) and automatic updates
- Mobile apps (iOS / Android) on the same vault format
- Live collaboration through an optional server (the page format is already backend-independent; see ADR-0003)
- A local SQLite index for full-text search and backlinks on very large vaults

## Privacy

Noviq runs entirely on your computer. It has no analytics or telemetry and never sends your notes to us. The only network traffic is to Google, and only if you turn on sync. Full details: [Privacy Policy](https://alimirzad.github.io/noviq/privacy.html).

---

<div align="center">
<sub>Made by Vexor.</sub>
</div>
