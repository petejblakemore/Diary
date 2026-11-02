// #tags: words like #holiday or #work/meetings anywhere in an entry. Tags
// are just text in the files; nothing is stored separately.

use crate::{err, journal_root, AppState};
use chrono::NaiveDate;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::sync::LazyLock;
use tauri::State;
use walkdir::WalkDir;

// A # at the start of a line or after a space or bracket, then a letter.
// "# Heading" isn't a tag (space after #), nor is a link like page#part.
pub(crate) static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)").unwrap());

#[derive(Serialize)]
pub struct Tag {
    name: String,
    /// Dates (YYYY-MM-DD) of entries using the tag, newest first.
    dates: Vec<String>,
}

/// Every tag in the diary, most used first.
#[tauri::command]
pub async fn all_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    let root = journal_root(&state)?;
    // lower-case name -> (name as first written, dates)
    let mut found: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();

    let entries = WalkDir::new(&root).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        e.depth() == 0 || !(name.starts_with('.') || name == "_templates")
    });
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".md") else { continue };
        if NaiveDate::parse_from_str(stem, "%Y-%m-%d").is_err() {
            continue;
        }
        let text = fs::read_to_string(e.path()).map_err(err)?;
        for c in TAG.captures_iter(&text) {
            let tag = c[1].trim_end_matches(['-', '/']).to_string();
            let entry = found
                .entry(tag.to_lowercase())
                .or_insert_with(|| (tag.clone(), BTreeSet::new()));
            entry.1.insert(stem.to_string());
        }
    }

    let mut tags: Vec<Tag> = found
        .into_values()
        .map(|(name, dates)| Tag { name, dates: dates.into_iter().rev().collect() })
        .collect();
    tags.sort_by(|a, b| b.dates.len().cmp(&a.dates.len()).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(tags)
}
