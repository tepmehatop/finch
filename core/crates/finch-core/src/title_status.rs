//! Finch: a status for agents that show it only in the terminal title.
//!
//! Qwen Code and its fork GigaCode CLI send no OSC 7501. With
//! `ui.showStatusInTitle` on they start the title with a glyph instead:
//! `◐` while working, `✳` while waiting for the person. This turns those
//! titles into the same status reports a 7501 program sends, so the app's
//! agent list, sounds and chat show them like any other agent. Programs that
//! report for themselves are left alone.

use crate::terminals::Terminal;
use ghostty_vt::StatusReport;

/// The apps this applies to, by the program's name or a word in its command.
const APPS: &[(&str, &str)] = &[("gigacode-qa", "gigacode-qa"), ("gigacode", "gigacode"), ("gcli", "gigacode"), ("qwen", "qwen")];

/// Which title-reporting app runs in `t` now, if any.
fn app(t: &Terminal) -> Option<&'static str> {
    let fg = t.foreground.as_ref()?;
    let words = std::iter::once(fg.name.as_str()).chain(fg.argv.iter().take(3).map(String::as_str));
    for word in words {
        let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
        for (needle, app) in APPS {
            if base.starts_with(needle) || (word.contains("/qwen-code/") && *app == "qwen") {
                return Some(app);
            }
        }
    }
    None
}

/// The status `title` means for `t`, or None to report nothing.
pub fn infer(t: &Terminal, title: &str) -> Option<StatusReport> {
    let app = app(t)?;
    // A program that sends 7501 itself (another app name in its report) wins.
    if let Some(s) = &t.status
        && !s.app.is_empty()
        && s.app != app
    {
        return None;
    }
    let trimmed = title.trim_start();
    let was = t.status.as_ref().map(|s| s.state.as_str());
    let state = if trimmed.starts_with('◐') {
        "working"
    } else if trimmed.starts_with('✳') {
        "blocked"
    } else if matches!(was, Some("working")) {
        "done"
    } else {
        return None;
    };
    if was == Some(state) {
        return None;
    }
    let label = trimmed.trim_start_matches(['◐', '✳', '\u{FE0E}', ' ']).to_owned();
    Some(StatusReport {
        state,
        kind: (state == "blocked").then_some("question"),
        progress: None,
        id: String::new(),
        app: app.to_owned(),
        title: label,
        message: String::new(),
    })
}

/// When the screen was last looked at, per terminal: at most once a second.
static LOOKED: std::sync::Mutex<Option<std::collections::HashMap<u32, u64>>> = std::sync::Mutex::new(None);

/// Whether it's time to read terminal `id`'s screen again.
pub fn due(id: u32, now_ms: u64) -> bool {
    let mut map = LOOKED.lock().unwrap();
    let map = map.get_or_insert_with(Default::default);
    if map.get(&id).is_some_and(|at| now_ms.saturating_sub(*at) < 1000) {
        return false;
    }
    map.insert(id, now_ms);
    true
}

/// The status the visible screen of a Qwen Code / GigaCode CLI terminal shows,
/// for versions whose title has no glyphs: a confirmation dialog is "blocked",
/// "esc to cancel" is "working", anything else "idle" (or "done" after working).
/// Also how such an agent first appears in the lists: as "idle".
pub fn infer_screen(t: &Terminal, rows: &[String]) -> Option<StatusReport> {
    let app = app(t)?;
    if let Some(s) = &t.status
        && !s.app.is_empty()
        && s.app != app
    {
        return None;
    }
    let tail: Vec<String> = rows.iter().map(|r| r.trim().to_lowercase()).filter(|r| !r.is_empty()).collect();
    let tail = &tail[tail.len().saturating_sub(20)..];
    let has = |needle: &str| tail.iter().any(|r| r.contains(needle));
    let asking = has("waiting for user confirmation")
        || has("ожидание подтверждения от пользователя")
        || has("do you trust this folder")
        || (has("yes, allow once") && (has("apply this change") || has("allow execution") || has("do you want to proceed") || has("shell command execution")));
    let was = t.status.as_ref().map(|s| s.state.as_str());
    let state = if asking {
        "blocked"
    } else if tail.iter().rev().take(8).any(|r| r.contains("esc to cancel")) {
        "working"
    } else if matches!(was, Some("working")) {
        "done"
    } else if was.is_none() {
        "idle"
    } else {
        return None;
    };
    if was == Some(state) {
        return None;
    }
    Some(StatusReport {
        state,
        kind: (state == "blocked").then_some("question"),
        progress: None,
        id: String::new(),
        app: app.to_owned(),
        title: String::new(),
        message: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreground::Foreground;

    fn terminal(name: &str, argv: &[&str]) -> Terminal {
        let mut r = crate::terminals::Registry::default();
        let new = crate::terminals::NewTerminal { argv: vec!["sh".into()], cwd: "/".into(), ..Default::default() };
        let id = r.create(new, 0).unwrap();
        let mut t = r.terminals.remove(&id).unwrap();
        t.foreground = Some(Foreground { pid: 1, name: name.into(), argv: argv.iter().map(|a| a.to_string()).collect(), cwd: "/".into() });
        t
    }

    #[test]
    fn gigacode_titles_become_statuses() {
        let mut t = terminal("node", &["node", "/usr/local/bin/gigacode"]);
        let r = infer(&t, "◐ Fixing tests").expect("working");
        assert_eq!((r.state, r.app.as_str(), r.title.as_str()), ("working", "gigacode", "Fixing tests"));
        crate::status::apply(&mut t, &r);
        assert!(infer(&t, "◐ Still fixing").is_none(), "no repeat while the state holds");
        let r = infer(&t, "✳ Allow edit?").expect("blocked");
        assert_eq!((r.state, r.kind), ("blocked", Some("question")));
        crate::status::apply(&mut t, &r);
        let r = infer(&t, "◐ Editing").expect("working again");
        crate::status::apply(&mut t, &r);
        assert_eq!(infer(&t, "Qwen Code").map(|r| r.state), Some("done"));
    }

    #[test]
    fn the_screen_tells_when_the_title_cannot() {
        let mut t = terminal("node", &["node", "/opt/gigacode-qa"]);
        let rows = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        let r = infer_screen(&t, &rows(&["> type your message"])).expect("appears");
        assert_eq!((r.state, r.app.as_str()), ("idle", "gigacode-qa"));
        crate::status::apply(&mut t, &r);
        let r = infer_screen(&t, &rows(&["⠋ Reading files (12s · esc to cancel)"])).expect("working");
        crate::status::apply(&mut t, &r);
        let r = infer_screen(&t, &rows(&["Apply this change?", "● 1. Yes, allow once"])).expect("blocked");
        assert_eq!(r.state, "blocked");
        crate::status::apply(&mut t, &r);
        let r = infer_screen(&t, &rows(&["⠏ Ожидание подтверждения от пользователя..."]));
        assert!(r.is_none(), "still blocked");
    }

    #[test]
    fn other_programs_and_native_reporters_are_left_alone() {
        let t = terminal("vim", &["vim"]);
        assert!(infer(&t, "◐ anything").is_none());
        let mut t = terminal("qwen", &["qwen"]);
        let native = StatusReport { state: "working", kind: None, progress: None, id: String::new(), app: "claude".into(), title: String::new(), message: String::new() };
        crate::status::apply(&mut t, &native);
        assert!(infer(&t, "✳ question").is_none());
    }
}
