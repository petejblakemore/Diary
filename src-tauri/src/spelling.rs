// Spell checking with the Mac's own spell checker (NSSpellChecker): the same
// dictionary, language settings and learned words as every other Mac app.
// Offsets are in UTF-16 units, which is also how JavaScript counts.

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSRange, NSString};
    use std::ffi::{c_char, CStr};

    fn checker() -> *mut AnyObject {
        unsafe { msg_send![class!(NSSpellChecker), sharedSpellChecker] }
    }

    pub fn misspelled(text: &str) -> Vec<(usize, usize)> {
        autoreleasepool(|_| {
            let checker = checker();
            let s = NSString::from_str(text);
            let len = text.encode_utf16().count();
            let mut found = Vec::new();
            let mut start = 0usize;
            while start < len {
                let r: NSRange = unsafe {
                    msg_send![checker, checkSpellingOfString: &*s, startingAt: start as isize]
                };
                // Nothing left, or the checker wrapped back to the beginning.
                if r.length == 0 || r.location < start || r.location >= len {
                    break;
                }
                found.push((r.location, r.length));
                start = r.location + r.length;
            }
            found
        })
    }

    pub fn guesses(word: &str) -> Vec<String> {
        autoreleasepool(|_| {
            let s = NSString::from_str(word);
            let range = NSRange::new(0, word.encode_utf16().count());
            let none: *mut AnyObject = std::ptr::null_mut();
            let list: *mut AnyObject = unsafe {
                msg_send![checker(), guessesForWordRange: range, inString: &*s, language: none, inSpellDocumentWithTag: 0isize]
            };
            if list.is_null() {
                return Vec::new();
            }
            let count: usize = unsafe { msg_send![list, count] };
            (0..count.min(6))
                .filter_map(|i| {
                    let item: *mut AnyObject = unsafe { msg_send![list, objectAtIndex: i] };
                    let utf8: *const c_char = unsafe { msg_send![item, UTF8String] };
                    (!utf8.is_null())
                        .then(|| unsafe { CStr::from_ptr(utf8) }.to_string_lossy().into_owned())
                })
                .collect()
        })
    }

    pub fn learn(word: &str) {
        autoreleasepool(|_| {
            let s = NSString::from_str(word);
            let _: () = unsafe { msg_send![checker(), learnWord: &*s] };
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    pub fn misspelled(_: &str) -> Vec<(usize, usize)> {
        Vec::new()
    }
    pub fn guesses(_: &str) -> Vec<String> {
        Vec::new()
    }
    pub fn learn(_: &str) {}
}

/// (start, length) of each misspelled word.
#[tauri::command]
pub fn check_spelling(text: String) -> Vec<(usize, usize)> {
    mac::misspelled(&text)
}

#[tauri::command]
pub fn spelling_guesses(word: String) -> Vec<String> {
    mac::guesses(&word)
}

/// Adds the word to the Mac's own dictionary (~/Library/Spelling).
#[tauri::command]
pub fn learn_word(word: String) {
    mac::learn(&word)
}
