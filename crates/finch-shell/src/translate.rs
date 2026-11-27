//! Finch: one place where every text a mod draws can be translated.
//!
//! The app registers a translator (`set_translator`) and materialize passes
//! each text run and tooltip through it. Mods keep writing plain English;
//! nothing in their code has to change for another language.
use std::sync::OnceLock;

type Translator = fn(&str) -> Option<String>;

static TRANSLATOR: OnceLock<Translator> = OnceLock::new();

/// Installs the translator; the first call wins.
pub fn set_translator(f: Translator) {
    let _ = TRANSLATOR.set(f);
}

/// The text to show for `text`: a translation, or None to show it as it is.
pub(crate) fn translate(text: &str) -> Option<String> {
    TRANSLATOR.get().and_then(|f| f(text))
}
