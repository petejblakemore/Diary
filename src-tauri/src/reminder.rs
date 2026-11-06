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

// Notifications use Apple's UserNotifications framework (UNUserNotificationCenter).
// The older NSUserNotification API reports success but shows nothing on
// current macOS.
#[cfg(target_os = "macos")]
mod mac {
    use block2::{Block, RcBlock};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyObject, Bool, NSObject};
    use objc2::{class, define_class, msg_send, AllocAnyThread};
    use objc2_foundation::NSString;
    use std::ffi::{c_char, CStr};
    use std::sync::{mpsc, Once};
    use std::time::Duration;

    // Loads the framework so its classes can be found by name.
    #[link(name = "UserNotifications", kind = "framework")]
    extern "C" {}

    const ALERT_AND_SOUND: usize = (1 << 1) | (1 << 2);
    /// Banner, Notification Centre and sound, even while Diary is in front.
    const SHOW_IN_FRONT: usize = (1 << 4) | (1 << 3) | (1 << 1);
    /// Long enough to click Allow the first time macOS asks.
    const ASK_WAIT: Duration = Duration::from_secs(60);
    const SEND_WAIT: Duration = Duration::from_secs(10);

    define_class!(
        // Without this, macOS hides notifications from the app in front, so
        // Send Test would show nothing.
        #[unsafe(super(NSObject))]
        #[name = "DiaryNotificationDelegate"]
        struct Delegate;

        impl Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: *mut AnyObject, _note: *mut AnyObject, handler: &Block<dyn Fn(usize)>) {
                handler.call((SHOW_IN_FRONT,));
            }
        }
    );

    fn utf8(s: *mut AnyObject) -> String {
        if s.is_null() {
            return String::new();
        }
        let p: *const c_char = unsafe { msg_send![s, UTF8String] };
        if p.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }

    /// Only a real Diary.app may use notifications. Asking from a bare
    /// program, as under `cargo tauri dev`, crashes instead of failing.
    fn center() -> Option<*mut AnyObject> {
        let bundle: *mut AnyObject = unsafe { msg_send![class!(NSBundle), mainBundle] };
        let path: *mut AnyObject = unsafe { msg_send![bundle, bundlePath] };
        if !utf8(path).ends_with(".app") {
            return None;
        }
        let center: *mut AnyObject = unsafe { msg_send![class!(UNUserNotificationCenter), currentNotificationCenter] };
        (!center.is_null()).then_some(center)
    }

    fn set_delegate(center: *mut AnyObject) {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
            // The centre only holds its delegate weakly, so keep it for good.
            let delegate = Retained::into_raw(delegate);
            let _: () = unsafe { msg_send![center, setDelegate: delegate] };
        });
    }

    /// Asks once (macOS remembers the answer); afterwards this returns at once.
    fn authorize(center: *mut AnyObject) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        let done = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
            let _ = tx.send(granted.as_bool());
        });
        let _: () = unsafe {
            msg_send![center, requestAuthorizationWithOptions: ALERT_AND_SOUND, completionHandler: &*done]
        };
        match rx.recv_timeout(ASK_WAIT) {
            Ok(true) => Ok(()),
            Ok(false) => Err("Notifications are off for Diary. Turn them on in System Settings → Notifications → Diary.".into()),
            Err(_) => Err("macOS didn't answer in time. If it asked, click Allow, then try again.".into()),
        }
    }

    pub fn notify(message: &str) -> Result<(), String> {
        autoreleasepool(|_| {
            let center = center().ok_or("Notifications only work from Diary.app, not from cargo tauri dev.")?;
            set_delegate(center);
            authorize(center)?;

            let content: Retained<AnyObject> = unsafe { msg_send![class!(UNMutableNotificationContent), new] };
            let title = NSString::from_str("Diary");
            let body = NSString::from_str(message);
            let sound: *mut AnyObject = unsafe { msg_send![class!(UNNotificationSound), defaultSound] };
            let _: () = unsafe { msg_send![&*content, setTitle: &*title] };
            let _: () = unsafe { msg_send![&*content, setBody: &*body] };
            let _: () = unsafe { msg_send![&*content, setSound: sound] };

            // No trigger: show now. The same id replaces an older reminder.
            let id = NSString::from_str("com.pete.diary.reminder");
            let now: *mut AnyObject = std::ptr::null_mut();
            let request: *mut AnyObject = unsafe {
                msg_send![class!(UNNotificationRequest), requestWithIdentifier: &*id, content: &*content, trigger: now]
            };

            let (tx, rx) = mpsc::channel();
            let done = RcBlock::new(move |error: *mut AnyObject| {
                let _ = tx.send(error.is_null());
            });
            let _: () = unsafe { msg_send![center, addNotificationRequest: request, withCompletionHandler: &*done] };
            match rx.recv_timeout(SEND_WAIT) {
                Ok(true) => Ok(()),
                Ok(false) => Err("macOS refused the notification.".into()),
                Err(_) => Err("macOS didn't confirm the notification in time.".into()),
            }
        })
    }
}

#[cfg(target_os = "macos")]
pub fn notify(message: &str) -> Result<(), String> {
    mac::notify(message)
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
