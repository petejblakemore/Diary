// Diary: a sovereign, local-only journaling app.
//
// The backend owns every file and Git operation. The frontend can only touch
// the journal through the commands below, and every path is built here from a
// validated date or template name, so nothing can be written outside the
// journal folder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod import;
mod spelling;

use chrono::{Datelike, Local, NaiveDate};
use git2::{IndexAddOption, Repository, Signature};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const DEFAULT_DAY: &str = "# {{weekday}}, {{date}}\n\n## {{time}}\n\n";
const DEFAULT_ENTRY: &str = "## {{time}}\n\n";
const GITIGNORE: &str = "*.tmp\n.DS_Store\n";

static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

struct AppState {
    root: Mutex<Option<PathBuf>>,
}

/// App settings, stored in ~/Library/Application Support/com.pete.diary/,
/// never inside the journal folder.
#[derive(Serialize, Deserialize, Default)]
struct Config {
    journal: Option<PathBuf>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn stamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M").to_string()
}

// ---------- settings ----------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(err)?;
    fs::write(config_path(app)?, json).map_err(err)
}

// ---------- paths ----------

fn journal_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No journal folder selected".to_string())
}

fn parse_date(date: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| format!("Invalid date: {date}"))
}

/// /Diary/YYYY/YYYY-MM/
fn month_dir(root: &Path, year: i32, month: u32) -> PathBuf {
    root.join(format!("{year:04}")).join(format!("{year:04}-{month:02}"))
}

/// /Diary/YYYY/YYYY-MM/YYYY-MM-DD.md
fn entry_path(root: &Path, d: NaiveDate) -> PathBuf {
    month_dir(root, d.year(), d.month()).join(format!("{}.md", d.format("%Y-%m-%d")))
}

fn template_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ' ');
    if !ok {
        return Err("Template names may only use letters, numbers, spaces, - and _".into());
    }
    Ok(root.join("_templates").join(format!("{name}.md")))
}

/// Write via a temporary file and rename, so a crash mid-save can never leave
/// a half-written entry.
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

// ---------- git ----------

/// Stage everything (including deletions) and commit if anything changed.
/// Returns whether a commit was made.
fn commit_all(root: &Path, message: &str) -> Result<bool, String> {
    let repo = Repository::open(root).map_err(err)?;
    let mut index = repo.index().map_err(err)?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(err)?;
    index.update_all(["*"].iter(), None).map_err(err)?;
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(p) = &parent {
        if p.tree_id() == tree_id {
            return Ok(false);
        }
    }

    let tree = repo.find_tree(tree_id).map_err(err)?;
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Diary", "diary@localhost"))
        .map_err(err)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(err)?;
    Ok(true)
}

/// Make sure the folder is a usable journal: a Git repo with a .gitignore and
/// default templates. Also commits anything changed while the app was closed.
fn prepare_journal(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(err)?;
    let fresh = Repository::open(root).is_err();
    if fresh {
        Repository::init(root).map_err(err)?;
    }

    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, GITIGNORE).map_err(err)?;
    }

    let templates = root.join("_templates");
    fs::create_dir_all(&templates).map_err(err)?;
    for (name, content) in [("day.md", DEFAULT_DAY), ("entry.md", DEFAULT_ENTRY)] {
        let path = templates.join(name);
        if !path.exists() {
            fs::write(path, content).map_err(err)?;
        }
    }

    let message = if fresh {
        "Diary created".to_string()
    } else {
        format!("External changes – {}", stamp())
    };
    commit_all(root, &message)?;
    Ok(())
}

// ---------- commands ----------

#[tauri::command]
fn get_journal(state: State<'_, AppState>) -> Option<String> {
    state
        .root
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn choose_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Choose your diary folder".into()))
        .blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

#[tauri::command]
fn set_journal(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<String, String> {
    let root = PathBuf::from(path);
    prepare_journal(&root)?;
    save_config(&app, &Config { journal: Some(root.clone()) })?;
    allow_pictures(&app, &root);
    *state.root.lock().unwrap() = Some(root.clone());
    Ok(root.display().to_string())
}

/// Let the page display pictures from the diary folder, and nowhere else.
fn allow_pictures(app: &AppHandle, root: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(root, true);
}

/// Day numbers that have an entry. Reads only the one month folder.
#[tauri::command]
fn month_entries(state: State<'_, AppState>, year: i32, month: u32) -> Result<Vec<u32>, String> {
    let root = journal_root(&state)?;
    let mut days = Vec::new();
    let Ok(dir) = fs::read_dir(month_dir(&root, year, month)) else {
        return Ok(days);
    };
    for item in dir.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".md") {
            if let Ok(d) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") {
                if d.year() == year && d.month() == month {
                    days.push(d.day());
                }
            }
        }
    }
    days.sort_unstable();
    Ok(days)
}

#[tauri::command]
fn read_entry(state: State<'_, AppState>, date: String) -> Result<Option<String>, String> {
    let path = entry_path(&journal_root(&state)?, parse_date(&date)?);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(err)
}

#[tauri::command]
fn write_entry(state: State<'_, AppState>, date: String, content: String) -> Result<(), String> {
    let path = entry_path(&journal_root(&state)?, parse_date(&date)?);
    atomic_write(&path, &content)
}

