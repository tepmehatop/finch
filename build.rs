//! Embeds the default mods (defaults/mods/**), the program icons
//! (defaults/icons/*) and the frame's mods (defaults/frame/**) so Finch can
//! install them.
//!
//! Worktrees may share one target dir, and with it this script and its output.
//! So nothing here names this checkout: paths are relative to the package and
//! the generated code includes files through the compiling crate's
//! `CARGO_MANIFEST_DIR`.

use std::path::Path;

fn walk(dir: &Path, base: &Path, root: &Path, out: &mut Vec<String>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
    // Finch: the closed-network edition ships without the add-a-machine dialog.
    if std::env::var("FINCH_EDITION").as_deref() == Ok("closed") {
        entries.retain(|p| !p.ends_with("defaults/mods/machine-add"));
    }
    entries.sort();
    for p in entries {
        if p.is_dir() {
            walk(&p, base, root, out);
        } else {
            let path = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            println!("cargo:rerun-if-changed={path}");
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push(format!("    ({rel:?}, include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/{path}\"))),"));
        }
    }
}

fn embed(base: &Path, folder: &str, name: &str, file: &str) {
    println!("cargo:rerun-if-changed={folder}");
    let mut lines = Vec::new();
    let root = base.join(folder);
    walk(&root, base, &root, &mut lines);
    let code = format!("pub const {name}: &[(&str, &[u8])] = &[\n{}\n];\n", lines.join("\n"));
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join(file), code).unwrap();
}

fn main() {
    // Finch: FINCH_EDITION=closed builds the closed-network edition (src/edition.rs).
    println!("cargo::rustc-check-cfg=cfg(finch_closed)");
    println!("cargo:rerun-if-env-changed=FINCH_EDITION");
    match std::env::var("FINCH_EDITION").as_deref() {
        Ok("closed") => println!("cargo:rustc-cfg=finch_closed"),
        Ok("full") | Ok("") | Err(_) => {}
        Ok(other) => panic!("FINCH_EDITION must be full or closed, not {other:?}"),
    }
    let base = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    embed(&base, "defaults/mods", "DEFAULT_MODS", "default_mods.rs");
    embed(&base, "defaults/icons", "DEFAULT_ICONS", "default_icons.rs");
    embed(&base, "defaults/frame", "FRAME_MODS", "frame_mods.rs");

    // Windows takes the window, taskbar and Start menu icon from the program file.
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=assets/icons/finch.ico");
        winresource::WindowsResource::new().set_icon("assets/icons/finch.ico").compile().expect("cannot embed the icon");
    }
}
