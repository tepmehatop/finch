//! Finch: interface language and product name.
//!
//! Mods keep drawing plain English. Every text run they draw passes through
//! `translate` (registered with finch-shell), which:
//!
//! 1. looks the text up in the language's dictionary (`defaults/locales/<lang>.json`):
//!    exact strings first, then the same text in capitals (headings are
//!    upper-cased by mods), then regex patterns for texts with numbers or names;
//! 2. otherwise shows the text as it is.
//!
//! The language is settings.json's `"language"` (`"ru"` or `"en"`); without
//! it, the system's (Russian if the system is Russian, else English).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

pub const PRODUCT: &str = "Finch";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En = 0,
    Ru = 1,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ru => "ru",
        }
    }

    fn parse(s: &str) -> Option<Lang> {
        let s = s.trim().to_ascii_lowercase();
        if s.starts_with("ru") {
            Some(Lang::Ru)
        } else if s.starts_with("en") {
            Some(Lang::En)
        } else {
            None
        }
    }
}

static LANG: AtomicU8 = AtomicU8::new(Lang::En as u8);
/// settings.json's own choice, if any (None: follow the system).
static CHOSEN: Mutex<Option<Lang>> = Mutex::new(None);

pub fn lang() -> Lang {
    if LANG.load(Ordering::Relaxed) == Lang::Ru as u8 { Lang::Ru } else { Lang::En }
}

pub fn chosen() -> Option<Lang> {
    *CHOSEN.lock().unwrap()
}

/// The system's language: LC_ALL / LC_MESSAGES / LANG, and on macOS the
/// first of the person's preferred languages.
pub fn system_lang() -> Lang {
    static SYSTEM: OnceLock<Lang> = OnceLock::new();
    *SYSTEM.get_or_init(|| {
        for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Some(l) = std::env::var(key).ok().and_then(|v| Lang::parse(&v)) {
                return l;
            }
        }
        #[cfg(target_os = "macos")]
        if let Ok(out) = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLanguages"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            let first = text.split(['(', ',', '"', '\n', ' ', ')']).find(|w| !w.trim().is_empty());
            if let Some(l) = first.and_then(Lang::parse) {
                return l;
            }
        }
        Lang::En
    })
}

/// Applies settings.json's text (its `language`). Returns whether the shown language changed.
pub fn apply_settings(text: &str) -> bool {
    let chosen = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("language").and_then(|l| l.as_str()).and_then(Lang::parse));
    *CHOSEN.lock().unwrap() = chosen;
    set_lang(chosen.unwrap_or_else(system_lang))
}

fn set_lang(l: Lang) -> bool {
    let before = LANG.swap(l as u8, Ordering::Relaxed);
    if before != l as u8 {
        if let Some(cache) = CACHE.lock().unwrap().as_mut() {
            cache.clear();
        }
        true
    } else {
        false
    }
}

/// Writes `"language"` into settings.json (keeping everything else). The
/// window sees the file change and redraws every mod in the new language.
pub fn choose(code: &str) -> Result<(), String> {
    let l = Lang::parse(code).ok_or_else(|| format!("unknown language {code:?}: use ru or en"))?;
    let path = crate::settings::path();
    let previous = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".into(),
        Err(e) => return Err(e.to_string()),
    };
    let mut raw: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&previous).map_err(|e| format!("settings.json has errors: {e}"))?;
    raw.insert("language".into(), serde_json::Value::String(l.code().into()));
    let text = serde_json::to_string_pretty(&raw).map_err(|e| e.to_string())? + "\n";
    crate::persist::write_atomic(&path, text).map_err(|e| e.to_string())?;
    *CHOSEN.lock().unwrap() = Some(l);
    Ok(())
}

struct Dictionary {
    exact: HashMap<String, String>,
    /// The same entries keyed in lower case, for upper-cased headings.
    lower: HashMap<String, String>,
    patterns: Vec<(regex::Regex, String)>,
}

