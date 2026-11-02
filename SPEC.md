# Product Requirements Specification: Sovereign Journaling System (v4: "Diary")

## 1. Core Philosophy & Design Principles
*   **Absolute Data Sovereignty:** 100% local, zero external server or vendor dependencies.
*   **Immunity to SaaS Risks:** No proprietary formats, licensing servers or subscriptions.
*   **Minimalist Writing Focus:** Distraction-free, consistent typing environment for long-form prose.
*   **Editor Independence:** Every file stays readable and editable in any plain text editor.

## 2. Data Storage & Architecture
*   **File Format:** Plain Markdown (`.md`). No binary formats, databases or hidden metadata.
*   **Directory Structure:** `/Diary/YYYY/YYYY-MM/YYYY-MM-DD.md`.
*   **Anti-Lag:** No directory holds more than ~62 items.
*   **Data Isolation:** Attachments in a per-day folder beside the entry (`2026-11-02/`), linked relatively.
*   **Conflict Resilience:** Full ISO date in every filename; one file per day; extra sessions appended under `## HH:MM`.
*   **Safe Writes:** Write to a temporary file, then rename.

## 3. User Interface & Experience
*   **Zero Feature Bloat:** No plugins, kanban, graphs, canvas, tags, themes or sync.
*   **Typography:** Georgia 20px, line height 1.6, centred ~66ch column (≤80 characters). Light/dark follows the system.
*   **Styled Markdown Editing:** Headings and inline formatting display styled as you type; Markdown symbols remain in the text, faded. The text is the single source of truth.
*   **Formatting Toolbar:** H1, H2, H3, Bold, Strikethrough (Italic via menu). Each toggles on/off.
*   **Raw View:** Monospaced view of the exact file contents, editable.
*   **Spelling:** macOS system spell checker; wavy red underline drawn without altering the text; right-click for suggestions, Learn, Ignore. Links, paths, code and URLs excluded.
*   **Undo/Redo:** App-managed history, grouped roughly by word.
*   **Zen Mode:** Hides sidebar and toolbar. Exit via Esc, ⌘. or a fade-in Exit Zen button.
*   **Paste:** Plain text only.
*   **Autosave:** ~1.2s after typing stops; also on blur, navigation and quit.

## 4. Functional Requirements
*   **Today:** Creates folders and file from `day.md`, or appends `entry.md`; opens at the end. Opens on launch.
*   **Calendar:** Monday-first month grid; dots for entries; empty days open a draft written only on first keystroke.
*   **Templates:** Plain Markdown in `_templates/`; placeholders filled once at creation; future entries only.
*   **Attachments:** Drag-and-drop copies files into the day's media folder; identical files reused.
*   **Import:** Read-only import from Markdown folders with preview; dates from filename, folders, front-matter or (optionally) file date; templates skipped; attachments relinked; idempotent; one commit.
*   **Git:** Local repository; commits after 2 minutes idle, on quit, and on launch for external changes. Off-machine copy recommended.

## 5. Implementation
*   **App:** Native macOS app (`Diary.app`, `com.pete.diary`) built with Tauri 2; UI in plain HTML/CSS/JS (no frameworks, no build step); file, Git and spelling work in Rust.
*   **Self-Contained:** No network access. Bundled libgit2. Spelling via NSSpellChecker.
*   **Security:** The page has no direct filesystem access; every path is built in Rust from a validated date or template name.
*   **Menus:** Diary, File, Edit, Format, View, Window; all shortcuts registered in the menu bar.
*   **Minimum macOS:** 14.2 (needed for the spelling underline).
*   **Build:** `cargo tauri build`; ad-hoc signed for personal use.

## 6. Out of Scope
*   Built-in search (use Spotlight), tags, themes, plugins, cloud sync, accounts, analytics, rendered preview.

## 7. Project Layout
*   Code (`/Users/pete/Projects/Diary/`) and data (the diary folder) are separate, each with its own Git repository.
*   App settings in `~/Library/Application Support/com.pete.diary/`, never inside the diary folder.
