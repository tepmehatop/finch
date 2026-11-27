import { appearance, fontSize, metric, radius, L, style } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// A file as its own tab, next to the terminal tabs.
// Opened by find and my-files: run("tab.new", { name, mod: "file-tab", props: { file, on } }).
// Edit and Cmd+S to save; double-click the name to rename the file; "Открыть в" sends it to Obsidian or VS Code.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextView, set_theme } from "gpui-base";
import { props, exec, appHome, watchFolder, readTextFile, writeTextFile, theme, settings, focused, spaces, panes, run, notify, shared, setShared, nextCommand } from "finch";

import { operation, isLocked, activeDocuments, workspace, fileGlyph, basename, parent, samePath, native, isWindowsPath, tilde, onMac, openExternal, shortcut } from "./filesystem.js";
import { MdPreview } from "./md-preview.js";

const LANG = { ts: "js", tsx: "js", mjs: "js", cjs: "js", jsx: "js", js: "js", json: "json", jsonc: "json", md: "markdown", markdown: "markdown", py: "python", sh: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "yaml", html: "html", css: "css", rs: "rust", go: "go", vue: "html", svelte: "html" };
const base = (p) => isWindowsPath(p) ? basename(p) : p.split("/").pop();

// The editor paints its selection with Base's "accent" at ~39% opacity, and Finch maps
// accent to the theme's hover color, so on dark themes the selection is invisible.
// Pick an accent that, at that opacity over the background, lands on the theme's "selection".
const SEL_ALPHA = 0.39;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function selectionAccent(t) {
  if (!/^#[0-9a-f]{6}/i.test(t.selection ?? "") || !/^#[0-9a-f]{6}/i.test(t.background ?? "")) return null;
  const bg = hex(t.background), sel = hex(t.selection);
  return "#" + bg.map((b, i) => Math.max(0, Math.min(255, Math.round(b + (sel[i] - b) / SEL_ALPHA))).toString(16).padStart(2, "0")).join("");
}
const OPEN_IN = [
  { id: "code", label: "VS Code", app: "Visual Studio Code", bundle: "com.microsoft.VSCode", icon: "mods/file-tab/code.svg" },
  { id: "obsidian", label: "Obsidian", app: "Obsidian", bundle: "md.obsidian", icon: "mods/file-tab/notes.svg" },
];
// The real app icons are not shipped: each is read from the app installed on
// this Mac and converted once to a PNG in this mod's folder (app-icons/).
// Without the app (or on failure) the neutral badge stays.
const APP_ICONS = "mods/file-tab/app-icons";
const ICON_SCRIPT = `set -e
app=$(mdfind "kMDItemCFBundleIdentifier == '$1'" 2>/dev/null | head -n 1)
[ -d "$app" ] || app="/Applications/$2.app"
[ -d "$app" ] || exit 3
icon=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$app/Contents/Info.plist")
case "$icon" in *.icns) ;; *) icon="$icon.icns" ;; esac
src="$app/Contents/Resources/$icon"
[ -f "$src" ] || exit 4
mkdir -p "$(dirname "$3")"
[ "$3" -nt "$src" ] || sips -s format png -Z 64 "$src" --out "$3" >/dev/null`;
let appIcons = null;
function loadAppIcons() {
  // Converting app icons needs macOS tools; elsewhere the neutral badges stay.
  if (!onMac()) return Promise.resolve({});
  appIcons ??= Promise.all(OPEN_IN.map(async (a) => {
    const rel = `${APP_ICONS}/${a.id}.png`;
    const r = await exec("sh", ["-c", ICON_SCRIPT, "app-icon", a.bundle, a.app, `${appHome()}/${rel}`], { timeout: 15000 }).catch(() => null);
    return [a.id, r?.code === 0 ? rel : null];
  })).then(Object.fromEntries);
  return appIcons;
}

export default class FileTab extends View {
  init(p, cx) {
    const pr = { ...(p ?? {}), ...(props() ?? {}) };
    this.file = pr.file; this.on = pr.on ?? null;
    this.appIcons = null;
    this.pr = pr;
    const allSpaces = spaces();
    this.tab = this.resolveTab(pr);
    this.space = pr.space || allSpaces.find(s => s.tabs.some(t => t.id === this.tab))?.id || focused()?.space;
    const document = (shared("files.documents") ?? {})[this.tab];
    if (document && document.on === this.on) { this.file = document.file; this.removed = document.removed; }
    else this.file = localStorage.getItem("file") || this.file;
    localStorage.setItem("tab", this.tab ?? "");
    workspace(this.space);
    this.h = cx.focus_handle();
    this.code = null; this.original = null; this.preview = Boolean(pr.preview); this.renaming = null; this.openMenu = Boolean(pr.menu);
    this.ext = (this.file?.includes(".") ? this.file.split(".").pop() : "txt").toLowerCase();
    this.register();
    if (!this.tab) this.retryTab(cx);
    if (!this.file) { this.error = L("No file path", "Нет пути к файлу"); return; }
    this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const name = c?.name ?? c?.command ?? c;
        if (name === "save") await this.save(cx);
        else if (name === "focus") this.h.focus();
        cx.notify();
      }
    });    // Last, so the file's own load stays the first task.
    cx.spawn(async (cx) => { this.appIcons = await loadAppIcons(); cx.notify(); });
  }

  // The tab this editor lives in: its own pane is a file-tab pane in that tab.
  resolveTab(pr) {
    const allSpaces = spaces(), allPanes = panes();
    const validTab = id => allSpaces.some(s => (!pr.space || s.id === pr.space) && s.tabs.some(t => t.id === id)) && allPanes.some(p => p.tab === id && p.mod === "file-tab");
    const remembered = localStorage.getItem("tab");
    const previous = (shared("file-tab.open") ?? {})[pr.file];
    // A tab another file's editor already owns is never taken: a new file tab
    // can mount while the previous file's tab still has the focus.
    const docs = shared("files.documents") ?? {};
    const free = id => !docs[id] || (docs[id].file === pr.file && (docs[id].on ?? null) === this.on);
    const candidates = allSpaces.flatMap(s => s.tabs.filter(t => t.name === base(pr.file) && validTab(t.id) && free(t.id) && (!pr.space || s.id === pr.space)));
    const focusedTab = validTab(focused()?.tab) && free(focused().tab) ? focused().tab : null;
    return (validTab(remembered) ? remembered : candidates.length === 1 ? candidates[0].id : pr.space && focusedTab ? focusedTab : validTab(previous) && !docs[previous] ? previous : focusedTab) || null;
  }

  // Finch can start this copy before panes() lists its new pane (seen on
  // Windows). Without a tab the document is never registered, so renames,
  // moves and Trash would not reach this editor. Look again for a few seconds.
  retryTab(cx, tries = 0) {
    cx.timer.after(200, (cx) => {
      if (this.tab || this.closed) return;
      const tab = this.resolveTab(this.pr);
      if (!tab) { if (tries < 25) this.retryTab(cx, tries + 1); return; }
      this.tab = tab;
      this.space = this.pr.space || spaces().find(s => s.tabs.some(t => t.id === tab))?.id || this.space;
      localStorage.setItem("tab", tab);
      this.register();
      cx.notify();
    });
  }

  // file -> tab id, so opening the same file again just shows its tab
  register(old) {
    const map = { ...(shared("file-tab.open") ?? {}) };
    if (old) delete map[old];
    if (this.file && this.tab) map[this.file] = this.tab;
    setShared("file-tab.open", map);
    this.publish();
  }

  publish() {
    if (!this.tab) return;
    const all = activeDocuments(), old = all[this.tab];
    const next = { file: this.file, on: this.on, space: this.space, dirty: this.dirty(), saving: Boolean(this.saving), removed: Boolean(this.removed) };
    if (JSON.stringify(old) !== JSON.stringify(next)) setShared("files.documents", { ...all, [this.tab]: next });
    localStorage.setItem("file", this.file);
  }

  snapshot() {
    this.publish();
    if (this.dirty()) localStorage.setItem("draft", JSON.stringify({ file: this.file, original: this.original, text: this.code.value() }));
    else localStorage.removeItem("draft");
  }

  syncDocument() {
    const document = (shared("files.documents") ?? {})[this.tab];
    if (!document || document.on !== this.on) return;
    if (document.file !== this.file) {
      this.file = document.file;
      this.ext = (this.file.includes(".") ? this.file.split(".").pop() : "txt").toLowerCase();
      localStorage.setItem("file", this.file);
    }
    this.removed = Boolean(document.removed);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const file = this.file;
        const text = await readTextFile(file, { on: this.on });
        this.syncDocument();
        if (file !== this.file) { this.load(cx); return; }
        this.applySelection(cx);
        if (text === null) this.error = L("The file is missing or larger than 1 MB", "Файла нет или он больше 1 МБ");
        else if (text.includes("\0")) this.error = L("Binary file, cannot show as text", "Бинарный файл, текстом не показать");
        else {
          const t = theme();
          this.editable = !this.on; this.original = text;
          let draft;
          try { draft = JSON.parse(localStorage.getItem("draft") ?? "null"); } catch {}
          if (draft?.file === this.file) this.original = draft.original;
          this.code = this.makeEditor(draft?.file === this.file ? draft.text : text);
          this.publish();
          this.watchDisk(cx);
        }
      } catch (e) { this.error = L(`Could not open: ${e}`, `Не открылся: ${e}`); }
      cx.notify();
    });
  }

  // One monitor per open document. Replacing it invalidates pending reads and timers.
  watchDisk(cx) {
    const file = this.removed || !this.code ? null : this.file;
    if (this.closed) return;
    if (this.disk?.file === file && !(this.disk.missed && !this.saving && !this.dirty())) return;
    this.disk?.watch?.cancel();
    this.disk = null;
    if (!file) return;
    const disk = this.disk = { file };
    const dir = parent(file);
    const current = () => this.disk === disk && !this.closed && !this.removed && this.file === file;
    const reload = async cx => {
      if (!current()) return;
      if (this.dirty() || this.saving) { disk.missed = true; return; }
      const editor = this.code, original = this.original;
      const text = await readTextFile(file, { on: this.on }).catch(() => null);
      if (!current()) return;
      if (editor !== this.code || this.original !== original || this.dirty() || this.saving) {
        disk.missed = true;
        cx.notify();
        return;
      }
      if (text === null || text === original || text.includes("\0")) return;
      this.original = text;
      this.code = this.makeEditor(text);
      editor.release();
      this.publish();
      cx.notify();
    };
    const monitor = async cx => {
      // Arm the next watch before reading, so edits during a slow read are delivered.
      let refresh = true;
      while (current()) {
        let batch;
        if (!this.on) {
          try {
            disk.watch = watchFolder(dir);
            batch = disk.watch.catch(() => null);
          } catch { /* Retry after the fallback interval. */ }
        }
        if (refresh) await reload(cx);
        const paths = batch && await batch;
        if (!current()) return;
        if (!paths?.length) {
          cx.timer.after(5000, cx => { if (current()) cx.spawn(monitor); });
          return;
        }
        refresh = paths.some(path => samePath(path, file) || samePath(path, dir));
      }
    };
    cx.spawn(monitor);
  }

  editorOptions() {
    const t = theme();
    return {
      language: LANG[this.ext] ?? this.ext, readonly: !this.editable, soft_wrap: true,
      line_numbers: !["md", "markdown", "txt"].includes(this.ext),
      font_family: appearance().fonts.editor, font_size: fontSize("fileTab.editor"),
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    };
  }

  makeEditor(value) {
    const options = this.editorOptions();
    const editor = EditorState.new({ ...options, value });
    editor.on("change", (_e, cx) => { this.snapshot(); cx.notify(); });
    this.editorStyle = JSON.stringify(options);
    return editor;
  }

  refreshEditorStyle(cx) {
    if (!this.code || this.saving || this.restyleQueued || JSON.stringify(this.editorOptions()) === this.editorStyle) return;
    this.restyleQueued = true;
    cx.spawn(async cx => {
      try {
        // Native editor style is fixed on creation. Rebuild only when styling
        // actually differs, retaining the text, original snapshot and dirty flag.
        await exec("true", []);
        if (this.closed || !this.code || this.saving) return;
        const old = this.code;
        this.code = this.makeEditor(old.value());
        old.release();
        this.snapshot();
      } finally { this.restyleQueued = false; cx.notify(); }
    });
  }

  // set_theme is only legal in an event handler or a task right after a host call.
  // Finch resets Base tokens on its own (opening tabs, etc.) and cx.theme() can lag behind,
  // so a press or Shift in the editor re-applies it unconditionally (force).
  applySelection(cx, force) {
    const t = theme(), accent = selectionAccent(t);
    this.selKey = `${t.background}/${t.selection}`;
    if (!accent) return;
    try {
      const th = cx.theme();
      if (!force && th.colors.accent === accent) return;
      set_theme({ appearance: th.appearance, tokens: { colors: { ...th.colors, accent }, spacing: th.spacing, radius: th.radius } });
    } catch (e) { console.log("file-tab: selection color not applied", e); }
  }

  dirty() { return Boolean(this.code && this.editable && this.code.value() !== this.original); }

  async save(cx) {
    this.syncDocument();
    if (this.removed || isLocked(this.file)) { notify({ title: L("Not saved", "Не сохранено"), body: this.removed ? L("The file is in the Trash", "Файл находится в корзине") : L("Wait for the file operation", "Дождитесь файловой операции"), level: "warning" }); return; }
    if (!this.dirty() || this.saving) return;
    const text = this.code.value();
    this.saving = true; this.publish(); cx.notify();
    try { await writeTextFile(this.file, text, this.original); this.original = text; this.saveError = null; }
    catch (e) { this.saveError = L("The file changed on disk, not saved", "Файл изменился на диске, не сохранено"); }
    this.saving = false; this.snapshot(); cx.notify();
  }

  startRename(cx) {
    if (this.on) return notify({ title: L("File on another machine", "Файл на другой машине"), body: L("Only a local file can be renamed", "Переименовать можно только локальный файл"), level: "warning" });
    this.renaming = InputState.new({ value: base(this.file) });
    this.renaming.on("submit", (_e, cx) => this.rename(cx));
    this.renaming.focus();
    cx.notify();
  }

  async rename(cx) {
    const name = this.renaming?.value();
    this.renaming?.release(); this.renaming = null;
    if (!name || name === base(this.file)) return cx.notify();
    try {
      this.syncDocument();
      await operation({ action: "rename", path: this.file, on: this.on }, name);
      this.syncDocument(); this.publish();
    } catch (e) { notify({ title: L("Not renamed", "Не переименован"), body: String(e.message ?? e), level: "error" }); }
    cx.notify();
  }

  async openIn(a) {
    let r;
    if (!onMac()) {
      // Both apps register a link handler on Windows: vscode://file/C:/x.md, obsidian://open?path=...
      const link = a.id === "obsidian" ? `obsidian://open?path=${encodeURIComponent(this.file)}` : `vscode://file/${encodeURI(native(this.file).replace(/\\/g, "/"))}`;
      try { await openExternal(link); }
      catch (e) { notify({ title: L(`Could not open in ${a.label}`, `Не открылось в ${a.label}`), body: String(e.message ?? e), level: "error" }); }
      return;
    }
    if (a.id === "obsidian") r = await exec("open", [`obsidian://open?path=${encodeURIComponent(this.file)}`]);
    else r = await exec("open", ["-a", a.app, this.file]);
    if (r.code !== 0) notify({ title: L(`Could not open in ${a.label}`, `Не открылось в ${a.label}`), body: r.stderr.trim(), level: "error" });
  }

  async close() {
    this.closed = true;
    this.disk?.watch?.cancel();
    this.syncDocument();
    if (panes().some(p => p.tab === this.tab && p.mod === "file-tab")) {
      // Hot reload or application quit: retain the path and unsaved buffer.
      this.snapshot();
    } else {
      const docs = activeDocuments(); delete docs[this.tab]; setShared("files.documents", docs);
      const map = { ...(shared("file-tab.open") ?? {}) };
      if (map[this.file] === this.tab) { delete map[this.file]; setShared("file-tab.open", map); }
    }
  }

  // Markdown preview. On macOS the pictures are drawn too (relative paths, ~/, file://, https://).
  markdownPreview(cx) {
    const text = this.code.value();
    if (!onMac(this.on) || isWindowsPath(this.file)) return TextView.markdown("ft-md-view", text);
    const dir = this.file.slice(0, this.file.lastIndexOf("/")) || "/";
    if (!this.mdp || this.mdp.dir !== dir) this.mdp = new MdPreview(dir, this.on);
    return this.mdp.render(text, cx);
  }

  render(cx) {
    this.syncDocument();
    this.watchDisk(cx);
    this.refreshEditorStyle(cx);
    const t = theme(), md = ["md", "markdown"].includes(this.ext);
    // theme switched (light/dark, another theme): re-derive the selection color
    if (this.code && this.selKey !== `${t.background}/${t.selection}`) {
      this.selKey = `${t.background}/${t.selection}`;
      cx.spawn(async (cx) => { await exec("true", []); this.applySelection(cx); cx.notify(); });
    }
    const btn = (id, label, on, active) => div().id(id).px(8).py(3).rounded(radius(6)).text_size(fontSize("fileTab.action")).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .when(style("agency"), (el) => el.font_family(appearance().fonts.mono))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(on).child(label);
    const dir = !this.file ? "" : isWindowsPath(this.file) ? tilde(parent(this.file)) : this.file.slice(0, this.file.lastIndexOf("/")).replace(/^\/Users\/[^/]+/, "~");

    return v_flex().id("file-tab").relative().track_focus(this.h).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(fontSize("fileTab.body"))
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.openMenu) { this.openMenu = false; cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.renaming) { this.renaming.release(); this.renaming = null; cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(metric("fileTab.toolbar")).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child((() => { const g = fileGlyph(t, this.file ? base(this.file) : "", false); return svg(g.path).size(g.size).flex_none().text_color(g.color === t.muted ? t.dim : g.color); })())
        .child(this.renaming
          ? h_flex().w(320).h(metric("fileTab.input")).px(8).rounded(radius(6)).border_1().border_color(t.accent).bg(t.background).items_center()
              .child(Input.new(this.renaming).flex_1().h_full().text_size(fontSize("fileTab.body")).text_color(t.foreground))
          : div().id("ft-name").when(Boolean(this.file) && !this.removed, el => el.drag_paths([this.file], { on: this.on })).flex_none().max_w(360).truncate().font_weight(appearance().weights.semibold).cursor_pointer().rounded(radius(5)).px(4)
              .hover((s) => s.bg(t.hover)).on_click((e, cx) => { if (e.click_count >= 2) this.startRename(cx); })
              .child((this.dirty() ? "● " : "") + (this.file ? base(this.file) : "")))
        .child(div().flex_1().min_w(0).truncate().text_size(fontSize("fileTab.meta")).text_color(t.dim).child((this.on ? `${this.on}:` : "") + dir))
        .when(Boolean(this.saveError), (el) => el.child(div().text_size(fontSize("fileTab.meta")).text_color(t.blocked).child(this.saveError)))
        .when(md && Boolean(this.code), (el) => el
          .child(btn("ft-edit", L("Text", "Текст"), (_e, cx) => { this.preview = false; cx.notify(); }, !this.preview))
          .child(btn("ft-prev", L("Preview", "Превью"), (_e, cx) => { this.preview = true; cx.notify(); }, this.preview)))
        .when(Boolean(this.code) && this.editable && !this.removed, (el) => el.child(btn("ft-save", this.saving ? L("Saving…", "Сохраняю…") : this.dirty() ? L(`Save ${shortcut("⌘S", "Ctrl+S")}`, `Сохранить ${shortcut("⌘S", "Ctrl+S")}`) : L("Saved", "Сохранено"), (_e, cx) => this.save(cx), this.dirty())))
        .when(Boolean(this.code) && !this.editable, (el) => el.child(div().text_size(fontSize("fileTab.hint")).text_color(t.dim).child(L("read only", "только чтение"))))
        .when(!this.on, (el) => el.child(btn("ft-open", L("Open in ▾", "Открыть в ▾"), (_e, cx) => { this.openMenu = !this.openMenu; cx.notify(); }, this.openMenu))))
      .when(Boolean(this.removed), el => el.child(div().px(14).py(8).text_color(t.blocked).child(L("The file was moved to the Trash. The tab keeps its contents for viewing.", "Файл перемещён в корзину. Содержимое вкладки сохранено для просмотра."))))
      .child(this.code
        ? (this.preview
          ? div().id("ft-md").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(18).child(this.markdownPreview(cx))
          : div().id("ft-editor").flex_1().min_h(0).px(6)
              .on_mouse_down("left", (_e, cx) => this.applySelection(cx, true))
              .on_modifiers_changed((e, cx) => { if (e.modifiers?.shift) this.applySelection(cx, true); })
              .child(Editor.new(this.code).size_full()))
        : div().p(16).text_color(this.error ? t.blocked : t.dim).child(this.error ?? L("Opening…", "Открываю…")))
      // the "Открыть в" dropdown: a small box under the button, over the text
      .when(this.openMenu && !this.on, (el) => el.child(
        v_flex().id("ft-menu").absolute().top(38).right(12).w(170).p(4).gap(2)
          .rounded(radius(9)).border_1().border_color(t.border).bg(t.popover).shadow_lg()
          .on_mouse_down_out((_e, cx) => { this.openMenu = false; cx.notify(); })
          .children(OPEN_IN.map((a) => h_flex().id(`ft-in-${a.id}`).h(metric("fileTab.menuRow")).px(8).gap(9).items_center().rounded(radius(6)).cursor_pointer()
            .text_size(fontSize("fileTab.body")).text_color(t.foreground).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.openMenu = false; this.openIn(a); cx.notify(); })
            .child(this.appIcons?.[a.id] ? image(this.appIcons[a.id]).size(18).flex_none() : svg(a.icon).size(18).flex_none())
            .child(a.label)))));
  }
}
