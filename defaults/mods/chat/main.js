// Finch: an agent's conversation as a formatted chat, beside its terminal.
//
// The agent keeps running in its terminal (in finch-core, so it survives the
// window); this pane reads the agent's own session log and shows it as
// messages: Markdown answers, folded reasoning, tool calls with their results.
// What you type here goes to the terminal with `hc send`.
//
// Long sessions: only the end of the log is read (FIRST bytes), new lines are
// followed from a byte offset, and at most KEEP blocks stay in memory while
// following; "Show earlier" pages back from disk. A 40-hour log costs what is
// on screen, not what is on disk.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, TextView, TextareaState, Textarea } from "gpui-base";
import { theme, props, terminals, agents, hc, run, fileTail, fileBefore, recentFiles, checking, settings, window, tr } from "finch";
import { decodeLines, fold, summary, clip } from "./decode.js";

const KEEP = 300; // blocks held while following the end
const BROWSE = 1500; // the most held while reading back
const FIRST = 768 * 1024; // bytes read when the chat opens
const PAGE = 512 * 1024; // bytes read per "Show earlier"
const FOLLOW = 2 * 1024 * 1024; // the most read per follow tick
const W = (name) => `mods/workspace-chrome/${name}.svg`;

function kindOf(term) {
  const exe = (term?.argv?.[0] ?? "").split("/").pop();
  for (const k of [term?.program?.key, term?.report?.app, exe]) {
    if (k === "claude" || k === "claude-code") return "claude";
    if (k === "gigacode" || k === "gigacode-cli" || k === "gcli") return "gigacode";
    if (k === "qwen" || k === "qwen-code") return "qwen";
  }
  return null;
}

// Where each CLI keeps this folder's session logs; the newest one is the live session.
function locate(kind, cwd) {
  if (!cwd) return { dir: null };
  if (kind === "claude") {
    const dir = `~/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}`;
    const f = recentFiles(dir, ".jsonl", 0, 1)[0];
    return { dir, path: f?.path ?? null };
  }
  const root = kind === "qwen" ? "~/.qwen" : "~/.gigacode";
  const dir = `${root}/projects/${cwd.replace(/\//g, "-")}/chats`;
  const f = recentFiles(dir, ".jsonl", 0, 1)[0];
  if (f) return { dir, path: f.path };
  // Older layout, ~/.<cli>/tmp/<project hash>/chats/: the newest log whose records name this folder.
  for (const c of recentFiles(`${root}/tmp`, ".jsonl", 3, 15)) {
    try {
      const head = fileTail(c.path, 0, 64 * 1024).lines.slice(0, 8);
      const here = head.some((l) => {
        try {
          return JSON.parse(l).cwd === cwd;
        } catch {
          return false;
        }
      });
      if (here) return { dir, path: c.path };
    } catch {}
  }
  return { dir, path: null };
}

