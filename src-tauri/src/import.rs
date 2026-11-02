// Importing old entries from a folder of Markdown files, such as an Obsidian
// vault. The source folder is only ever read: notes and attachments are
// copied, never moved or changed.

use crate::{atomic_write, commit_all, entry_path, err, journal_root, store_attachment, AppState};
use chrono::{DateTime, Local, NaiveDate};
use regex::{Captures, Regex};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::State;
use walkdir::{DirEntry, WalkDir};

const MONTHS: &str = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

// 2024-03-05, 2024_03_05, 2024.03.05, 20240305
static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\D)((?:19|20)\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})(?:\D|$)").unwrap()
});
// 05-03-2024 (read as day-month-year, the UK way)
static UK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\D)(\d{1,2})[-_.](\d{1,2})[-_.]((?:19|20)\d{2})(?:\D|$)").unwrap()
});
// 5 March 2024, Tuesday 5th Mar 2024
static WORDY_DMY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTHS})[a-z]*\.?,?\s+((?:19|20)\d{{2}})\b")).unwrap()
});
// March 5, 2024
static WORDY_MDY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)\b({MONTHS})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{{2}})\b")).unwrap()
});
// Template placeholders: Diary's and Obsidian's {{date}} style, Templater's <% %>.
static TEMPLATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{\s*(date|time|title|weekday|year|month)\b|<%").unwrap()
});
// Obsidian embeds: ![[photo.png]], ![[photo.png|300]]
static EMBED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]").unwrap());
// Markdown links and images: [text](path), ![alt](path), ![alt](<path with spaces>)
static MD_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)"#).unwrap()
});
static IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g|gif|webp|heic|tiff?|svg)$").unwrap());

#[derive(Serialize, Clone)]
pub struct Note {
    rel: String,
    date: Option<String>,
    file_date: Option<String>,
}

#[derive(Serialize)]
pub struct Plan {
    folder: String,
    total: usize,
    dated: usize,
    templates: usize,
    first: Option<String>,
    last: Option<String>,
    undated: Vec<Note>,
}

#[derive(Serialize, Default)]
pub struct Report {
    notes: usize,
    days: usize,
    duplicates: usize,
    skipped: usize,
    templates: usize,
    attachments: usize,
    missing: Vec<String>,
}

// ---------- finding dates ----------

fn ymd(y: &str, m: u32, d: &str) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(y.parse().ok()?, m, d.parse().ok()?)
}

fn month_number(name: &str) -> u32 {
    let short = name.get(..3).unwrap_or("").to_lowercase();
    MONTHS.split('|').position(|m| m == short).map_or(0, |i| i as u32 + 1)
}

/// The first real date written anywhere in `text`.
fn date_in(text: &str) -> Option<NaiveDate> {
    let num = |s: &str| s.parse::<u32>().unwrap_or(0);
    ISO.captures_iter(text)
        .find_map(|c| ymd(&c[1], num(&c[2]), &c[3]))
        .or_else(|| UK.captures_iter(text).find_map(|c| ymd(&c[3], num(&c[2]), &c[1])))
        .or_else(|| {
            WORDY_DMY
                .captures_iter(text)
                .find_map(|c| ymd(&c[3], month_number(&c[2]), &c[1]))
        })
        .or_else(|| {
            WORDY_MDY
                .captures_iter(text)
                .find_map(|c| ymd(&c[3], month_number(&c[1]), &c[2]))
        })
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// Dated folders, e.g. 2024/03/05.md or 2024/2024-03/05 Tuesday.md
fn date_from_folders(rel: &Path) -> Option<NaiveDate> {
    let parts: Vec<String> = rel
        .with_extension("")
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let [.., year, month, day] = parts.as_slice() else {
        return None;
    };
    let (year, month) = (digits(year), digits(month));
    let day: String = day.chars().take_while(char::is_ascii_digit).collect();
    if year.len() < 4 || month.len() < 2 || day.is_empty() {
        return None;
    }
    let year = &year[year.len() - 4..];
    let month: u32 = month[month.len() - 2..].parse().ok()?;
    ymd(year, month, &day)
}

/// A date: / created: / day: line in YAML front-matter.
fn date_from_front_matter(text: &str) -> Option<NaiveDate> {
    let body = text.strip_prefix("---\n")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        matches!(key.trim().to_lowercase().as_str(), "date" | "created" | "created_at" | "day")
            .then(|| date_in(value))
            .flatten()
    })
}

