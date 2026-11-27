import { appearance, fontSize, metric, radius, labelFont, style, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Derived from Finch App's stock "changes" mod (Apache-2.0): the profile's
// typography and radii, status colors (added mint, modified orange, deleted or
// conflicted coral), tinted selection, pixel icons and EN/RU strings.
// Commit messages are prefilled from a read-only snapshot; manual edits win.
import { div, svg } from "gpui-kit";
import { fileGlyph, python } from "./filesystem.js";
import { CommitSuggestion, changesShown as shownIn } from "./commit-suggestion.js";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, appHome, layout, window } from "finch";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const changesShown = () => shownIn(layout(), window());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export class Changes {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.messageOrigin = "empty"; this.handle = cx.focus_handle();
    this.suggestion = new CommitSuggestion(async (mode, value) => {
      const r = await python([`${appHome()}/mods/prodsovet/commit-message.py`, mode, value], { timeout: 90000 });
      const data = JSON.parse(r.stdout);
      if (r.code || data.error) throw new Error(data.error || "Cannot suggest a commit message");
      return data;
    });
    this.input = InputState.new({ placeholder: L("Commit message", "Сообщение коммита") });
    this.input.on("change", (_e, cx) => {
      const value = this.input.value();
      if (value !== this.message) { this.message = value; this.messageOrigin = "manual"; this.input.set_loading(false); }
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  current(context) {
    return this.context === context && context?.key === key();
  }

  close() {
    this.context = null;
    this.watcher?.cancel();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watcher?.cancel();
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.current(context) && this.watched === root) {
          this.watcher = watchFolder(root);
          const paths = await this.watcher;
          if (paths.length && this.current(context)) this.refresh(cx);
        }
      } catch { /* The periodic refresh retries unavailable watches. */ } finally {
        if (this.context === context && this.watched === root) this.watched = null;
      }
    });
  }

  refresh(cx) {
    const place = location(), { cwd, on } = place, next = JSON.stringify(place);
    if (next !== this.context?.key) {
      this.watcher?.cancel();
      this.watched = null;
      this.suggestion.reset(); this.suggestSeq = (this.suggestSeq ?? 0) + 1;
      this.context = { key: next }; this.root = null; this.files = []; this.open = null;
      this.loading = false;
      this.input.set_loading(false);
      this.setLines([]); this.setMessage("", "empty"); this.error = null; this.note = null; this.closed = false; this.limited = false;
    }
    if (!cwd || this.loading || this.busy) return;
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (!this.current(context)) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = L("Not a git repository", "Не git-репозиторий"); return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (!this.current(context)) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.current(context)) this.setLines([L("Cannot preview this diff (too large or unreadable)", "Diff не показать (слишком большой или нечитаемый)")]); }
        }
        if (this.current(context)) this.suggest(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  suggest(cx) {
    // Hidden: nothing new is asked for. Showing the panel again asks (render).
    if (!changesShown()) return;
    if (!this.root || this.on || !this.files.length || this.messageOrigin === "manual" || this.files.some(f => f.status === "U")) {
      if (!this.files.length || this.on || this.files.some(f => f.status === "U")) { this.suggestion.reset(); this.syncSuggestion(cx); }
      return;
    }
    const seq = this.suggestSeq = (this.suggestSeq ?? 0) + 1;
    const context = this.context, root = this.root;
    cx.timer.after(1500, cx => {
      if (seq !== this.suggestSeq || !this.current(context) || this.messageOrigin === "manual" || this.busy || !changesShown()) return;
      cx.spawn(async cx => this.suggestion.update(root, L("en", "ru"),
        () => this.current(context) && !this.busy,
        () => this.syncSuggestion(cx)));
    });
  }

  setMessage(value, origin) {
    if (this.message === value && this.messageOrigin === origin) return;
    this.message = value; this.messageOrigin = origin; this.input.set_value(value);
  }

  syncSuggestion(cx) {
    if (!this.current(this.context)) return;
    if (this.messageOrigin !== "manual" && !this.busy) {
      if (!this.suggestion.busy && this.suggestion.value) this.setMessage(this.suggestion.value, "auto");
      else if (!this.suggestion.value && this.messageOrigin === "auto") this.setMessage("", "empty");
    }
    this.input.set_loading(this.suggestion.busy && this.messageOrigin !== "manual");
    cx.notify();
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = [L("Cannot preview this file (binary, too large, or unreadable)", "Файл не показать (бинарный, большой или нечитаемый)")];
      else if (text.includes("\0")) lines = [L("Binary file · no text diff", "Бинарный файл · текстового diff нет")];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? L("Binary file changed", "Бинарный файл изменён") : L("No text diff available", "Текстового diff нет")] : all.slice(first);
    }
    if (this.current(context) && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.current(context) && this.open === path) this.note = `${L("Cannot preview this diff", "Diff не показать")}: ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || !this.current(this.context)) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const automatic = this.messageOrigin === "auto", fingerprint = this.suggestion.fingerprint;
    if (automatic && this.suggestion.busy) return;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        if (automatic) {
          const latest = await this.suggestion.call("snapshot", root);
          if (!this.current(context)) return;
          if (latest.fingerprint !== fingerprint || latest.empty || latest.conflict) {
            this.setMessage("", "empty"); this.suggestion.reset();
            this.note = L("Changes updated; refreshing the message", "Изменения обновились; составляю новое сообщение");
            return;
          }
        }
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.current(context)) { this.setMessage("", "empty"); this.suggestion.reset(); }
      } catch (e) { if (this.current(context)) this.note = `${L("Commit failed", "Коммит не прошёл")}: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg((style("agency") === true ? t.done : t.ansi2) + "18")).when(kind === "-", (e) => e.bg((style("agency") === true ? t.blocked : t.ansi1) + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (!this.current(this.context)) this.refresh(cx);
    // Back on screen: catch up on the diff that changed while hidden.
    const shown = changesShown();
    if (shown && this.shown === false && !this.loading) this.suggest(cx);
    this.shown = shown;
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && !(this.messageOrigin === "auto" && this.suggestion.busy));
    const agency = style("agency") === true;
    const tone = (st) => (st === "A" ? t.done : st === "M" ? t.working : t.blocked);
    return v_flex().id("changes").size_full().min_h(0).rounded(radius(10)).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(metric("files.toolbar")).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_weight(appearance().weights.semibold).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(labelFont() ? L("CHANGES", "ИЗМЕНЕНИЯ") : L("Changes", "Изменения")))
        .child(div().px(5).py(1).rounded(radius(4)).border_1().border_color(t.border).text_size(10).text_color(t.muted).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(L(`${this.files.length} files`, `файлов: ${this.files.length}`)))
        .child(div().flex_1()).child(div().text_size(11).text_color(agency ? t.done : t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(agency ? t.blocked : t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const g = fileGlyph(t, name, false);
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(radius(7)).cursor_pointer()
          .when(this.open === f.path, (e) => e.bg(agency ? tone(f.status) + "24" : t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).font_family(appearance().fonts.mono).text_color(agency ? tone(f.status) : f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .when(agency, (e) => e.child(svg(g.path).size(g.size).flex_none().text_color(g.color)))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(agency ? t.done : t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(agency ? t.blocked : t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? L("Loading changes…", "Загружаю изменения…") : this.root ? L("No uncommitted changes", "Незакоммиченных изменений нет") : L("No folder", "Нет папки"))))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(L("Showing the first 1,000 changed files", "Показаны первые 1000 изменённых файлов"))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(L("Select a file to view its changes", "Выбери файл, чтобы увидеть изменения")))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(!this.message && Boolean(this.suggestion.error), e => e.child(
        h_flex().flex_none().px(10).py(6).gap(8).text_size(11)
          .child(div().flex_1().text_color(t.dim).child(L("Could not fill the message", "Не удалось заполнить сообщение")))
          .child(div().id("commit-suggestion-retry").text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.suggestion.tried = null; this.suggestion.error = null; this.suggest(cx); cx.notify(); })
            .child(L("Retry", "Повторить")))))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(radius(8)).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(radius(8)).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? L("Committing…", "Коммичу…") : L("Commit", "Коммит"))));
  }
}
