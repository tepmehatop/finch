import { appearance, fontSize, metric, radius, L, style, labelFont } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Find: one popup to search files by name, text inside files, and the text of open terminals.
// Root = the focused pane's folder (as my-files shows it). Tab switches mode.
// Enter or click: open (file -> its own tab via file-tab, terminal -> go to it),
// Cmd+Enter (Ctrl+Enter on Windows): put "@path" into the last agent terminal, Option/Alt+Enter: open in the default app,
// Ctrl+Up: search the parent folder, Esc: close.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, hc, run, theme, settings, props, closeOverlay, notify, shared } from "finch";

const MODES = [
  { id: "files", get label() { return L("Files", "Файлы"); }, get hint() { return L("file name, in parts too: pa news 11", "имя файла, можно частями: pa news 11"); } },
  { id: "text", get label() { return L("Text", "Текст"); }, get hint() { return L("text inside files (ripgrep)", "текст внутри файлов (ripgrep)"); } },
  { id: "terms", get label() { return L("Terminals", "Терминалы"); }, get hint() { return L("screen and history of open terminals", "экран и история открытых терминалов"); } },
];
const MAX_ROWS = 200, TERM_LINES = 3000;

import { openFile, location, fileGlyph, fileKind, kindColor, join, parent, samePath, isWindowsPath, tilde, onWindows, onMac, openExternal, pasteInto, shortcut } from "./filesystem.js";
// ripgrep prints "\" on Windows; the lists and labels here use "/" relative paths.
const RG_SEP = () => onWindows() ? ["--path-separator", "/"] : [];

// Agency profiles: pixel icons and tinted selection, as in the sidebar.
const agency = () => style("agency") === true;
const px = (name) => `mods/prodsovet/art/px/${name}.svg`;
const glyph = (t, name) => { const g = fileGlyph(t, name, false); return svg(g.path).size(g.size).mx(g.size < 14 ? 1 : 0).flex_none().text_color(agency() ? g.color : t.dim); };
function where() { return { ...location(), terminal: focused()?.terminal ?? null }; }

// Each space-separated part must match; whole-word hits in the file name rank first.
function score(path, q) {
  const lower = path.toLowerCase(), base = lower.slice(lower.lastIndexOf("/") + 1);
  let total = 0;
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    let i = base.indexOf(tok);
    if (i >= 0) { total += 1000 - i * 2 + (i === 0 ? 200 : 0); continue; }
    i = lower.indexOf(tok);
    if (i >= 0) { total += 500 - i * 0.2; continue; }
    let at = -1, gaps = 0;
    for (const ch of tok) {
      const n = lower.indexOf(ch, at + 1);
      if (n < 0) return -1;
      if (at >= 0) gaps += n - at - 1;
      at = n;
    }
    total += Math.max(1, 200 - gaps * 3);
  }
  return total - path.length * 0.3;
}

// Finch: ripgrep when the machine has it, else find and grep (same output shape).
const FILES_SCRIPT = 'if command -v rg >/dev/null 2>&1; then rg --files --hidden -g "!.git" -g "!.obsidian" -g "!.trash" -g "!*.pyc" -g "!.DS_Store" --sortr modified; else find . -type f -not -path "*/.git/*" -not -path "*/.obsidian/*" -not -path "*/.trash/*" -not -name "*.pyc" -not -name ".DS_Store" 2>/dev/null | sed "s|^\\./||" | head -n 20000; fi';
const SEARCH_SCRIPT = 'if command -v rg >/dev/null 2>&1; then rg --null -n --no-heading --color never -S -F --hidden -g "!.git" -g "!.obsidian" -g "!.trash" --max-columns 240 --max-columns-preview --max-count 8 -e "$1" | head -n 400; else case "$1" in *[A-Z]*) i="";; *) i="-i";; esac; grep -rnIF $i --null --exclude-dir=.git --exclude-dir=node_modules -m 8 -e "$1" . 2>/dev/null | sed "s|^\\./||" | cut -c1-400 | head -n 400; fi';

