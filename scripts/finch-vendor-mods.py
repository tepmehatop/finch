#!/usr/bin/env python3
"""Copies the community mods, layouts and themes Finch ships into defaults/.

    scripts/finch-vendor-mods.py <folder with the cloned repositories>

The folder holds clones of (with these folder names):
    herdr-mods          github.com/munza/herdr-mods
    herdr-prodsovet     github.com/Dan4eck/herdr-prodsovet
    herdr-agent-ask     github.com/sachin-philip/herdr-agent-ask
    herdr-space-folders github.com/jankeesvw/herdr-space-folders
    herdr-git-graph     github.com/rabeeh-ta/herdr-git-graph
    skillsgate          github.com/skillsgate/skillsgate

Each mod folder is copied whole (tests, docs and licenses left out), then renamed
for Finch the same way the app was: the `herdr` module is `finch`, `herdr-app` is
`finch`, `~/.config/herdr-app` is `~/.config/finch`. Running it again replaces
the copies, so an update is: pull the clones, run this, review the diff.
"""
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "_research/mods").resolve()
DEFAULTS = ROOT / "defaults"

MODS = {
    # Better mods (munza/herdr-mods); sidebar and tabs come with the Estro layout.
    "better-changes": "herdr-mods/better-changes/mods/better-changes",
    "better-files": "herdr-mods/better-files/mods/better-files",
    "better-icons": "herdr-mods/better-icons/mods/better-icons",
    "better-search": "herdr-mods/better-search/mods/better-search",
    "better-config": "herdr-mods/better-config/mods/better-config",
    "better-alerts": "herdr-mods/better-alerts/mods/better-alerts",
    "better-sidebar": "herdr-mods/better-sidebar/mods/better-sidebar",
    "better-tabs": "herdr-mods/better-tabs/mods/better-tabs",
    # PA-Advanced (Dan4eck/herdr-prodsovet).
    "prodsovet": "herdr-prodsovet/mods/prodsovet",
    "my-files": "herdr-prodsovet/mods/my-files",
    "file-tab": "herdr-prodsovet/mods/file-tab",
    "find": "herdr-prodsovet/mods/find",
    "session_fork": "herdr-prodsovet/mods/session_fork",
    # Single mods.
    "asks": "herdr-agent-ask/mods/asks",
    "space-folders": "herdr-space-folders/mods/space-folders",
    "git-graph": "herdr-git-graph/mods/git-graph",
    "skillsgate": "skillsgate/herdr/skillsgate/mods/skillsgate",
}
LAYOUTS = {
    "PA-Advanced.json": "herdr-prodsovet/layouts/PA-Advanced.json",
    "PA-Light.json": "herdr-prodsovet/layouts/PA-Light.json",
    "pa-advanced.svg": "herdr-prodsovet/layouts/pa-advanced.svg",
    "pa-light.svg": "herdr-prodsovet/layouts/pa-light.svg",
    "estro.json": "herdr-mods/estro/layouts/estro.json",
}
# Finch: palette entries for the popups people open by name.
PALETTE = {
    "better-search": {"title": "Search everything", "command": "mod.open", "args": {"name": "better-search"}, "words": "search find everything"},
    "better-config": {"title": "Mod settings", "command": "mod.open", "args": {"name": "better-config"}, "words": "mods config settings"},
}
THEMES = ["PA-Advanced-Day", "PA-Advanced-Night", "PA-Light-Day", "PA-Light-Night"]

SKIP_DIRS = {"tests", "test", "node_modules", "__tests__", "fixtures", ".git"}
SKIP_FILES = re.compile(r"(?i)^(license.*|notice.*|readme.*|recipe\.md|changelog.*|.*\.test\.[cm]?js|.*\.d\.ts|jsconfig\.json|package(-lock)?\.json)$")
TEXT = {".js", ".mjs", ".cjs", ".json", ".md", ".svg", ".txt", ".css", ".html", ".sh", ".py", ".toml"}


def rename(text: str) -> str:
    return (text.replace("herdr-app", "finch").replace("HERDR_APP", "FINCH_APP")
            .replace("HERDR", "FINCH").replace("Herdr", "Finch").replace("herdr", "finch"))


def copy_tree(src: pathlib.Path, dst: pathlib.Path):
    if dst.exists():
        shutil.rmtree(dst)
    for f in sorted(src.rglob("*")):
        rel = f.relative_to(src)
        if any(p in SKIP_DIRS for p in rel.parts) or f.is_dir() or SKIP_FILES.match(f.name):
            continue
        out = dst / pathlib.Path(*[rename(p) for p in rel.parts])
        out.parent.mkdir(parents=True, exist_ok=True)
        if f.suffix in TEXT:
            out.write_text(rename(f.read_text()))
        else:
            shutil.copyfile(f, out)


def strip_network_panels(layout_path: pathlib.Path, mods: set[str]):
    """Drops blocks of mods Finch doesn't ship (Estro's PR and issue panels)."""
    node = json.loads(layout_path.read_text())

    def keep(n):
        mod = (n.get("content") or {}).get("mod")
        return not mod or mod in mods or mod in BUILT_IN

    def walk(n):
        if "children" in n:
            n["children"] = [walk(c) for c in n["children"] if keep(c)]
        if "floating" in n:
            n["floating"] = [walk(c) for c in n["floating"] if keep(c)]
        return n

    layout_path.write_text(json.dumps(walk(node), indent=2, ensure_ascii=False) + "\n")


