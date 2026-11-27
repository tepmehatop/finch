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
const APPS: &[(&str, &str)] = &[("gigacode", "gigacode"), ("gcli", "gigacode"), ("qwen", "qwen")];

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
    fn other_programs_and_native_reporters_are_left_alone() {
        let t = terminal("vim", &["vim"]);
        assert!(infer(&t, "◐ anything").is_none());
        let mut t = terminal("qwen", &["qwen"]);
        let native = StatusReport { state: "working", kind: None, progress: None, id: String::new(), app: "claude".into(), title: String::new(), message: String::new() };
        crate::status::apply(&mut t, &native);
        assert!(infer(&t, "✳ question").is_none());
    }
}
