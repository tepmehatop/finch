//! Finch: kept terminals bring their agent back after a reboot or a core crash.
//!
//! A program that speaks OSC 7577 says how to resume itself; coding agents
//! don't. When a lost kept terminal was last running one of these agents (its
//! saved foreground), recovery starts the agent again in the same folder,
//! continuing its latest session, and leaves the person's shell when it exits.

use crate::foreground::Foreground;

/// The agents this knows and how each continues its latest session.
const AGENTS: &[(&str, &str)] = &[
    ("claude", "claude --continue"),
    ("gigacode", "gigacode --continue"),
    ("qwen", "qwen --continue"),
    ("codex", "codex resume --last"),
];

/// Which agent ran in the foreground: by process name, or the script a
/// runtime (node) was running.
fn agent(fg: &Foreground) -> Option<&'static str> {
    let words = std::iter::once(fg.name.as_str()).chain(fg.argv.iter().take(3).map(String::as_str));
    for word in words {
        let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
        for (name, command) in AGENTS {
            if base == *name || base.starts_with(&format!("{name}-")) || base.starts_with(&format!("{name}.")) {
                return Some(command);
            }
        }
    }
    None
}

/// The argv that resumes the agent through the person's shell, or None.
pub fn argv(fg: Option<&Foreground>, shell: &[String]) -> Option<Vec<String>> {
    if cfg!(windows) {
        return None;
    }
    let command = agent(fg?)?;
    let sh = shell.first()?.clone();
    Some(vec![sh.clone(), "-lc".into(), format!("{command}; exec \"{sh}\" -l")])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fg(name: &str, argv: &[&str]) -> Foreground {
        Foreground { pid: 1, name: name.into(), argv: argv.iter().map(|a| a.to_string()).collect(), cwd: "/".into() }
    }

    #[test]
    fn known_agents_come_back_with_their_session() {
        let shell = vec!["/bin/zsh".to_string(), "-l".to_string()];
        let a = argv(Some(&fg("claude", &["claude"])), &shell).unwrap();
        assert_eq!(a, ["/bin/zsh", "-lc", "claude --continue; exec \"/bin/zsh\" -l"]);
        let g = argv(Some(&fg("node", &["node", "/usr/local/bin/gigacode"])), &shell).unwrap();
        assert!(g[2].starts_with("gigacode --continue"));
        assert!(argv(Some(&fg("vim", &["vim"])), &shell).is_none());
        assert!(argv(None, &shell).is_none());
    }
}