fn parse_dictionary(text: &str) -> Dictionary {
    let v: serde_json::Value = serde_json::from_str(text).expect("defaults/locales: valid JSON");
    let mut exact = HashMap::new();
    if let Some(map) = v.get("exact").and_then(|m| m.as_object()) {
        for (k, val) in map {
            if let Some(s) = val.as_str() {
                exact.insert(k.clone(), s.to_owned());
            }
        }
    }
    let lower = exact.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
    let mut patterns = Vec::new();
    if let Some(list) = v.get("patterns").and_then(|m| m.as_array()) {
        for pair in list {
            if let (Some(re), Some(to)) = (pair.get(0).and_then(|x| x.as_str()), pair.get(1).and_then(|x| x.as_str())) {
                match regex::Regex::new(&format!("^(?:{re})$")) {
                    Ok(r) => patterns.push((r, to.to_owned())),
                    Err(e) => tracing::warn!("locale pattern {re:?}: {e}"),
                }
            }
        }
    }
    Dictionary { exact, lower, patterns }
}

fn dictionary(l: Lang) -> &'static Dictionary {
    static EN: OnceLock<Dictionary> = OnceLock::new();
    static RU: OnceLock<Dictionary> = OnceLock::new();
    match l {
        Lang::En => EN.get_or_init(|| parse_dictionary(include_str!("../defaults/locales/en.json"))),
        Lang::Ru => RU.get_or_init(|| parse_dictionary(include_str!("../defaults/locales/ru.json"))),
    }
}

/// Texts seen and what they became, for this language. Bounded: mods also draw
/// data (file names, branches) that is never in a dictionary.
static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
const CACHE_MAX: usize = 20_000;

fn lookup(d: &Dictionary, text: &str) -> Option<String> {
    if let Some(t) = d.exact.get(text) {
        return Some(t.clone());
    }
    let trimmed = text.trim();
    if trimmed.len() != text.len() && !trimmed.is_empty() {
        if let Some(t) = d.exact.get(trimmed) {
            return Some(text.replacen(trimmed, t, 1));
        }
    }
    let has_letters = text.chars().any(char::is_alphabetic);
    if has_letters && text == text.to_uppercase() {
        if let Some(t) = d.lower.get(&text.to_lowercase()) {
            return Some(t.to_uppercase());
        }
    }
    for (re, to) in &d.patterns {
        if re.is_match(text) {
            let out = re.replace(text, to.as_str()).into_owned();
            return Some(out);
        }
    }
    None
}

/// What to show for `text`, or None to show it unchanged.
pub fn translate(text: &str) -> Option<String> {
    if text.is_empty() || !text.chars().any(char::is_alphabetic) {
        return None;
    }
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(text) {
        return hit.clone();
    }
    let out = lookup(dictionary(lang()), text);
    if cache.len() >= CACHE_MAX {
        cache.clear();
    }
    cache.insert(text.to_owned(), out.clone());
    out
}

/// For Rust-side texts (menus, toasts): the translation, or the text itself.
pub fn tr(text: &str) -> String {
    translate(text).unwrap_or_else(|| text.to_owned())
}

/// Installs the translator for every mod and reads the language once.
pub fn init() {
    finch_shell::set_translator(translate);
    let text = std::fs::read_to_string(crate::settings::path()).unwrap_or_default();
    apply_settings(&text);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionaries_parse_and_patterns_compile() {
        for l in [Lang::En, Lang::Ru] {
            let d = dictionary(l);
            for (re, _) in &d.patterns {
                assert!(re.as_str().starts_with("^(?:"));
            }
        }
        assert!(!dictionary(Lang::Ru).exact.is_empty());
    }

    #[test]
    fn russian_lookup_covers_headings_and_patterns() {
        let d = dictionary(Lang::Ru);
        assert_eq!(lookup(d, "Settings").as_deref(), Some("Настройки"));
        assert_eq!(lookup(d, "SETTINGS").as_deref(), Some("НАСТРОЙКИ"));
        assert!(lookup(d, "some-branch-name").is_none());
    }
}
