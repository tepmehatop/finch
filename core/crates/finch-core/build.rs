fn main() {
    // Finch: FINCH_EDITION=closed turns other machines off (see api.rs machine_add).
    println!("cargo::rustc-check-cfg=cfg(finch_closed)");
    println!("cargo:rerun-if-env-changed=FINCH_EDITION");
    if std::env::var("FINCH_EDITION").as_deref() == Ok("closed") {
        println!("cargo:rustc-cfg=finch_closed");
    }
    println!("cargo:rerun-if-changed=../../distribution/macos-Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let plist = include_str!("../../distribution/macos-Info.plist")
        .replace("@VERSION@", &std::env::var("CARGO_PKG_VERSION").unwrap());
    let path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("Info.plist");
    std::fs::write(&path, plist).unwrap();
    // Separate arguments preserve paths containing spaces.
    for arg in ["-sectcreate", "__TEXT", "__info_plist"] {
        println!("cargo:rustc-link-arg-bin=finch-core=-Wl,{arg}");
    }
    println!("cargo:rustc-link-arg-bin=finch-core={}", path.display());
}
