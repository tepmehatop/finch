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

/// Which title-reporting app runs in `t` now, if any: by the program's name,
/// or, for a script runtime (node, bun), by any folder or file in the script's
/// path (`~/.gigacode/bin/cli.js`, `node_modules/@x/gigacode-cli/dist/index.js`).
fn app(t: &Terminal) -> Option<&'static str> {
    let fg = t.foreground.as_ref()?;
    let base = |w: &str| w.rsplit(['/', '\\']).next().unwrap_or(w).trim_start_matches('.').to_ascii_lowercase();
    let named = |w: &str| APPS.iter().find(|(needle, _)| w.starts_with(needle)).map(|(_, app)| *app);
    if let Some(app) = named(&base(&fg.name)) {
        return Some(app);
    }
    let runtime = matches!(base(&fg.name).as_str(), "node" | "nodejs" | "bun" | "deno")
        || fg.argv.first().is_some_and(|a| matches!(base(a).as_str(), "node" | "nodejs" | "bun" | "deno"));
    for word in fg.argv.iter().take(4) {
        if let Some(app) = named(&base(word)) {
            return Some(app);
        }
        if word.contains("/qwen-code/") {
            return Some("qwen");
        }
        if runtime {
            for part in word.split(['/', '\\']) {
                if let Some(app) = named(&part.trim_start_matches('.').to_ascii_lowercase()) {
                    return Some(app);
                }
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

/// Lines (lowercased) of Qwen Code / GigaCode dialogs that wait for the person,
/// in English and Russian: tool confirmations, folder trust, questions.
const ASKING: &[&str] = &[
    "waiting for user confirmation",
    "ожидание подтверждения от пользователя",
    "yes, allow once",
    "да, разрешить один раз",
    "allow execution of",
    "разрешить выполнение",
    "apply this change?",
    "применить это изменение?",
    "do you want to proceed?",
    "вы хотите продолжить?",
    "do you trust this folder",
    "enter to select",
    "enter для выбора",
    "enter to submit · esc",
    "enter для отправки · esc",
    "enter to confirm, esc",
    "enter для подтверждения, esc",
];

/// Whether `t` runs an agent whose screen tells its state, and no program
/// reports for it over 7501.
pub fn reads_screen(t: &Terminal) -> bool {
    let Some(app) = app(t) else { return false };
    t.status.as_ref().is_none_or(|s| s.app.is_empty() || s.app == app)
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
    let tail = &tail[tail.len().saturating_sub(16)..];
    let asking = tail.iter().any(|r| ASKING.iter().any(|needle| r.contains(needle)));
    // The loading line: a braille spinner, or "(esc to cancel, 5s)".
    let spinning = tail.iter().rev().take(10).any(|r| {
        r.chars().next().is_some_and(|c| ('\u{2801}'..='\u{28FF}').contains(&c))
            || r.contains("(esc to cancel")
            || r.contains("(esc для отмены")
    });
    let was = t.status.as_ref().map(|s| s.state.as_str());
    let state = if asking {
        "blocked"
    } else if spinning {
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
        // Answered: the spinner runs again, then the prompt comes back.
        let r = infer_screen(&t, &rows(&["◆ Запускаю", "⠋ Думаю… (esc для отмены, 2с)"])).expect("working again");
        assert_eq!(r.state, "working");
        crate::status::apply(&mut t, &r);
        let r = infer_screen(&t, &rows(&["◆ Готово", ">   Введите сообщение"])).expect("done");
        assert_eq!(r.state, "done");
        crate::status::apply(&mut t, &r);
        let r = infer_screen(&t, &rows(&["Разрешить выполнение: 'npm'?", "› 1. Да, разрешить один раз"])).expect("asks");
        assert_eq!(r.state, "blocked");
    }

    #[test]
    fn a_runtime_running_a_gigacode_script_is_gigacode() {
        let t = terminal("node", &["node", "/Users/me/.gigacode/lib/dist/cli.js"]);
        assert!(reads_screen(&t));
        let qa = terminal("node", &["node", "/opt/node_modules/@corp/gigacode-qa/dist/index.js"]);
        assert_eq!(infer_screen(&qa, &["> ".to_string()]).map(|r| r.app), Some("gigacode-qa".to_string()));
        // An editor opening a GigaCode file is not GigaCode.
        let vim = terminal("vim", &["vim", "/Users/me/.gigacode/settings.json"]);
        assert!(!reads_screen(&vim));
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