BUILT_IN = {p.name for p in (DEFAULTS / "mods").iterdir() if p.is_dir()} - set(MODS)

for name, rel in MODS.items():
    copy_tree(SRC / rel, DEFAULTS / "mods" / name)
    # Finch places these mods in its layouts itself; none docks on its own.
    meta = DEFAULTS / "mods" / name / "mod.json"
    d = json.loads(meta.read_text())
    d["place"] = "none"
    d.pop("size", None)
    if name in PALETTE:
        d["palette"] = [PALETTE[name]]
    meta.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print("mod", name)
for name, rel in LAYOUTS.items():
    out = DEFAULTS / "layouts" / name
    out.write_text(rename((SRC / rel).read_text()))
    print("layout", name)
for theme in THEMES:
    (DEFAULTS / "themes" / f"{theme}.json").write_text(rename((SRC / "herdr-prodsovet/themes" / f"{theme}.json").read_text()))
    print("theme", theme)
# Finch: PA-Advanced's language follows Finch's, and its EN/RU switch sets Finch's.
PATCHES = {
    "appearance.js": [
        ('import { shared, settings } from "finch";', 'import { shared, settings, finch } from "finch";'),
        ('export const lang = () => (shared("ui.lang") === "ru" ? "ru" : "en");',
         'export const lang = () => (finch()?.language === "ru" ? "ru" : "en");'),
    ],
    "find/main.js": [
        ('        const r = await exec("rg", ["--files", "--hidden", ...(this.on ? [] : RG_SEP()), "-g", "!.git", "-g", "!.obsidian", "-g", "!.trash", "-g", "!*.pyc", "-g", "!.DS_Store", "--sortr", "modified"], { cwd: root, on: this.on, timeout: 20000 });', '        // Finch: without ripgrep (a closed network may not have it), find lists the files.\n        const r = onWindows(this.on)\n          ? await exec("rg", ["--files", "--hidden", ...(this.on ? [] : RG_SEP()), "-g", "!.git", "-g", "!.obsidian", "-g", "!.trash", "-g", "!*.pyc", "-g", "!.DS_Store", "--sortr", "modified"], { cwd: root, on: this.on, timeout: 20000 })\n          : await exec("sh", ["-c", FILES_SCRIPT], { cwd: root, on: this.on, timeout: 20000 });'),
        ('            const script = \'rg --null -n --no-heading --color never -S -F --hidden -g "!.git" -g "!.obsidian" -g "!.trash" --max-columns 240 --max-columns-preview --max-count 8 -e "$1" | head -n 400\';', "            const script = SEARCH_SCRIPT;"),
        ("export default class", '// Finch: ripgrep when the machine has it, else find and grep (same output shape).\nconst FILES_SCRIPT = \'if command -v rg >/dev/null 2>&1; then rg --files --hidden -g "!.git" -g "!.obsidian" -g "!.trash" -g "!*.pyc" -g "!.DS_Store" --sortr modified; else find . -type f -not -path "*/.git/*" -not -path "*/.obsidian/*" -not -path "*/.trash/*" -not -name "*.pyc" -not -name ".DS_Store" 2>/dev/null | sed "s|^\\\\./||" | head -n 20000; fi\';\nconst SEARCH_SCRIPT = \'if command -v rg >/dev/null 2>&1; then rg --null -n --no-heading --color never -S -F --hidden -g "!.git" -g "!.obsidian" -g "!.trash" --max-columns 240 --max-columns-preview --max-count 8 -e "$1" | head -n 400; else case "$1" in *[A-Z]*) i="";; *) i="-i";; esac; grep -rnIF $i --null --exclude-dir=.git --exclude-dir=node_modules -m 8 -e "$1" . 2>/dev/null | sed "s|^\\\\./||" | cut -c1-400 | head -n 400; fi\';\n\nexport default class'),
    ],
    "better-alerts/main.js": [
        ('import { agents, appHome, checking, exec, focused, hc, setBadge, terminals, window } from "finch";',
         'import { agents, appHome, checking, exec, focused, hc, setBadge, shared, terminals, window } from "finch";'),
        ("    cx.timer.every(CHECK_MS, () => this.check());",
         '    // Finch: Settings > Mods can turn the alerts off.\n    cx.timer.every(CHECK_MS, () => { if ((shared("finch.mods") ?? {})["better-alerts"] !== false) this.check(); });'),
    ],
    "prodsovet/main.js": [
        ('.on_click(() => setShared("ui.lang", code))', '.on_click(() => { setShared("ui.lang", code); setLanguage(code); })'),
        ('nextCommand, openOverlay } from "finch";', 'nextCommand, openOverlay, setLanguage } from "finch";'),
    ],
}
for path in (DEFAULTS / "mods").rglob("*.js"):
    rel = path.relative_to(DEFAULTS / "mods").as_posix()
    for key, edits in PATCHES.items():
        if rel.endswith(key) and rel.split("/")[0] in MODS:
            text = path.read_text()
            for old, new in edits:
                text = text.replace(old, new)
            path.write_text(text)

shipped = BUILT_IN | set(MODS)
for name in ["estro.json", "PA-Advanced.json", "PA-Light.json"]:
    strip_network_panels(DEFAULTS / "layouts" / name, shipped)
