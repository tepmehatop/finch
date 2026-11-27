//! Finch: settings agents need for Finch to see them.
//!
//! GigaCode CLI and Qwen Code tell their state only in the terminal title, and
//! only with `ui.showStatusInTitle` on (finch-core turns those titles into
//! statuses: core/crates/finch-core/src/title_status.rs). At start, Finch turns
//! it on in `~/.gigacode/settings.json` and `~/.qwen/settings.json` when the CLI
//! is installed, keeping everything else in the file. A file that isn't plain
//! JSON (comments, a typo) is left as it is.
use serde_json::{Map, Value};
use std::path::Path;

pub fn ensure_status_in_title() {
    let home = crate::mods::home();
    for dir in [".gigacode", ".qwen"] {
        let dir = home.join(dir);
        if dir.is_dir()
            && let Err(e) = turn_on(&dir.join("settings.json"))
        {
            tracing::warn!("{}: {e}", dir.display());
        }
    }
}

fn turn_on(path: &Path) -> Result<(), String> {
    let mut root: Map<String, Value> = match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Map::new(),
        Ok(text) => match serde_json::from_str(&text) {
            Ok(Value::Object(m)) => m,
            _ => return Ok(()), // not plain JSON: not ours to rewrite
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(e.to_string()),
    };
    let ui = root.entry("ui").or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(ui) = ui else { return Ok(()) };
    if ui.get("showStatusInTitle") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    ui.insert("showStatusInTitle".into(), Value::Bool(true));
    let text = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())? + "\n";
    crate::persist::write_atomic(path, text).map_err(|e| e.to_string())?;
    tracing::info!("turned on ui.showStatusInTitle in {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn turns_it_on_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("finch-agent-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"model": {"name": "x"}, "ui": {"theme": "dark"}}"#).unwrap();
        super::turn_on(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["ui"]["showStatusInTitle"], true);
        assert_eq!(v["ui"]["theme"], "dark");
        assert_eq!(v["model"]["name"], "x");
        // Comments: left alone.
        std::fs::write(&path, "{ // mine\n}").unwrap();
        super::turn_on(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ // mine\n}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