#[tauri::command]
fn list_templates(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let dir = journal_root(&state)?.join("_templates");
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(err)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".md").map(str::to_string)
        })
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_template(state: State<'_, AppState>, name: String) -> Result<String, String> {
    fs::read_to_string(template_path(&journal_root(&state)?, &name)?).map_err(err)
}

#[tauri::command]
fn write_template(state: State<'_, AppState>, name: String, content: String) -> Result<(), String> {
    atomic_write(&template_path(&journal_root(&state)?, &name)?, &content)
}

#[tauri::command]
fn add_attachment(state: State<'_, AppState>, date: String, source: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err("Only files can be attached".into());
    }
    store_attachment(&journal_root(&state)?, parse_date(&date)?, &src)
}

/// Save attachment data sent straight from the page: pictures dragged from
/// Photos, pasted, or taken with an iPhone. The bytes travel as the raw
/// request body; the date and file name as headers.
#[tauri::command]
fn save_attachment_bytes(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file data".into());
    };
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(import::percent_decode)
    };
    let date = header("x-date").ok_or("Missing date")?;
    let name = header("x-name").unwrap_or_else(|| "attachment".into());
    store_attachment_bytes(&journal_root(&state)?, parse_date(&date)?, &name, bytes)
}

/// Copy a file into the day's media folder and return its link relative to
/// the entry, e.g. "2026-11-02/photo.jpg".
fn store_attachment(root: &Path, d: NaiveDate, src: &Path) -> Result<String, String> {
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".into());
    let bytes = fs::read(src).map_err(err)?;
    store_attachment_bytes(root, d, &name, &bytes)
}

/// Write attachment data into the day's media folder under a link-safe name.
/// An identical file already there is reused rather than written again.
fn store_attachment_bytes(root: &Path, d: NaiveDate, raw: &str, bytes: &[u8]) -> Result<String, String> {
    let date = d.format("%Y-%m-%d").to_string();
    // Keep names link-safe: no spaces or brackets in Markdown links.
    let clean: String = Path::new(raw)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".into())
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let clean = clean.trim_start_matches('.').to_string();
    let clean = if clean.is_empty() { "attachment".to_string() } else { clean };
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (clean.clone(), String::new()),
    };

    let dir = month_dir(root, d.year(), d.month()).join(&date);
    fs::create_dir_all(&dir).map_err(err)?;
    let mut name = clean.clone();
    let mut n = 1;
    while dir.join(&name).exists() {
        if fs::read(dir.join(&name)).ok().as_deref() == Some(bytes) {
            return Ok(format!("{date}/{name}"));
        }
        name = format!("{stem}-{n}{ext}");
        n += 1;
    }
    fs::write(dir.join(&name), bytes).map_err(err)?;
    Ok(format!("{date}/{name}"))
}

#[tauri::command]
fn commit(state: State<'_, AppState>, message: String) -> Result<bool, String> {
    commit_all(&journal_root(&state)?, &message)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    finish(&app);
}

// ---------- menu ----------

/// The menu bar. Every shortcut lives here rather than in the page, because
/// macOS catches some keys (such as ⌘.) before the page ever sees them. Each
/// custom item sends its id to the page as a "menu" event. Undo and Redo are
/// custom too, because the editor keeps its own history.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, key: Option<&str>| MenuItem::with_id(app, id, text, true, key);
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "Diary",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &item("folder", "Change Diary Folder…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("today", "Today", Some("CmdOrCtrl+T"))?,
            &sep()?,
            &item("import", "Import Old Entries…", None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &item("undo", "Undo", Some("CmdOrCtrl+Z"))?,
            &item("redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let format = Submenu::with_items(
        app,
        "Format",
        true,
        &[
            &item("h1", "Heading 1", Some("CmdOrCtrl+1"))?,
            &item("h2", "Heading 2", Some("CmdOrCtrl+2"))?,
            &item("h3", "Heading 3", Some("CmdOrCtrl+3"))?,
            &sep()?,
            &item("bold", "Bold", Some("CmdOrCtrl+B"))?,
            &item("italic", "Italic", Some("CmdOrCtrl+I"))?,
            &item("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("raw", "Raw Markdown", Some("CmdOrCtrl+Shift+R"))?,
            &item("zen", "Zen Mode", Some("CmdOrCtrl+."))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &format, &view, &window])
}

// ---------- quitting ----------

/// Ask the frontend to save, then quit. If it doesn't answer within three
/// seconds, commit what is on disk and quit anyway.
fn request_quit(app: &AppHandle) {
    if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    if app.emit("app-quit", ()).is_err() {
        finish(app);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        finish(&handle);
    });
}

/// Final commit, then exit. Safe to call more than once.
fn finish(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(root) = app.state::<AppState>().root.lock().unwrap().clone() {
        let _ = commit_all(&root, &stamp());
    }
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState { root: Mutex::new(None) })
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            if let Some(root) = load_config(app.handle()).journal {
                if root.is_dir() && prepare_journal(&root).is_ok() {
                    allow_pictures(app.handle(), &root);
                    *app.state::<AppState>().root.lock().unwrap() = Some(root);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref().to_string());
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_quit(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_journal,
            choose_folder,
            set_journal,
            month_entries,
            read_entry,
            write_entry,
            list_templates,
            read_template,
            write_template,
            add_attachment,
            save_attachment_bytes,
            import::scan_import,
            import::run_import,
            spelling::check_spelling,
            spelling::spelling_guesses,
            spelling::learn_word,
            commit,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Diary")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
        });
}
