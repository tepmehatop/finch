//! Finch editions, picked at build time with `FINCH_EDITION`:
//!
//! - `full` (default): every agent program Finch knows, plus GigaCode.
//! - `closed`: for an isolated network. Only GigaCode (and plain shells and
//!   tools) in the program table, no other machines.
//!
//! Neither edition sends usage data or feedback, updates itself or downloads anything: the core ships
//! inside the package, and a new Finch is installed by hand.

/// True in the closed-network edition.
pub const CLOSED: bool = cfg!(finch_closed);

pub fn name() -> &'static str {
    if CLOSED { "closed" } else { "full" }
}

/// Finch never updates itself: a new version is downloaded and installed by
/// hand. No server is asked for app updates, ever.
pub fn releases() -> Option<String> {
    None
}

/// Nor for the core: it ships inside the app (see `bundled_core_dir`).
pub fn core_releases() -> Option<String> {
    None
}

/// Usage reports: Finch sends none, in either edition.
pub fn telemetry_url() -> Option<String> {
    None
}

/// Feedback: Finch sends none either; the feedback form isn't offered.
pub fn feedback_url() -> Option<String> {
    None
}

/// The core that shipped next to this program (`hc` beside the executable,
/// or in the bundle's `Contents/MacOS`), tried before anything on PATH.
pub fn bundled_core_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    exe.parent().map(|d| d.to_path_buf())
}

#[cfg(test)]
mod tests {
    #[test]
    fn edition_name_matches_cfg() {
        assert_eq!(super::name(), if cfg!(finch_closed) { "closed" } else { "full" });
    }

    #[test]
    fn closed_never_reports() {
        if super::CLOSED {
            assert!(super::telemetry_url().is_none());
            assert!(super::feedback_url().is_none());
        }
    }
}
