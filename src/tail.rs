//! Finch: reading big, growing text files a piece at a time, for mods.
//!
//! An agent's session log grows for as long as the session runs (40 hours
//! makes hundreds of megabytes), so the chat mod never reads one whole: it
//! reads the end, follows what's appended, and pages back on request. Every
//! call reads at most `max` bytes and returns whole lines only, with the byte
//! offsets to continue from. Memory stays the size of what's on screen.
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The most one call reads.
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => crate::mods::home().join(rest),
        None => PathBuf::from(path),
    }
}

fn read_at(file: &mut std::fs::File, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

fn lines_of(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| String::from_utf8_lossy(l).into_owned())
        .collect()
}

/// Whole lines from `from` on (default: the last `max` bytes), at most `max`
/// bytes. `{lines, start, end, size}`: continue from `end`; a line still being
/// written (no newline yet) is left for the next call.
pub fn tail(path: &str, from: Option<u64>, max: Option<u64>) -> Result<Value, String> {
    let path = expand(path);
    let mut file = std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let max = max.unwrap_or(512 * 1024).clamp(1, MAX_CHUNK);
    let (mut start, aligned) = match from {
        Some(f) => (f.min(size), true),
        None => (size.saturating_sub(max), size <= max),
    };
    let mut bytes = read_at(&mut file, start, max.min(size - start)).map_err(|e| e.to_string())?;
    // Started mid-line (reading the end): skip to the next whole line.
    if !aligned && start > 0 {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(i) => {
                bytes.drain(..=i);
                start += i as u64 + 1;
            }
            None => bytes.clear(),
        }
    }
    // Only whole lines: the rest is read next time.
    let keep = match bytes.iter().rposition(|b| *b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    bytes.truncate(keep);
    let end = start + keep as u64;
    Ok(json!({ "lines": lines_of(&bytes), "start": start, "end": end, "size": size }))
}

/// Whole lines that end at or before `before`, at most `max` bytes of them:
/// paging back through history. `{lines, start}`: page again from `start`.
pub fn before(path: &str, before: u64, max: Option<u64>) -> Result<Value, String> {
    let path = expand(path);
    let mut file = std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let before = before.min(size);
    let max = max.unwrap_or(512 * 1024).clamp(1, MAX_CHUNK);
    let mut start = before.saturating_sub(max);
    let mut bytes = read_at(&mut file, start, before - start).map_err(|e| e.to_string())?;
    if start > 0 {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(i) => {
                bytes.drain(..=i);
                start += i as u64 + 1;
            }
            None => {
                bytes.clear();
                start = before;
            }
        }
    }
    Ok(json!({ "lines": lines_of(&bytes), "start": start }))
}

/// Files under `dir` (up to `depth` folders deep) whose name ends in
/// `suffix`, newest first: `[{path, modified, size}]`, at most `limit`.
pub fn recent(dir: &str, suffix: &str, depth: usize, limit: usize) -> Value {
    fn walk(dir: &Path, suffix: &str, depth: usize, out: &mut Vec<(std::time::SystemTime, PathBuf, u64)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            let p = e.path();
            if meta.is_dir() {
                if depth > 0 {
                    walk(&p, suffix, depth - 1, out);
                }
            } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(suffix)) {
                out.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), p, meta.len()));
            }
        }
    }
    let mut found = Vec::new();
    walk(&expand(dir), suffix, depth.min(6), &mut found);
    found.sort_by(|a, b| b.0.cmp(&a.0));
    Value::Array(
        found
            .into_iter()
            .take(limit.clamp(1, 200))
            .map(|(t, p, size)| {
                let ms = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                json!({ "path": p.to_string_lossy(), "modified": ms, "size": size })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(text: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("finch-tail-{}-{}.jsonl", std::process::id(), text.len()));
        std::fs::write(&p, text).unwrap();
        p
    }

    #[test]
    fn tail_returns_whole_lines_and_follows_appends() {
        let p = temp("aaa\nbbb\nccc\npart");
        let r = tail(p.to_str().unwrap(), None, Some(9)).unwrap();
        // The last 9 bytes start inside "bbb": only "ccc" is whole; "part" waits.
        assert_eq!(r["lines"], json!(["ccc"]));
        let end = r["end"].as_u64().unwrap();
        std::fs::write(&p, "aaa\nbbb\nccc\npart2\n").unwrap();
        let r = tail(p.to_str().unwrap(), Some(end), None).unwrap();
        assert_eq!(r["lines"], json!(["part2"]));
        let r = before(p.to_str().unwrap(), 12, Some(100)).unwrap();
        assert_eq!(r["lines"], json!(["aaa", "bbb", "ccc"]));
        assert_eq!(r["start"], json!(0));
        let r = before(p.to_str().unwrap(), 12, Some(6)).unwrap();
        assert_eq!(r["lines"], json!(["ccc"]));
        assert_eq!(r["start"], json!(8));
        std::fs::remove_file(p).unwrap();
    }

    #[test]
    fn whole_file_when_small() {
        let p = temp("x\ny\n");
        let r = tail(p.to_str().unwrap(), None, Some(1000)).unwrap();
        assert_eq!(r["lines"], json!(["x", "y"]));
        assert_eq!(r["start"], json!(0));
        std::fs::remove_file(p).unwrap();
    }
}
