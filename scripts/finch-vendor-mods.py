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

    node = walk(node)
    # Finch: background mods (auto-retry and the agent queue) run in every shipped layout.
    if not any((f.get("content") or {}).get("mod") == "retry" for f in node.get("floating", [])):
        node.setdefault("floating", []).append({"id": "retry", "content": {"mod": "retry"}, "edge": "bottom", "align": "end"})
    # Finch: Finch's panels join the layout's side panel.
    FINCH_PANEL_IDS = ["review", "asks", "git-graph", "skillsgate", "mcp", "jira", "prompts"]
    def find_id(n, i):
        if n.get("id") == i:
            return n
        for c in n.get("children", []):
            r = find_id(c, i)
            if r:
                return r
    body = find_id(node, "panel-body")
    if body is not None:
        have = {c.get("id") for c in body.get("children", [])}
        body["children"] += [{"id": i, "type": "block", "content": {"mod": i}} for i in FINCH_PANEL_IDS if i not in have]
    tabs = find_id(node, "tabs")
    props = ((tabs or {}).get("content") or {}).get("props") or {}
    if isinstance(props.get("buttons"), list):
        icons = {"review": "mods/changes/changes.svg", "asks": "frame/welcome/messages.svg", "git-graph": "mods/workspace-chrome/branch.svg",
                 "skillsgate": "frame/welcome/layers.svg", "mcp": "frame/welcome/layers.svg", "jira": "mods/workspace-chrome/branch.svg", "prompts": "frame/palette/command.svg"}
        labels = {"review": "Review", "asks": "Questions", "git-graph": "Git graph", "skillsgate": "Skills", "mcp": "MCP", "jira": "Jira", "prompts": "Prompts"}
        targets = {c.get("id") for c in body.get("children", [])} if body else set()
        props["buttons"] = [b for b in props["buttons"] if ((b.get("action") or {}).get("target") in targets) or (b.get("action") or {}).get("type") != "panel"]
        have = {b.get("id") for b in props["buttons"]}
        props["buttons"] += [{"id": i, "label": labels[i], "icon": icons[i], "group": "panels",
                              "action": {"type": "panel", "container": "panel", "stack": "panel-body", "target": i}} for i in FINCH_PANEL_IDS if i not in have]
    # Finch: PA layouts start in Finch's palette; their own themes stay in Settings > Look.
    if layout_path.name in ("PA-Advanced.json", "PA-Light.json"):
        node["theme"] = {"light": "paper", "dark": "graphite"}
    layout_path.write_text(json.dumps(node, indent=2, ensure_ascii=False) + "\n")


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
    "prodsovet/filesystem.js": [
        ('  if (place === "tab") run("tab.new", { ...(w.space ? { space: w.space } : {}), ...(w.cwd ? { folder: w.cwd } : {}), ...(argv ? { argv } : {}), ...(name ? { name } : {}) });', '  // Finch: agents the chat reads open with their chat beside them (the + menu\'s switch).\n  const chat = Boolean(argv) && shared("finch.chatWithAgents") !== false && /(^|\\/)(claude|gigacode|qwen)$/.test(argv[0] ?? "");\n  if (place === "tab") run("tab.new", { ...(w.space ? { space: w.space } : {}), ...(w.cwd ? { folder: w.cwd } : {}), ...(argv ? { argv } : {}), ...(name ? { name } : {}), ...(chat ? { chat: true } : {}) });'),
    ],
    "prodsovet/file-tabs.js": [
        ('      .when(enabled.includes("issues"), el => el.child(panelButton("issues", L("Issues", "Задачи"), "mods/prodsovet/art/px/issue.svg")))', '      .when(enabled.includes("issues"), el => el.child(panelButton("issues", L("Issues", "Задачи"), "mods/prodsovet/art/px/issue.svg")))\n      // Finch: Finch\'s panels (review, MCP, Jira, prompts...) behind More; the one shown keeps its button.\n      .when(FINCH_PANELS.some(([id]) => finchPanel(id)), el => {\n        const shownId = panel && !panel.hidden ? body?.active : null;\n        const current = FINCH_PANELS.find(([id]) => id === shownId && finchPanel(id));\n        const list = FINCH_PANELS.filter(([id]) => finchPanel(id));\n        return el.when(Boolean(current), e => e.child(panelButton(current[0], L(current[1], current[3]), current[2])))\n          .child(h_flex().id("panel-more").h(metric("tabs.button")).px(8).gap(4).flex_none().items_center().rounded(radius(6))\n            .text_size(fontSize("tabs.action")).text_color(t.muted).hover(s => s.bg(t.hover)).on_mouse_down("left", stop)\n            .on_click(() => openOverlay({ mod: "panels-menu", kind: "popup", width: 220, height: 40 + 31 * list.length, props: { panels: list.map(([id, en, icon]) => [id, en, icon]) } }))\n            .child(L("More", "Ещё")).child(div().text_size(10).child("▾")));\n      })'),
        ("function find(node, id) {", '// Finch: its own panels, added to this layout\'s side panel: [id, English, icon, Russian].\nconst FINCH_PANELS = [\n  ["review", "Review", "mods/changes/changes.svg", "Ревью"],\n  ["asks", "Questions", "frame/welcome/messages.svg", "Вопросы"],\n  ["git-graph", "Git graph", "mods/workspace-chrome/branch.svg", "Граф Git"],\n  ["skillsgate", "Skills", "frame/welcome/layers.svg", "Навыки"],\n  ["mcp", "MCP", "frame/welcome/layers.svg", "MCP"],\n  ["jira", "Jira", "mods/workspace-chrome/branch.svg", "Jira"],\n  ["prompts", "Prompts", "frame/palette/command.svg", "Промпты"],\n];\nconst finchPanel = (id) => (shared("finch.mods") ?? {})[id] !== false && Boolean(find(layout(), id));\n\nfunction find(node, id) {'),
    ],
    "better-tabs/main.js": [
        ('  config() {\n    return { ...DEFAULTS, ...props() };\n  }', '  config() {\n    // Finch: buttons of shipped mods turned off in Settings > Mods are left out.\n    const off = shared("finch.mods") ?? {};\n    const c = { ...DEFAULTS, ...props() };\n    return { ...c, buttons: (c.buttons ?? []).filter((b) => off[b.id] !== false) };\n  }'),
    ],
    "prodsovet/main.js": [
        ('      .when(this.hovered, (el) => el\n        .child(this.button(t, `ps-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))', '      // Finch: agents whose conversation the chat mod reads get a Chat toggle.\n      .when(["claude", "gigacode", "qwen"].includes(p.program?.key) && Boolean(p.terminal), (el) => el.child(div().id(`ps-chat-${pane}`).flex_none().px(7).h(20).flex().items_center().rounded(5)\n        .border_1().border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))\n        .on_click((_e, cx) => { cx.stop_propagation(); run("agent.chat", { terminal: p.terminal }); })\n        .child("Chat")))\n      .when(this.hovered, (el) => el\n        .child(this.button(t, `ps-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))'),
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
