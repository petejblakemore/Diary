# Notes for whoever picks this up next

A handover note for coming back to Diary later. It covers what matters, what
was decided and why, and what bit us along the way. Read SPEC.md for *what*
the app does; this file is about *how to work on it safely*.

## The one rule

**The user's diary files are sacred.** Plain Markdown, exactly as typed.
Nothing the app does may add hidden metadata, rewrite old entries, or put
anything in the diary folder except entries, attachments, `_templates/`,
`.gitignore` and `.git/`. Every feature so far has been designed around this:

- The styled editor keeps all Markdown symbols in the text (faded, not hidden).
- Spelling underlines and picture previews are drawn *over* or *beside* the
  text and never become part of it.
- Templates apply to future entries only. The user confirmed this explicitly.
- Import only ever reads the old folder; re-importing never duplicates.

If a change would bend this rule, ask first.

## Working with Pete

- UK English, UK dates (`05-03-2024` = 5 March).
- Asks for suggestions before building ("do not build, just suggest"). Respect
  that: propose, then build when asked.
- Strongly anti-bloat. Every addition so far was requested; don't add features
  speculatively. Plugins, tags, themes, sync and search are deliberately out.
- Builds in Terminal from `/Users/pete/Projects/Diary` with `cargo tauri build`,
  then drags `Diary.app` into Applications.
- **Send individual files, never whole folders.** Copying a folder in Finder
  and choosing "Replace" deleted `src-tauri/src/` once. If a full set is needed,
  send a complete project folder and have them swap it in, as was done at 14:12
  on 2 Nov 2026.
- The assistant could not compile, run or write into `~/Projects` from its
  sandbox. Everything was written blind and tested by Pete. Say so honestly
  when handing over code, and name the parts most likely to fail.

## Layout

```
/Users/pete/Projects/Diary/        this code (own Git repo)
  src/                             the page: plain HTML/CSS/JS, no build step
    editor.js                      the styled Markdown editor (see below)
    main.js                        calendar, templates, saving, import UI, menus
    index.html, style.css
  src-tauri/                       the native app (Rust)
    src/main.rs                    files, Git, menus, quitting, attachments
    src/import.rs                  importing old Markdown folders
    src/spelling.rs                macOS NSSpellChecker bridge
    tauri.conf.json, Info.plist, capabilities/default.json, Cargo.toml
  app-icon.svg                     run `cargo tauri icon app-icon.svg` once
```

There are **two `src` folders**: `src/` (page) and `src-tauri/src/` (Rust).
This caused confusion more than once; always give full paths.

The diary itself lives wherever Pete chose (suggested `~/Diary`), as
`YYYY/YYYY-MM/YYYY-MM-DD.md` with attachments in `YYYY/YYYY-MM/YYYY-MM-DD/`.
App settings are in `~/Library/Application Support/com.pete.diary/`.

## How the editor works (read before touching editor.js)

- `text` is the single source of truth. The page is redrawn from it.
- Every edit is caught in `beforeinput`, applied to `text`, then only changed
  lines are redrawn. Offsets map between page and text via `toOffset` and
  `fromOffset`.
- Composition (accents, dictation) is let through natively, then `resync()`
  reads the text back from the page.
- Undo/redo is the app's own (grouped about a word at a time), triggered from
  custom Edit menu items in main.rs. Native undo can't work because redrawing
  replaces the page content.
- Paste and copy are plain text only. Pasted or dropped pictures go to
  `onFiles` and are saved as attachments.
- Spelling is checked in Rust (`check_spelling`) and drawn with the CSS Custom
  Highlight API, because the browser's own squiggles vanish on every redraw.
  This needs macOS 14.2+, the minimum set in tauri.conf.json.
- Picture previews are `<img contenteditable=false>` inside the line; they have
  no text, so they never reach the file.

## Things that bit us (and the fixes)

| Problem | Cause | Fix |
| --- | --- | --- |
| Name clash | Apple ships a "Journal" app | Renamed to Diary, ID `com.pete.diary` |
| Build: missing `icons/32x32.png` | Icon step not run | `cargo tauri icon app-icon.svg` first |
| Build: "no targets specified" | Folder replace wiped `src-tauri/src/` | Sent a complete project folder |
| Couldn't open folder in Documents | macOS privacy protection | Usage strings in Info.plist; suggested `~/Diary` instead |
| No way out of Zen | macOS swallows ⌘. before the page | All shortcuts moved to the menu bar; Esc and an Exit Zen button added |
| Template text in an entry | Probably the importer picking up `_templates/day.md` and dating it by file date | Importer skips `_templates/` and any file with `{{…}}` or `<% %>` |
| Undo broken | Huge undo steps, and ⌘Z firing twice | Word-sized steps; repeats within 80ms ignored |
| No spelling squiggles | Redrawing lines wiped native marks | macOS spell checker via Rust, drawn with Highlight API |
| Pictures from Photos/iPhone ignored | They arrive as data, not files; Tauri's native drop only gave file paths | `dragDropEnabled: false`, HTML drop/paste, bytes sent to `save_attachment_bytes` |

## Known soft spots

- **Quit handling** (`request_quit`/`finish` in main.rs): saves, commits, then
  exits, with a 3-second fallback. If ⌘Q ever skips the final commit, the next
  launch commits it as "External changes", so nothing is lost.
- **Every change after a rebuild may re-trigger macOS permission prompts.** The
  app is ad-hoc signed, so its signature changes with each build.
  `tccutil reset SystemPolicyDocumentsFolder com.pete.diary` clears a stuck one.
- **Imported front-matter is kept verbatim.** Pete was offered automatic
  stripping and hasn't answered yet.
- **Lists don't auto-continue on Return.** That hasn't been asked for.
- **Library versions:** Tauri 2, git2 0.20 (vendored, no network features),
  objc2 0.6 / objc2-foundation 0.3. `spelling.rs` is the file most sensitive to
  version changes.

## Before changing anything

1. Re-read the relevant file. Don't rely on memory of it.
2. Check SPEC.md still matches what you're about to do, and update it after.
3. Tell Pete exactly which files changed and where each one goes.
4. Remind them to commit the working code before a big change:
   `git add . && git commit -m "…"` in `/Users/pete/Projects/Diary`.
