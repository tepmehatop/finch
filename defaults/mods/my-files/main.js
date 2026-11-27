import { appearance, fontSize, metric, radius, style, labelFont, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Personal file explorer; roots are stable per workspace.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, props, exec, watchFolder, theme, window, nextCommand, notify, run, shared, settings } from "finch";
import { location, browse, basename, parent, join, openFile, showMenu, showDialog, clipboard, pasteInto, shortcut, fileGlyph, fileKind, kindColor } from "./filesystem.js";
import { FileMenu, FileDialog } from "./dialogs.js";
const PER_FOLDER = 500, TOTAL = 5000;
async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

const pxIcon = (name, text) => (style("agency") ? svg(`mods/prodsovet/art/px/${name}.svg`).size(15) : text);
// The shared "selected" look (as on tabs, agents, spaces): a quiet fill in the file's color.
const selectedRow = (el, t, color) => el.bg(color + "24");

export default class Files extends View {
  init(_p, cx) {
    const role = props()?.role;
    if (role) { this.impl = new (role === "menu" ? FileMenu : FileDialog)(); this.impl.init(_p, cx); return; }
    this.h = cx.focus_handle(); this.scroll = ScrollHandle.new();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.saved = new Map(); this.marks = {};
    this.sel = null; this.flat = []; this.revision = shared("files.revision");
    this.filter = InputState.new({ placeholder: L("Filter tree…", "Фильтр дерева…") });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value().toLowerCase(); cx.notify(); });
    this.filter.on("focus", () => { this.filterFocused = true; });
    this.filter.on("blur", () => { this.filterFocused = false; });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => { for (;;) {
      const c = await nextCommand(), name = c?.name ?? c?.command ?? c;
      if (name === "focus") this.h.focus();
      else if (name === "menu") this.menu();
      else if (name === "refresh") this.refresh(cx);
      else if (["rename", "create-file", "create-folder", "trash", "paste", "goto", "duplicate"].includes(name)) this.dialog(name);
      cx.notify();
    } });
  }
  where() { return JSON.stringify(location()); }
  current(c) { return c === this.context && this.where() === c.key; }
  target() {
    const entry = this.flat.find(e => e.path === this.sel);
    return { path: entry ? join(this.root, entry.path) : this.root, dir: entry?.dir ?? true, root: !entry, on: this.on, space: this.context?.space };
  }
  navigate(direction, cx) {
    const selected = this.flat.find(e => e.path === this.sel);
    const next = direction === "up" ? parent(this.root) : selected?.dir ? join(this.root, selected.path) : null;
    if (!this.root || !next || next === this.root) return;
    // Coming back up selects the folder we just left, so Down can return to it.
    this.nextSelection = direction === "up" ? { cwd: next, space: this.context.space, path: basename(this.root) } : null;
    browse(next, this.context.space);
    this.refresh(cx); this.h.focus(); cx.notify();
  }
  menu() { if (this.root) showMenu(this.target()); }
  dialog(action) {
    const t = this.target();
    if (!t.path || (["rename", "trash", "duplicate"].includes(action) && t.root)) return;
    showDialog(t, action);
  }
  async insert(path, cx) {
    const f = focused(), s = spaces().find(s => s.active), tabs = new Set(s?.tabs.map(t => t.id));
    const term = (shared("files.agents") ?? {})[s?.id] || panes().find(p => tabs.has(p.tab) && p.terminal)?.terminal;
    if (!term) return notify({ title: L("No terminal", "Нет терминала"), body: L("Open a terminal in this space", "Откройте терминал в этом пространстве"), level: "warning" });
    const abs = join(this.root, path), text = (/\s/.test(abs) ? `"${abs}"` : `@${abs}`) + " ";
    await pasteInto(term, text);
  }
  key(e, cx) {
    const k = e.keystroke;
    if (this.filterFocused) return;
    const i = this.flat.findIndex(r => r.path === this.sel), cur = this.flat[i];
    if (k === "down" || k === "up") {
      const n = i < 0 ? 0 : Math.max(0, Math.min(this.flat.length - 1, i + (k === "down" ? 1 : -1)));
      this.sel = this.flat[n]?.path; this.scroll.scroll_to_item(n);
    } else if (k === "right" && cur) {
      if (!cur.dir) openFile(join(this.root, cur.path), this.on, this.context.space);
      else if (!this.folders.has(cur.path)) this.toggle(cur.path, cx);
      else this.sel = this.flat[i + 1]?.path ?? cur.path;
    } else if (k === "left" && cur) {
      if (cur.dir && this.folders.has(cur.path)) this.toggle(cur.path, cx);
      else this.sel = cur.path.includes("/") ? cur.path.slice(0, cur.path.lastIndexOf("/")) : null;
    } else if (k === "enter" && cur) cx.spawn(cx => this.insert(cur.path, cx));
    // Cmd on macOS, Ctrl elsewhere; Delete is the Windows Explorer key for the Recycle Bin.
    else if ((k === "cmd-c" || k === "ctrl-c") && cur) clipboard(this.target(), false);
    else if ((k === "cmd-x" || k === "ctrl-x") && cur) clipboard(this.target(), true);
    else if (k === "cmd-v" || k === "ctrl-v") this.dialog("paste");
    else if (k === "cmd-backspace" || k === "delete") this.dialog("trash");
    else if (k === "escape") this.sel = null;
    else return;
    cx.stop_propagation(); cx.notify();
  }
  close() {
    this.context = null;
    this.watcher?.cancel();
  }
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root; const c = this.context;
    cx.spawn(async cx => {
      try {
        while (this.current(c)) {
          this.watcher = watchFolder(root);
          const paths = await this.watcher;
          if (paths.length && this.current(c)) this.refresh(cx);
        }
      }
      catch { if (this.context === c) this.watched = null; }
    });
  }
  async loadFolder(path, c) {
    const entries = await directory(path ? join(c.cwd, path) : c.cwd, c.on);
    if (!this.current(c) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, a]) => n + a.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }
  refresh(cx) {
    const loc = location(), key = JSON.stringify(loc);
    if (this.context?.key !== key) {
      this.watcher?.cancel();
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, sel: this.sel });
      const saved = this.saved.get(key);
      this.context = { ...loc, key }; this.root = loc.cwd; this.on = loc.on;
      this.folders = new Set(saved?.folders);
      this.sel = this.nextSelection?.cwd === loc.cwd && this.nextSelection?.space === loc.space ? this.nextSelection.path : saved?.sel ?? null;
      this.nextSelection = null;
      this.entries = new Map(); this.pending = new Set(); this.watched = null; this.loading = false; this.error = null;
      this.query = ""; this.filter.set_value("");
    }
    if (!this.root) return;
    if (this.loading) { this.refreshAgain = true; return; }
    const c = this.context;
    this.loading = true; this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(c)) return;
          try { await this.loadFolder(path, c); }
          catch (e) { if (!path) throw e; this.folders.delete(path); this.entries.delete(path); }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: c.cwd, on: c.on }).catch(() => null), marks = {};
        if (top?.code === 0) {
          const s = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: c.cwd, on: c.on }).catch(() => null);
          if (s?.code === 0) for (const e of s.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = e.slice(0, 2); marks[join(top.stdout.trim(), e.slice(3))] = xy === "??" || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(c)) return;
        this.marks = marks; this.error = null; this.watch(c.cwd, cx);
      } catch (e) { if (this.current(c)) this.error = String(e); }
      finally { if (this.context === c) { this.loading = false; if (this.refreshAgain) { this.refreshAgain = false; this.refresh(cx); } } cx.notify(); }
    });
  }
  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const p of [...this.folders]) if (p === path || p.startsWith(path + "/")) { this.folders.delete(p); this.entries.delete(p); }
    } else {
      this.folders.add(path);
      const c = this.context;
      cx.spawn(async cx => { try { await this.loadFolder(path, c); } catch (e) { if (this.current(c)) this.error = String(e); } cx.notify(); });
    }
    cx.notify();
  }
  collect(prefix = "", depth = 0, result = []) {
    if (result.length >= TOTAL || depth > 40) return result;
    for (const e of this.entries.get(prefix) ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      result.push({ ...e, path, depth });
      if (e.dir && this.folders.has(path)) this.collect(path, depth + 1, result);
      if (result.length >= TOTAL) break;
    }
    return result;
  }
  render(cx) {
    if (this.impl) return this.impl.render(cx);
    if (this.where() !== this.context?.key || this.revision !== shared("files.revision")) { this.revision = shared("files.revision"); this.refresh(cx); }
    const t = theme(), rows = this.collect();
    this.flat = this.query ? rows.filter(r => r.path.toLowerCase().includes(this.query)) : rows;
    const button = (id, label, fn, enabled = true) => div().id(id).h(25).min_w(24).px(5).flex().items_center().justify_center().rounded(radius(5)).text_color(t.muted)
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
      .when(!enabled, el => el.opacity(0.35)).on_click((e, cx) => { if (enabled) fn(e, cx); }).child(label);
    const selectedFolder = this.flat.find(e => e.path === this.sel && e.dir);
    return v_flex().id("files").track_focus(this.h).on_key_down((e, cx) => this.key(e, cx)).size_full().min_h(0).rounded(radius(10)).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(fontSize("files.body"))
      .child(h_flex().h(metric("files.toolbar")).flex_none().px(10).gap(3).items_center()
        .child(div().flex_1().font_weight(appearance().weights.semibold).when(Boolean(labelFont()), el => el.font_family(labelFont())).child(labelFont() ? L("FILES", "ФАЙЛЫ") : L("Files", "Файлы")))
        .child(button("files-up", pxIcon("up", "↑"), (_e, cx) => this.navigate("up", cx), Boolean(this.root && parent(this.root) !== this.root)))
        .child(button("files-down", pxIcon("down", "↓"), (_e, cx) => this.navigate("down", cx), Boolean(selectedFolder)))
        .child(button("files-add", pxIcon("plus", "+"), () => this.dialog("create-file")))
        .child(button("files-search", pxIcon("search", "⌕"), () => run("mod.open", { name: "find" })))
        .child(button("files-more", pxIcon("more", "⋯"), () => this.menu())))
      .child(div().id("files-path").h(metric("files.path")).flex_none().px(12).truncate().when(Boolean(labelFont()), el => el.font_family(labelFont())).text_size(fontSize("files.meta")).text_color(t.dim).tooltip(this.root ?? "").cursor_pointer()
        .on_click(() => this.dialog("goto")).child((this.on ? this.on + ":" : "") + (this.root ?? L("No folder", "Нет папки"))))
      .child(div().mx(8).mb(5).h(metric("files.filter")).flex_none().child(Input.new(this.filter).w_full().h_full().px(7).rounded(radius(5)).border_1().border_color(t.input).bg(t.background).text_size(fontSize("files.hint"))))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(6)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.sel = null; this.menu(); })
        .children(this.flat.map(e => {
          const selected = this.sel === e.path, open = this.folders.has(e.path), mark = this.marks[join(this.root, e.path)];
          return h_flex().id(`file-${e.path}`).drag_paths([join(this.root, e.path)], { on: this.on }).h(metric("files.row")).flex_none().pl(6 + (this.query ? 0 : e.depth * 16)).pr(5).gap(6).items_center().rounded(radius(6)).cursor_pointer()
            .when(selected && !style("agency"), el => el.bg(t.selected).when(style("selectionBar"), sel => sel.border_l(2).border_color(t.accent).pl(4 + (this.query ? 0 : e.depth * 16))))
            .when(selected && Boolean(style("agency")), el => selectedRow(el, t, kindColor(t, fileKind(e.name, e.dir))))
            .hover(s => s.bg(t.hover))
            .on_mouse_down("right", (_ev, cx) => { cx.stop_propagation(); this.sel = e.path; this.menu(); cx.notify(); })
            .on_click((_ev, cx) => { this.sel = e.path; this.h.focus(); if (e.dir) this.toggle(e.path, cx); else openFile(join(this.root, e.path), this.on, this.context.space); cx.notify(); })
            .child(e.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(10).text_color(t.dim) : div().w(10))
            .child((() => { const g = fileGlyph(t, e.name, e.dir); return svg(g.path).size(g.size).mx(g.size < 14 ? 1 : 0).flex_none().text_color(g.color); })())
            .child(div().flex_1().min_w(0).truncate().tooltip(e.path).child(this.query ? e.path : e.name))
            .when(Boolean(mark), el => el.child(div().text_size(fontSize("files.badge")).text_color(mark === "A" ? t.ansi2 : t.blocked).child(mark)));
        }))
        .when(Boolean(this.error) || !this.flat.length, el => el.child(div().p(8).text_size(fontSize("files.hint")).text_color(t.dim).child(this.error || (this.loading ? L("Loading…", "Загрузка…") : this.query ? L("No matches in the expanded tree", "Нет совпадений в раскрытом дереве") : L("Empty folder", "Папка пуста"))))))
      .when(this.limited, el => el.child(div().p(6).text_size(fontSize("files.badge")).text_color(t.dim).child(L(`Limit: 500 per folder / 5000 total. Search: ${shortcut("⌘⇧O", "Ctrl+Shift+S")}`, `Лимит: 500 в папке / 5000 всего. Поиск: ${shortcut("⌘⇧O", "Ctrl+Shift+S")}`))))
      .when(Boolean(shared("files.clipboard")), el => el.child(div().px(10).py(5).truncate().text_size(fontSize("files.meta")).text_color(t.dim).child(`${shared("files.clipboard")?.cut ? L("Cut", "Вырезано") : L("Copied", "Скопировано")}: ${basename(shared("files.clipboard")?.path)}`)));
  }
}