export default class Find extends View {
  init(p, cx) {
    this.h = cx.focus_handle();
    const w = where();
    this.root = w.cwd; this.on = w.on; this.agent = w.terminal;
    this.mode = "files"; this.at = 0; this.query = ""; this.seq = 0;
    this.files = null; this.hits = []; this.termText = null; this.busy = false; this.error = null;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: L("Search for…", "Что ищем…") });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; this.search(cx); });
    // Cmd/Ctrl+Enter also submits (secondary): the key handler sends that row
    // to the agent, so the plain "open in a tab" is only for Enter itself.
    this.input.on("submit", (e, cx) => { if (!e?.secondary) this.open(this.rows()[this.at], "open", cx); });
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.loadFiles(cx);
  }

  // ---------- data ----------

  loadFiles(cx) {
    if (!this.root) { this.error = L("Which folder? Click the panel you need and open search again", "Не понял, какая папка: кликни в нужную панель и открой ещё раз"); return; }
    this.files = null; this.busy = true;
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        // Finch: without ripgrep (a closed network may not have it), find lists the files.
        const r = onWindows(this.on)
          ? await exec("rg", ["--files", "--hidden", ...(this.on ? [] : RG_SEP()), "-g", "!.git", "-g", "!.obsidian", "-g", "!.trash", "-g", "!*.pyc", "-g", "!.DS_Store", "--sortr", "modified"], { cwd: root, on: this.on, timeout: 20000 })
          : await exec("sh", ["-c", FILES_SCRIPT], { cwd: root, on: this.on, timeout: 20000 });
        if (root !== this.root) return;
        this.files = r.stdout.split(/\r?\n/).filter(Boolean);
        this.error = r.code === 0 || this.files.length ? null : (r.stderr || L("rg could not read the folder", "rg не смог прочитать папку")).trim();
      } catch (e) { this.error = L(`ripgrep (rg) is required: ${e}`, `Нужен ripgrep (rg): ${e}`); this.files = []; }
      this.busy = false; cx.notify();
    });
  }

  search(cx) {
    const seq = ++this.seq, q = this.query.trim();
    if (this.mode === "files") return cx.notify();
    if (this.mode === "terms") { if (!this.termText) this.loadTerms(cx); return cx.notify(); }
    if (q.length < 2) { this.hits = []; this.busy = false; return cx.notify(); }
    this.busy = true; cx.notify();
    cx.timer.after(220, (cx) => {
      if (seq !== this.seq) return;
      cx.spawn(async (cx) => {
        let out = [];
        try {
          let lines;
          if (onWindows(this.on)) {
            // No sh or head on Windows: ripgrep alone, the first 400 lines kept.
            const r = await exec("rg", ["--null", "-n", "--no-heading", "--color", "never", "-S", "-F", "--hidden", ...RG_SEP(), "-g", "!.git", "-g", "!.obsidian", "-g", "!.trash", "--max-columns", "240", "--max-columns-preview", "--max-count", "8", "-e", q], { cwd: this.root, timeout: 20000 });
            lines = r.stdout.split(/\r?\n/).slice(0, 400);
          } else {
            const script = SEARCH_SCRIPT;
            const r = await exec("sh", ["-c", script, "find", q], { cwd: this.root, on: this.on, timeout: 20000 });
            lines = r.stdout.split("\n");
          }
          for (const line of lines) {
            const z = line.indexOf("\0");
            if (z < 0) continue;
            const rest = line.slice(z + 1), c = rest.indexOf(":");
            out.push({ kind: "hit", path: line.slice(0, z), line: Number(rest.slice(0, c)), text: rest.slice(c + 1).trim() });
          }
          this.error = null;
        } catch (e) { this.error = String(e); }
        if (seq !== this.seq) return;
        this.hits = out; this.busy = false; cx.notify();
      });
    });
  }

  loadTerms(cx) {
    this.busy = true; this.termText = [];
    cx.spawn(async (cx) => {
      const shown = panes().filter((p) => p.terminal);
      const read = await Promise.all(shown.map(async (p) => {
        try {
          const r = await hc(["read", p.terminal, "--lines", String(TERM_LINES)]);
          return { pane: p, lines: r.code === 0 ? r.stdout.split("\n") : [] };
        } catch { return { pane: p, lines: [] }; }
      }));
      this.termText = read; this.busy = false; cx.notify();
    });
  }

  rows() {
    const q = this.query.trim();
    if (this.mode === "files") {
      const files = this.files ?? [];
      if (!q) return files.slice(0, MAX_ROWS).map((path) => ({ kind: "file", path }));
      const scored = [];
      for (const path of files) { const s = score(path, q); if (s > -1) scored.push({ kind: "file", path, s }); }
      return scored.sort((a, b) => b.s - a.s).slice(0, MAX_ROWS);
    }
    if (this.mode === "text") return this.hits.slice(0, MAX_ROWS);
    if (!q || !this.termText) return [];
    const ql = q.toLowerCase(), out = [];
    for (const { pane, lines } of this.termText) {
      let n = 0;
      for (let i = lines.length - 1; i >= 0 && n < 6; i--) {
        if (lines[i].toLowerCase().includes(ql)) { out.push({ kind: "term", pane, text: lines[i].trim() }); n++; }
      }
    }
    return out.slice(0, MAX_ROWS);
  }

  // ---------- actions ----------

  setMode(id, cx) {
    this.mode = id; this.at = 0;
    this.search(cx);
    this.input.focus();
  }

  up(cx) {
    if (!this.root || this.root === "/" || samePath(parent(this.root), this.root)) return;
    this.root = isWindowsPath(this.root) ? parent(this.root) : this.root.replace(/\/[^/]+\/?$/, "") || "/";
    this.hits = []; this.loadFiles(cx); this.search(cx);
  }

  close() { closeOverlay(props().overlay); }

  async open(r, how, cx) {
    if (!r) return;
    if (r.kind === "term") {
      this.close();
      run("tab.select", { id: r.pane.tab });
      run("pane.focus", { pane: r.pane.pane });
      return;
    }
    const abs = isWindowsPath(this.root) ? join(this.root, r.path) : `${this.root.replace(/\/$/, "")}/${r.path}`;
    if (how === "agent") {
      const term = this.agent;
      if (!term) return notify({ title: L("No terminal", "Нет терминала"), body: L("Click the agent terminal and try again", "Кликни в терминал агента и попробуй снова"), level: "warning" });
      const text = (/\s/.test(abs) ? `"${abs}"` : `@${abs}`) + " ";
      // Closing this popup ends its mod copy and cancels what it still awaits
      // (on Windows the clipboard helper takes ~0.3 s), so close only when the
      // clipboard is ready; pasteInto starts the rest at once.
      await pasteInto(term, text, () => this.close()).catch((e) => { this.close(); notify({ title: L("Not sent", "Не отправлено"), body: String(e.message ?? e), level: "error" }); });
      return;
    }
    if (how === "app") {
      if (this.on) return notify({ title: L("File on another machine", "Файл на другой машине"), body: L("Only local files open in an app", "Открыть в приложении можно только локальные файлы"), level: "warning" });
      await openExternal(abs).catch((e) => notify({ title: L("Not opened", "Не открылось"), body: String(e.message ?? e), level: "error" }));
      this.close();
      return;
    }
    this.close();
    openFile(abs, this.on);
  }

  // ---------- popup ----------

  render(cx) {
    const t = theme(), rows = this.rows(), q = this.query.trim();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const home = (s) => isWindowsPath(s) ? tilde(s) : s?.replace(/^\/Users\/[^/]+/, "~") ?? "";
    // Cmd on macOS, Ctrl elsewhere (there the platform key is the Windows key).
    const primary = (m) => onMac() ? m?.platform : m?.control;

    const tab = (m) => {
      const on = m.id === this.mode;
      return div().id(`fd-mode-${m.id}`).px(10).py(4).rounded(radius(6)).text_size(fontSize("find.action")).cursor_pointer()
        .when(agency(), (el) => el.font_family(labelFont() ?? appearance().fonts.mono))
        .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(agency() ? t.foreground + "1f" : t.selected).font_weight(appearance().weights.semibold))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.setMode(m.id, cx)).child(agency() ? m.label.toUpperCase() : m.label);
    };

    const row = (r, i) => {
      const on = i === this.at;
      const base = h_flex().id(`fd-r-${i}`).mx(4).px(10).min_h(30).py(4).rounded(radius(7)).gap(10).items_center().cursor_pointer()
        .when(on, (el) => el.bg(agency() ? (r.kind === "term" ? t.foreground : kindColor(t, fileKind(r.path, false))) + "24" : t.hover)).hover((s) => s.bg(t.hover))
        .on_click((e, cx) => this.open(r, primary(e.modifiers) ? "agent" : e.modifiers?.alt ? "app" : "open", cx));
      if (r.kind === "file") {
        const cut = r.path.lastIndexOf("/");
        return base
          .child(glyph(t, r.path))
          .child(div().flex_none().max_w(300).truncate().text_color(t.foreground).child(r.path.slice(cut + 1)))
          .child(div().flex_1().truncate().text_size(fontSize("find.meta")).text_color(t.dim).child(cut > 0 ? r.path.slice(0, cut) : ""));
      }
      if (r.kind === "hit") {
        return base.when(agency(), (el) => el.child(glyph(t, r.path))).child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(fontSize("find.meta")).text_color(t.dim).child(`${r.path}:${r.line}`))
          .child(div().truncate().text_color(t.foreground).child(r.text || " ")));
      }
      return base.when(agency(), (el) => el.child(svg(px("terminal")).size(15).flex_none().text_color(t.muted))).child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(fontSize("find.meta")).text_color(t.dim).child(`${r.pane.title || r.pane.terminal} · ${r.pane.terminal}`))
        .child(div().truncate().text_color(t.foreground).child(r.text || " ")));
    };

    let status;
    if (this.error) status = this.error;
    else if (this.busy) status = this.mode === "terms" ? L("Reading terminals…", "Читаю терминалы…") : L("Searching…", "Ищу…");
    else if (this.mode === "files") status = q ? L(`${rows.length}${rows.length === MAX_ROWS ? "+" : ""} of ${this.files?.length ?? 0} files`, `${rows.length}${rows.length === MAX_ROWS ? "+" : ""} из ${this.files?.length ?? 0} файлов`) : L(`${this.files?.length ?? 0} files, recently changed first · name in parts: pa news 11`, `${this.files?.length ?? 0} файлов, сначала недавно изменённые · имя можно частями: pa news 11`);
    else if (this.mode === "text") status = q.length < 2 ? L("Text inside files, at least 2 characters", "Текст внутри файлов, хотя бы 2 символа") : L(`${rows.length} matches`, `${rows.length} совпадений`);
    else status = q ? L(`${rows.length} lines in ${this.termText?.length ?? 0} terminals`, `${rows.length} строк в ${this.termText?.length ?? 0} терминалах`) : L(`Searching ${panes().filter((p) => p.terminal).length} terminals`, `Ищу по ${panes().filter((p) => p.terminal).length} терминалам`);

    return v_flex().id("find").track_focus(this.h).w_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(fontSize("find.body"))
      .on_key_down((e, cx) => {
        const k = e.key, m = e.modifiers;
        if (k === "escape") return this.close();
        if (k === "tab") { const i = MODES.findIndex((x) => x.id === this.mode); this.setMode(MODES[(i + (m.shift ? MODES.length - 1 : 1)) % MODES.length].id, cx); }
        else if (k === "up" && m.control) this.up(cx);
        else if (k === "down" && rows.length) { this.at = (this.at + 1) % rows.length; this.scroll.scroll_to_item(this.at); }
        else if (k === "up" && rows.length) { this.at = (this.at + rows.length - 1) % rows.length; this.scroll.scroll_to_item(this.at); }
        else if (k === "enter" && primary(m)) this.open(rows[this.at], "agent", cx);
        else if (k === "enter" && m.alt) this.open(rows[this.at], "app", cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().items_center().gap(4)
        .children(MODES.map(tab))
        .child(div().flex_1())
        .child(div().id("fd-up").px(6).py(2).rounded(radius(5)).text_size(fontSize("find.meta")).text_color(t.dim).cursor_pointer().truncate().max_w(260)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.up(cx))
          .child((this.on ? `${this.on}:` : "") + home(this.root)))
        .child(div().id("fd-esc").px(6).py(2).rounded(radius(5)).text_size(fontSize("find.meta")).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(metric("find.input")).flex_none().px(10).gap(8).items_center().rounded(radius(9)).border_1().border_color(t.accent).bg(t.background)
        .child(svg(agency() ? px("search") : "mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(fontSize("find.input")).text_color(t.foreground)))
      .child(div().text_size(fontSize("find.meta")).text_color(this.error ? t.blocked : t.dim).child(status))
      .child(v_flex().id("fd-list").h(Math.min(420, Math.max(rows.length, 1) * (this.mode === "files" ? metric("find.fileRow") : metric("find.resultRow"))) * 1).flex_none().overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows.map(row)))
      .child(div().text_size(fontSize("find.hint")).text_color(t.dim)
        .child(L(`Tab mode · Enter open in a tab · ${shortcut("⌘Enter", "Ctrl+Enter")} to agent · ${shortcut("⌥Enter", "Alt+Enter")} in app · ${shortcut("⌃↑", "Ctrl+↑")} folder up`,
          `Tab режим · Enter открыть во вкладке · ${shortcut("⌘Enter", "Ctrl+Enter")} в агента · ${shortcut("⌥Enter", "Alt+Enter")} в приложении · ${shortcut("⌃↑", "Ctrl+↑")} папка выше`)));
  }
}
