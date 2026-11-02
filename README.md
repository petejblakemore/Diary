# Diary

A sovereign, local-only diary for macOS. Plain Markdown files in dated
folders, a full Git history, nothing ever leaves the Mac.

## Build (one-time, and again after code changes)

```
cd /Users/pete/Projects/Diary
cargo tauri icon app-icon.svg
cargo tauri build
```

Then drag `src-tauri/target/release/bundle/macos/Diary.app` into
`/Applications`. Requires Apple's build tools (`xcode-select --install`),
Rust (rustup.rs) and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`).
The finished app needs none of these. `cargo tauri dev` runs it without installing.

## Using it

| Action | How |
| --- | --- |
| Today's entry | **Today** or ⌘T. Adds a `## HH:MM` heading if today already has an entry |
| Another template | Hold ⌥ when clicking Today or an empty calendar day |
| Past days | Click the calendar (dot = entry, ring = today) |
| Headings | H1 / H2 / H3 in the toolbar, or ⌘1 ⌘2 ⌘3. Click again to remove |
| Bold / Italic / Strikethrough | **B** / **S** in the toolbar, or ⌘B ⌘I ⇧⌘X. Click again to remove |
| Raw Markdown | **Raw** or ⇧⌘R. Shows and edits the exact file contents |
| Zen mode | ⌘. or **Zen**. Leave with Esc, ⌘. or the Exit Zen button (move the mouse) |
| Spelling | Wavy red underline; right-click for suggestions, Learn Spelling or Ignore |
| Attach a file or picture | Drag it in (from Finder, Photos, anywhere) or paste it. It's saved in that day's folder and pictures show in the entry |
| Photo from iPhone | Right-click in the entry → Import from iPhone → Take Photo |
| Import old entries | File → Import Old Entries… or the sidebar link |
| Change diary folder | ⌘, |

Autosave runs about a second after you stop typing. Git snapshots are taken
after two quiet minutes, on quit, and on launch if files changed outside the app.

## Templates

Plain `.md` files in `<diary>/_templates/`: `day.md` for a new day,
`entry.md` for another session on the same day, plus any extras. Placeholders
`{{date}}` `{{weekday}}` `{{time}}` `{{year}}` `{{month}}` are filled in once,
when an entry is created. Templates never change existing entries.

## Importing

Reads any folder of Markdown files (e.g. an Obsidian vault) without changing
it. Dates come from filenames (`2024-03-05`, `20240305`, `05-03-2024` as
day-month-year, `5 March 2024`), dated folders, or a `date:`/`created:`
front-matter line. Linked files and `![[embeds]]` are copied into the day's
media folder. Template files and hidden folders are skipped. Re-importing
never duplicates. One Git snapshot per import.

## Where things are

```
/Users/pete/Projects/Diary/                   this source code
/Applications/Diary.app                       the installed app
~/Diary/  (or wherever you chose)             your writing, its own Git repo
  _templates/
  2026/2026-11/2026-11-02.md
  2026/2026-11/2026-11-02/                    that day's attachments
~/Library/Application Support/com.pete.diary/ app settings only
```

## Off-machine backup

Git history lives on the same disk as the diary. Keep a second copy you
control, such as Time Machine, or a Git remote on an external drive:

```
cd ~/Diary
git remote add usb /Volumes/Backup/Diary.git   # after `git init --bare` there
git push usb HEAD
```