export default class Chat extends View {
  init(_props, cx) {
    this.address = props()?.terminal ?? null;
    this.kind = null;
    this.path = null;
    this.blocks = [];
    this.first = 0;
    this.end = 0;
    this.open = new Set();
    this.atEnd = true;
    this.note = null;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: tr("Message the agent… (⌘↵ or Ctrl+↵ sends)"), rows: 3 });
    this.input.on("submit", (_e, cx) => this.send(cx));
    if (checking()) return;
    this.attach();
    this.toEnd();
    cx.timer.every(1200, (cx) => {
      if (window()?.visible === false) return;
      if (this.follow()) cx.notify();
    });
    cx.timer.every(8000, (cx) => {
      if (window()?.visible === false) return;
      if (this.relocate()) cx.notify();
    });
  }

  term() {
    return terminals().find((t) => t.address === this.address) ?? null;
  }

  attach() {
    const term = this.term();
    this.kind = kindOf(term);
    if (!this.kind) {
      this.note = term ? "unsupported" : "no-terminal";
      return;
    }
    const loc = locate(this.kind, term.cwd);
    if (!loc.path) {
      this.note = "waiting";
      return;
    }
    this.load(loc.path);
  }

  load(path) {
    try {
      const r = fileTail(path, null, FIRST);
      this.path = path;
      this.blocks = fold([], decodeLines(this.kind, r.lines, r.start));
      this.first = r.start;
      this.end = r.end;
      this.note = null;
    } catch (e) {
      this.note = "unreadable";
      this.error = String(e?.message ?? e);
    }
  }

  // New lines since the last look. True when something changed.
  follow() {
    if (!this.path) return false;
    let r;
    try {
      r = fileTail(this.path, this.end, FOLLOW);
    } catch {
      return false;
    }
    if (r.size < this.end) {
      // The log was replaced or cut: read its end again.
      this.load(this.path);
      this.toEnd();
      return true;
    }
    if (!r.lines.length) {
      this.end = r.end;
      return false;
    }
    const wasAtEnd = this.isAtEnd();
    fold(this.blocks, decodeLines(this.kind, r.lines, r.start));
    this.end = r.end;
    if (wasAtEnd) {
      if (this.blocks.length > KEEP) {
        this.blocks.splice(0, this.blocks.length - KEEP);
        this.first = this.blocks[0].off;
      }
      this.toEnd();
    }
    return true;
  }

  // A newer log in the same place means a new session (/clear, a restart).
  relocate() {
    if (!this.kind) {
      this.attach();
      return Boolean(this.kind);
    }
    const term = this.term();
    if (!term) return false;
    const loc = locate(this.kind, term.cwd);
    if (!loc.path || loc.path === this.path) return false;
    const before = this.blocks.length;
    this.load(loc.path);
    if (before) this.blocks.unshift({ kind: "note", text: "New session", off: this.first, key: `new-${this.first}` });
    this.toEnd();
    return true;
  }

  earlier() {
    if (!this.path || this.first <= 0 || this.blocks.length >= BROWSE) return;
    try {
      const r = fileBefore(this.path, this.first, PAGE);
      const older = fold([], decodeLines(this.kind, r.lines, r.start));
      this.blocks = older.concat(this.blocks);
      this.first = r.start;
      this.atEnd = false;
    } catch {}
  }

  isAtEnd() {
    try {
      const o = this.scroll.offset();
      const v = this.scroll.viewport_size();
      const c = this.scroll.content_size();
      if (!c.height) return true;
      return o.y + v.height >= c.height - 40;
    } catch {
      return true;
    }
  }

  toEnd() {
    this.atEnd = true;
    // Child 0 is the "Show earlier" row; the blocks follow it.
    this.scroll.scroll_to_item(this.blocks.length);
  }

  send(cx) {
    const text = this.input.value().trim();
    if (!text || !this.address) return;
    this.input.set_value("");
    cx.spawn(async (cx) => {
      await hc(["send", this.address, text]).catch(() => null);
      this.follow();
      this.toEnd();
      cx.notify();
    });
  }

  keys(cx, ...keys) {
    if (!this.address) return;
    cx.spawn(async () => {
      await hc(["keys", this.address, ...keys]).catch(() => null);
    });
  }

  // Pieces ---------------------------------------------------------------

  button(t, id, label, onClick, primary) {
    return div()
      .id(id)
      .px(10)
      .py(4)
      .rounded(7)
      .cursor_pointer()
      .text_size(12.5)
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  mono(t, id, text) {
    return div()
      .w_full()
      .p(8)
      .rounded(6)
      .bg(t.background)
      .text_size(12)
      .font_family(settings().font_family ?? "JetBrains Mono")
      .text_color(t.muted)
      .child(TextView.markdown(id, "```\n" + text.replace(/```/g, "ˋˋˋ") + "\n```").selectable(true));
  }

  block(t, b) {
    const key = b.key;
    if (b.kind === "user") {
      return h_flex()
        .w_full()
        .justify_end()
        .child(div().max_w(640).px(12).py(8).rounded(10).bg(t.raised).border_1().border_color(t.border).text_size(13.5).text_color(t.foreground).child(TextView.markdown(`u-${key}`, b.text).selectable(true)));
    }
    if (b.kind === "assistant") {
      return div().w_full().text_size(13.5).text_color(t.foreground).child(TextView.markdown(`a-${key}`, b.text).selectable(true));
    }
    if (b.kind === "note") {
      return h_flex().w_full().justify_center().child(div().px(10).py(2).rounded(8).bg(t.raised).text_size(11.5).text_color(t.dim).child(b.text));
    }
    const open = this.open.has(key);
    const toggle = (_e, cx) => {
      if (open) this.open.delete(key);
      else this.open.add(key);
      cx.notify();
    };
    if (b.kind === "thinking") {
      return v_flex()
        .w_full()
        .gap(4)
        .child(h_flex().id(`th-${key}`).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.dim).hover((s) => s.text_color(t.muted)).on_click(toggle)
          .child(open ? "▾" : "▸")
          .child("Thinking"))
        .when(open, (el) => el.child(div().pl(14).text_size(12.5).text_color(t.muted).child(TextView.markdown(`t-${key}`, b.text).selectable(true))));
    }
    // A tool call.
    const running = b.result == null;
    const dot = running
      ? svg(W("spinner")).size(11).text_color(t.working).spin(900)
      : div().size(7).rounded(4).bg(b.error ? t.blocked : t.done);
    return v_flex()
      .w_full()
      .rounded(8)
      .border_1()
      .border_color(b.error ? t.blocked : t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .id(`tool-${key}`)
          .px(10)
          .py(6)
          .gap(8)
          .items_center()
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(toggle)
          .child(h_flex().w(12).justify_center().child(dot))
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(b.name ?? "tool"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(summary(b)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸")),
      )
      .when(open, (el) =>
        el.child(
          v_flex()
            .px(10)
            .pb(10)
            .gap(6)
            .child(div().text_size(11).text_color(t.dim).child("Input"))
            .child(this.mono(t, `in-${key}`, clip(JSON.stringify(b.input ?? {}, null, 2), 3000)))
            .when(!running, (el) => el.child(div().text_size(11).text_color(b.error ? t.blocked : t.dim).child(b.error ? "Error" : "Result")).child(this.mono(t, `out-${key}`, b.result || "(empty)"))),
        ),
      );
  }

  empty(t, text) {
    return v_flex().size_full().items_center().justify_center().p(24).gap(8).child(div().max_w(420).text_size(13).text_color(t.muted).text_center().child(text));
  }

  render(cx) {
    const t = theme();
    const term = this.term();
    const agent = agents().find((a) => a.address === this.address);
    const status = agent?.status ?? null;
    const name = term?.program?.name ?? "Agent";
    const statusLabel = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" }[status] ?? null;
    const ended = Boolean(this.address) && !term && this.note !== "no-terminal";
    const statusColor = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.dim;

    const header = h_flex()
      .flex_none()
      .h(38)
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(name))
      .when(Boolean(statusLabel), (el) => el.child(h_flex().gap(5).items_center().child(div().size(6).rounded(3).bg(statusColor)).child(div().text_size(12).text_color(t.muted).child(statusLabel))))
      .child(div().flex_1())
      .when(Boolean(this.path), (el) => el.child(this.button(t, "chat-end", "Latest", (_e, cx) => { this.toEnd(); cx.notify(); })))
      .when(ended, (el) => el.child(div().text_size(12).text_color(t.dim).child("Session ended")))
      .when(Boolean(term), (el) => el.child(this.button(t, "chat-terminal", "Terminal", () => run("pane.focus", { terminal: this.address }))))
      .when(Boolean(props()?.pane), (el) => el.child(this.button(t, "chat-close", "Close", () => run("pane.close", { pane: props().pane }))));

    let body;
    if (ended && !this.blocks.length) body = this.empty(t, "The agent's session has ended. Close this chat, or start the agent again.");
    else if (this.note === "no-terminal") body = this.empty(t, "This chat isn't tied to a terminal. Open it from an agent's terminal with ⌘⇧J (Ctrl+Shift+J).");
    else if (this.note === "unsupported") body = this.empty(t, "Chat view supports Claude Code and GigaCode (and Qwen Code). This terminal runs something else.");
    else if (this.note === "waiting") body = this.empty(t, "Waiting for the agent's session log. It appears after the first message.");
    else if (this.note === "unreadable") body = this.empty(t, `Cannot read the session log: ${this.error ?? ""}`);
    else {
      const more = this.first > 0 && this.blocks.length < BROWSE;
      body = v_flex()
        .relative()
        .flex_1()
        .min_h(0)
        .child(
          v_flex()
            .id("chat-scroll")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(this.scroll)
            .px(14)
            .py(12)
            .gap(12)
            .child(
              h_flex().w_full().justify_center().child(
                more
                  ? this.button(t, "chat-earlier", "Show earlier", (_e, cx) => { this.earlier(); cx.notify(); })
                  : div().text_size(11.5).text_color(t.dim).child(this.first > 0 ? "Older messages are in the log file" : "Start of the session"),
              ),
            )
            .children(this.blocks.map((b) => this.block(t, b))),
        )
        .child(Scrollbar.vertical("chat-scroll").absolute().inset_0());
    }

    const composer = v_flex()
      .flex_none()
      .p(10)
      .gap(8)
      .border_t(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(div().rounded(8).border_1().border_color(t.input).bg(t.background).px(8).py(6).child(Textarea.new(this.input).h(64)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .when(status === "blocked", (el) =>
            el.child(div().text_size(12).text_color(t.blocked).child("Answer:"))
              .child(this.button(t, "chat-k1", "1", (_e, cx) => this.keys(cx, "1")))
              .child(this.button(t, "chat-k2", "2", (_e, cx) => this.keys(cx, "2")))
              .child(this.button(t, "chat-k3", "3", (_e, cx) => this.keys(cx, "3")))
              .child(this.button(t, "chat-esc", "Esc", (_e, cx) => this.keys(cx, "esc"))),
          )
          .child(div().flex_1())
          .when(status === "working", (el) => el.child(this.button(t, "chat-stop", "Stop", (_e, cx) => this.keys(cx, "esc"))))
          .child(this.button(t, "chat-send", "Send", (_e, cx) => this.send(cx), true)),
      );

    return v_flex().id("chat").size_full().bg(t.background).child(header).child(body).child(composer);
  }
}
