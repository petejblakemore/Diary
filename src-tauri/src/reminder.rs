// The evening reminder. A small macOS background job (a LaunchAgent in
// ~/Library/LaunchAgents) starts Diary's own program with --remind at the
// chosen time, even when Diary is closed. That run shows no window: it checks
// whether today has an entry, shows a notification if not, and exits.

use crate::{entry_path, err, Config};
use chrono::{Local, NaiveTime, Timelike};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const LABEL: &str = "com.pete.diary.reminder";
pub const DEFAULT_TIME: &str = "21:00";
pub const DEFAULT_MESSAGE: &str = "You haven't written in your diary today.";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn agent_path() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

/// The same settings file the app uses, read without the app running.
fn config() -> Config {
    let path = home().join("Library/Application Support/com.pete.diary/config.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn parse_time(time: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(time, "%H:%M").ok()
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Write the background job for this time and (re)load it. Called whenever
/// the setting changes, and at each launch in case the app has moved.
pub fn install(time: &str) -> Result<(), String> {
    let t = parse_time(time).ok_or("Invalid time")?;
    let exe = std::env::current_exe().map_err(err)?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>--remind</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>{}</integer>
    <key>Minute</key>
    <integer>{}</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"#,
        xml(&exe.to_string_lossy()),
        t.hour(),
        t.minute()
    );

    let path = agent_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    if fs::read_to_string(&path).ok().as_deref() == Some(plist.as_str()) {
        return Ok(()); // already installed and up to date
    }
    let _ = Command::new("/bin/launchctl").arg("unload").arg(&path).output();
    fs::write(&path, plist).map_err(err)?;
    Command::new("/bin/launchctl")
        .arg("load")
        .arg(&path)
        .output()
        .map_err(err)?;
    Ok(())
}

pub fn uninstall() {
    let path = agent_path();
    if path.exists() {
        let _ = Command::new("/bin/launchctl").arg("unload").arg(&path).output();
        let _ = fs::remove_file(path);
    }
}

#[cfg(target_os = "macos")]
pub fn notify(message: &str) -> Result<(), String> {
    let _ = mac_notification_sys::set_application("com.pete.diary");
    mac_notification_sys::send_notification("Diary", None, message, None)
        .map(|_| ())
        .map_err(err)
}

#[cfg(not(target_os = "macos"))]
pub fn notify(_: &str) -> Result<(), String> {
    Ok(())
}

/// What the background job runs (`Diary --remind`).
pub fn run() {
    let config = config();
    if !config.reminder {
        return;
    }
    let Some(root) = config.journal else { return };
    let time = if config.reminder_time.is_empty() { DEFAULT_TIME } else { &config.reminder_time };
    let Some(at) = parse_time(time) else { return };

    // If the Mac was asleep at reminder time, macOS runs the job on waking.
    // Only remind within three hours of the chosen time, never the next morning.
    let now = Local::now();
    let since = now.time().signed_duration_since(at);
    if since.num_minutes() < 0 || since.num_hours() >= 3 {
        return;
    }
    if entry_path(&root, now.date_naive()).exists() {
        return;
    }
    let message = if config.reminder_message.trim().is_empty() {
        DEFAULT_MESSAGE
    } else {
        config.reminder_message.trim()
    };
    let _ = notify(message);
}
