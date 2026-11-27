// Finch: review an agent's changes and send notes on exact lines back to it.
//
// The changed files of the space's repository (git status), one file's diff at a
// time. Click a line to write a note on it; the notes collect below. "Send" puts
// them in one message, each with its file, line and the line itself, and types
// it into the chosen agent's terminal (hc send). Nothing is committed or edited.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { theme, spaces, panes, focused, agents, exec, hc, settings, notify, checking, tr } from "finch";
import { parseDiff, message } from "./diff.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_LINES = 3000;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space, cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}

export default class Review extends View {
  init(_props, cx) {
    this.root = null;
    this.files = [];
    this.file = null;
    this.rows = [];
    this.notes = [];
    this.writing = null; // the row a note is being written on
    this.target = null;
    this.note = TextareaState.new({ placeholder: tr("What should change here?"), rows: 3 });
    this.note.on("submit", (_e, cx) => this.addNote(cx));
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => { if (!this.file) this.refresh(cx); });
  }

  refresh(cx) {
    const { cwd, on } = location();
    if (!cwd) return;
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (!top || top.code !== 0) { this.root = null; this.files = []; cx.notify(); return; }
      this.root = top.stdout.trim();
      this.on = on;
      const st = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: this.root, on }).catch(() => null);
      this.files = (st?.stdout ?? "").split("\0").filter(Boolean).map((e) => ({ state: e.slice(0, 2).trim() || "?", path: e.slice(3) }));
      cx.notify();
    });
  }

  open(path, cx) {
    this.file = path;
    this.rows = [];
    this.writing = null;
    cx.spawn(async (cx) => {
      const head = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: this.root, on: this.on }).catch(() => null);
      let r = await exec("git", [...READ, "diff", ...(head?.code === 0 ? ["HEAD"] : []), "--no-ext-diff", "--no-color", "--", path], { cwd: this.root, on: this.on }).catch(() => null);
      let text = r?.stdout ?? "";
      if (!text.trim()) {
        // Untracked: the whole file is new.
        r = await exec("git", [...READ, "diff", "--no-index", "--no-color", "--", "/dev/null", path], { cwd: this.root, on: this.on }).catch(() => null);
        text = r?.stdout ?? "";
      }
      this.rows = parseDiff(text).slice(0, MAX_LINES);
      cx.notify();
    });
  }

  addNote(cx) {
    const text = this.note.value().trim();
    if (!text || !this.writing) return;
    const row = this.writing;
    this.notes.push({ file: this.file, line: row.line, old: Boolean(row.old), code: row.text, note: text });
    this.note.set_value("");
    this.writing = null;
    cx.notify();
  }

  // Agents in this space, the focused one first.
  candidates() {
    const space = spaces().find((s) => s.active);
    const here = agents().filter((a) => a.space === space?.id);
    const f = focused()?.terminal;
    return here.sort((a, b) => (b.address === f) - (a.address === f));
  }

  send(cx) {
    const list = this.candidates();
    const to = this.target && list.some((a) => a.address === this.target) ? this.target : list[0]?.address ?? focused()?.terminal;
    if (!to) return notify({ title: "No agent in this space", body: "Start an agent here, then send the notes.", level: "info" });
    const text = message(this.notes);
    cx.spawn(async (cx) => {
      const r = await hc(["send", to, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) {
        this.notes = [];
        notify({ title: "Notes sent", level: "info" });
      } else notify({ title: "Not sent", body: (r.stderr || r.stdout || "").trim(), level: "error" });
      cx.notify();
    });
  }

  // Drawing ------------------------------------------------------------

  button(t, id, label, onClick, primary) {
    return div().id(id).flex_none().px(9).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  fileList(t) {
    if (!this.root) return div().p(12).text_size(12.5).text_color(t.dim).child("Not a git repository");
    if (!this.files.length) return div().p(12).text_size(12.5).text_color(t.dim).child("No uncommitted changes");
    return v_flex().p(6).gap(2).children(this.files.map((f, i) => h_flex().id(`rv-f-${i}`).px(8).py(5).gap(8).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(f.path, cx))
      .child(div().w(18).flex_none().text_size(11).font_semibold().text_color(f.state.includes("D") ? t.blocked : f.state === "??" || f.state.includes("A") ? t.done : t.working).child(f.state))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(f.path))));
  }

  diff(t) {
    const mono = settings().font_family ?? "JetBrains Mono";
    const noted = new Set(this.notes.filter((n) => n.file === this.file).map((n) => `${n.old ? "o" : "n"}${n.line}`));
    return v_flex().children(this.rows.map((r, i) => {
      if (r.kind === "hunk") return div().px(10).py(3).text_size(11).font_family(mono).text_color(t.dim).bg(t.raised).child(r.text);
      const bg = r.kind === "add" ? t.done + "22" : r.kind === "del" ? t.blocked + "22" : null;
      const key = `${r.old ? "o" : "n"}${r.line}`;
      const row = h_flex().id(`rv-l-${i}`).px(6).gap(8).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(Boolean(bg), (el) => el.bg(bg))
        .on_click((_e, cx) => { this.writing = r; this.note.set_value(""); this.note.focus(); cx.notify(); })
        .child(div().w(40).flex_none().text_right().text_size(11).font_family(mono).text_color(noted.has(key) ? t.accent : t.dim).child(noted.has(key) ? "●" : String(r.line)))
        .child(div().w(12).flex_none().text_size(12).font_family(mono).text_color(t.dim).child(r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "))
        .child(div().flex_1().min_w(0).text_size(12).font_family(mono).text_color(t.foreground).child(r.text || " "));
      if (this.writing !== r) return row;
      return v_flex().child(row).child(v_flex().mx(10).my(6).p(8).gap(6).rounded(8).border_1().border_color(t.accent).bg(t.surface)
        .child(Textarea.new(this.note).h(64))
        .child(h_flex().gap(6).child(div().flex_1())
          .child(this.button(t, "rv-cancel", "Cancel", (_e, cx) => { this.writing = null; cx.notify(); }))
          .child(this.button(t, "rv-add", "Add note", (_e, cx) => this.addNote(cx), true))));
    }));
  }

  render(cx) {
    const t = theme();
    const list = this.candidates();
    const to = this.target && list.some((a) => a.address === this.target) ? this.target : list[0]?.address;
    const toName = list.find((a) => a.address === to);
    const header = h_flex().flex_none().h(40).px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(this.file), (el) => el.child(div().id("rv-back").cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.file = null; this.writing = null; this.refresh(cx); }).child("←")))
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Review"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.file ?? ""));
    const body = v_flex().relative().flex_1().min_h(0)
      .child(div().id("rv-scroll").size_full().overflow_y_scroll().child(this.file ? this.diff(t) : this.fileList(t)))
      .child(Scrollbar.vertical("rv-scroll").absolute().inset_0());
    const footer = v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12.5).text_color(t.foreground).child(this.notes.length ? `${this.notes.length} notes` : "No notes yet"))
        .when(this.notes.length > 0, (el) => el.child(this.button(t, "rv-clear", "Clear", (_e, cx) => { this.notes = []; cx.notify(); })))
        .child(div().flex_1())
        .when(list.length > 1, (el) => el.child(this.button(t, "rv-target", `To: ${toName?.title || toName?.address || "agent"}`, (_e, cx) => {
          const i = list.findIndex((a) => a.address === to);
          this.target = list[(i + 1) % list.length].address;
          cx.notify();
        })))
        .child(this.button(t, "rv-send", list.length === 1 || !list.length ? "Send to agent" : "Send", (_e, cx) => this.send(cx), this.notes.length > 0)));
    return v_flex().id("review").size_full().bg(t.background).child(header).child(body).child(footer);
  }
}
