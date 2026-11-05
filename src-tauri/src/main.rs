// Diary: a sovereign, local-only journaling app.
//
// The backend owns every file and Git operation. The frontend can only touch
// the journal through the commands below, and every path is built here from a
// validated date or template name, so nothing can be written outside the
// journal folder.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod import;
mod weather;

use chrono::{Datelike, Local, NaiveDate};
use git2::{IndexAddOption, Repository, Signature};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
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
    #[serde(default)]
    weather_location: Option<String>,
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
    let mut config = load_config(&app);
    config.journal = Some(root.clone());
    save_config(&app, &config)?;
    *state.root.lock().unwrap() = Some(root.clone());
    Ok(root.display().to_string())
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

/// Copy a file into the day's media folder and return its link relative to
/// the entry, e.g. "2026-11-02/photo.jpg". An identical file already there is
/// reused rather than copied again.
fn store_attachment(root: &Path, d: NaiveDate, src: &Path) -> Result<String, String> {
    let date = d.format("%Y-%m-%d").to_string();
    let raw = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".into());
    // Keep names link-safe: no spaces or brackets in Markdown links.
    let clean: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (clean.clone(), String::new()),
    };

    let dir = month_dir(root, d.year(), d.month()).join(&date);
    fs::create_dir_all(&dir).map_err(err)?;
    let mut name = clean.clone();
    let mut n = 1;
    while dir.join(&name).exists() {
        if same_contents(src, &dir.join(&name)) {
            return Ok(format!("{date}/{name}"));
        }
        name = format!("{stem}-{n}{ext}");
        n += 1;
    }
    fs::copy(src, dir.join(&name)).map_err(err)?;
    Ok(format!("{date}/{name}"))
}

fn same_contents(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => fs::read(a).ok() == fs::read(b).ok(),
        _ => false,
    }
}

#[tauri::command]
fn get_weather_location(app: AppHandle) -> Option<String> {
    load_config(&app).weather_location
}

#[tauri::command]
fn set_weather_location(app: AppHandle, location: String) -> Result<Option<String>, String> {
    let location = weather::clean_location(&location)?;
    let mut config = load_config(&app);
    config.weather_location = location.clone();
    save_config(&app, &config)?;
    Ok(location)
}

/// Moon phase and (if a location is set) weather, for today only.
#[tauri::command]
async fn day_extras(app: AppHandle, date: String) -> Result<weather::Extras, String> {
    let day = parse_date(&date)?;
    if day != Local::now().date_naive() {
        return Ok(weather::Extras::default());
    }
    let location = load_config(&app).weather_location;
    tauri::async_runtime::spawn_blocking(move || weather::extras(day, location.as_deref()))
        .await
        .map_err(err)
}

#[tauri::command]
fn commit(state: State<'_, AppState>, message: String) -> Result<bool, String> {
    commit_all(&journal_root(&state)?, &message)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    finish(&app);
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
            if let Some(root) = load_config(app.handle()).journal {
                if root.is_dir() && prepare_journal(&root).is_ok() {
                    *app.state::<AppState>().root.lock().unwrap() = Some(root);
                }
            }
            Ok(())
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
            import::scan_import,
            import::run_import,
            get_weather_location,
            set_weather_location,
            day_extras,
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