fn file_date(path: &Path) -> Option<NaiveDate> {
    let meta = fs::metadata(path).ok()?;
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    Some(DateTime::<Local>::from(time).date_naive())
}

fn read_text(path: &Path) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&fs::read(path).map_err(err)?).replace("\r\n", "\n"))
}

// ---------- walking the old folder ----------

fn check_source(source: &str, root: &Path) -> Result<PathBuf, String> {
    let src = fs::canonicalize(source).map_err(err)?;
    let root = fs::canonicalize(root).map_err(err)?;
    if src.starts_with(&root) {
        return Err("That folder is your diary. Choose the folder with your old entries.".into());
    }
    Ok(src)
}

/// Every file in the folder, skipping hidden folders (.obsidian, .trash, .git),
/// template folders, and the diary itself if it happens to live inside.
fn walk(src: &Path, root: &Path) -> impl Iterator<Item = DirEntry> {
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    WalkDir::new(src)
        .into_iter()
        .filter_entry(move |e| {
            let name = e.file_name().to_string_lossy();
            let skipped = e.depth() > 0 && (name.starts_with('.') || name == "_templates");
            !skipped && e.path() != root.as_path()
        })
        .flatten()
        .filter(|e| e.file_type().is_file())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// Dated and undated notes, plus a count of template files left out.
fn collect(src: &Path, root: &Path) -> (Vec<(PathBuf, Note)>, usize) {
    let iso = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let mut templates = 0;
    let mut notes = Vec::new();
    for e in walk(src, root).filter(|e| is_markdown(e.path())) {
        let path = e.into_path();
        let text = read_text(&path).unwrap_or_default();
        if TEMPLATE.is_match(&text) {
            templates += 1;
            continue;
        }
        let rel = path.strip_prefix(src).unwrap_or(&path).to_path_buf();
        let stem = rel.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let date = date_in(&stem)
            .or_else(|| date_from_folders(&rel))
            .or_else(|| date_from_front_matter(&text));
        let note = Note {
            rel: rel.to_string_lossy().to_string(),
            date: date.map(iso),
            file_date: file_date(&path).map(iso),
        };
        notes.push((path, note));
    }
    notes.sort_by(|a, b| a.1.rel.cmp(&b.1.rel));
    (notes, templates)
}

fn file_key(name: &str) -> String {
    Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Attachments by file name, for resolving Obsidian's ![[name]] embeds.
fn index_files(src: &Path, root: &Path) -> HashMap<String, PathBuf> {
    let mut files = HashMap::new();
    for e in walk(src, root).filter(|e| !is_markdown(e.path())) {
        let key = file_key(&e.file_name().to_string_lossy());
        files.entry(key).or_insert_with(|| e.into_path());
    }
    files
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- rewriting links ----------

struct Relinker<'a> {
    note_dir: &'a Path,
    files: &'a HashMap<String, PathBuf>,
    root: &'a Path,
    day: NaiveDate,
}

impl Relinker<'_> {
    /// Copy a linked file into the day's media folder; returns the new link.
    fn bring(&self, target: &str, report: &mut Report) -> Option<String> {
        let beside = self.note_dir.join(target);
        let found = if beside.is_file() {
            Some(beside)
        } else {
            self.files.get(&file_key(target)).cloned()
        };
        match found.and_then(|p| store_attachment(self.root, self.day, &p).ok()) {
            Some(rel) => {
                report.attachments += 1;
                Some(rel)
            }
            None => {
                report.missing.push(target.to_string());
                None
            }
        }
    }

    fn rewrite(&self, text: &str, report: &mut Report) -> String {
        let text = EMBED.replace_all(text, |c: &Captures| {
            let target = c[1].trim();
            // ![[Other note]] embeds a note, not a file: leave it as written.
            let is_file = Path::new(target)
                .extension()
                .is_some_and(|e| !e.eq_ignore_ascii_case("md"));
            match is_file.then(|| self.bring(target, report)).flatten() {
                Some(rel) if IMAGE.is_match(&rel) => format!("![]({rel})"),
                Some(rel) => format!("[{}]({rel})", file_key(&rel)),
                None => c[0].to_string(),
            }
        });
        MD_LINK
            .replace_all(&text, |c: &Captures| {
                let url = c.get(3).or_else(|| c.get(4)).map_or("", |m| m.as_str());
                let external = url.contains("://")
                    || url.starts_with('#')
                    || url.starts_with("mailto:")
                    || url.to_lowercase().ends_with(".md");
                if external {
                    return c[0].to_string();
                }
                match self.bring(&percent_decode(url), report) {
                    Some(rel) => format!("{}[{}]({rel})", &c[1], &c[2]),
                    None => c[0].to_string(),
                }
            })
            .into_owned()
    }
}

// ---------- commands ----------

/// Look through the old folder and report what would be imported.
#[tauri::command]
pub async fn scan_import(state: State<'_, AppState>, source: String) -> Result<Plan, String> {
    let root = journal_root(&state)?;
    let src = check_source(&source, &root)?;
    let (notes, templates) = collect(&src, &root);
    let mut dates: Vec<&String> = notes.iter().filter_map(|(_, n)| n.date.as_ref()).collect();
    dates.sort();
    Ok(Plan {
        folder: src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        total: notes.len(),
        dated: dates.len(),
        templates,
        first: dates.first().map(|d| d.to_string()),
        last: dates.last().map(|d| d.to_string()),
        undated: notes.iter().filter(|(_, n)| n.date.is_none()).map(|(_, n)| n.clone()).collect(),
    })
}

/// Copy dated notes into the diary. A day that already has an entry gets the
/// imported text appended; text already present is skipped, so importing the
/// same folder twice changes nothing.
#[tauri::command]
pub async fn run_import(
    state: State<'_, AppState>,
    source: String,
    use_file_dates: bool,
) -> Result<Report, String> {
    let root = journal_root(&state)?;
    let src = check_source(&source, &root)?;
    let files = index_files(&src, &root);
    let (notes, templates) = collect(&src, &root);
    let mut report = Report { templates, ..Report::default() };

    let mut by_day: BTreeMap<NaiveDate, Vec<(PathBuf, String)>> = BTreeMap::new();
    for (path, note) in notes {
        let date = note.date.or(if use_file_dates { note.file_date } else { None });
        match date.and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()) {
            Some(day) => by_day.entry(day).or_default().push((path, note.rel)),
            None => report.skipped += 1,
        }
    }

    for (day, notes) in by_day {
        let target = entry_path(&root, day);
        let original = fs::read_to_string(&target).ok();
        let mut content = original.clone();

        for (path, rel) in notes {
            let relinker = Relinker {
                note_dir: path.parent().unwrap_or(src.as_path()),
                files: &files,
                root: &root,
                day,
            };
            let text = relinker.rewrite(&read_text(&path)?, &mut report);
            let text = text.trim();
            if text.is_empty() {
                report.skipped += 1;
                continue;
            }
            match &mut content {
                Some(existing) if existing.contains(text) => {
                    report.duplicates += 1;
                    continue;
                }
                Some(existing) => {
                    existing.truncate(existing.trim_end().len());
                    existing.push_str(&format!("\n\n---\n\n*Imported from {rel}*\n\n{text}\n"));
                }
                None => content = Some(format!("{text}\n")),
            }
            report.notes += 1;
        }

        if content != original {
            if let Some(c) = &content {
                atomic_write(&target, c)?;
                report.days += 1;
            }
        }
    }

    report.missing.sort();
    report.missing.dedup();
    if report.notes > 0 {
        let folder = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        commit_all(&root, &format!("Imported {} entries from {folder}", report.notes))?;
    }
    Ok(report)
}
