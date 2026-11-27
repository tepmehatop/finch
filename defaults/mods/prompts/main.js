// Finch: a prompt library and instructions for every agent.
//
// Prompts: saved texts with a search and stars. Send one to the focused agent's
// terminal, or put it in an open chat's composer.
// Instructions: one text Finch keeps in each agent's global instructions file
// (Claude Code, GigaCode CLI, Qwen Code, Codex), between Finch's markers, so
// the rest of the file stays the person's.
// Everything is in ~/.config/finch/prompts.json; nothing leaves the computer.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { theme, appHome, home, readTextFile, writeTextFile, focused, hc, exec, setShared, notify, checking } from "finch";

const START = "<!-- finch:instructions -->";
const END = "<!-- /finch:instructions -->";
// [agent, its global instructions file, the folder that says it's installed]
const TARGETS = [
  ["Claude Code", ".claude/CLAUDE.md", ".claude"],
  ["GigaCode", ".gigacode/GIGACODE.md", ".gigacode"],
  ["Qwen Code", ".qwen/QWEN.md", ".qwen"],
  ["Codex", ".codex/AGENTS.md", ".codex"],
];

function withBlock(text, block) {
  const body = block.trim() ? `${START}\n${block.trim()}\n${END}` : "";
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a !== -1 && b > a) {
    const out = (text.slice(0, a) + body + text.slice(b + END.length)).replace(/\n{3,}/g, "\n\n");
    return body ? out : out.replace(/\s*$/, "\n");
  }
  if (!body) return text;
  return text ? `${text.replace(/\s*$/, "")}\n\n${body}\n` : `${body}\n`;
}

export default class Prompts extends View {
  init(_props, cx) {
    this.tab = "prompts";
    this.data = { prompts: [], instructions: "" };
    this.raw = null;
    this.editing = null; // { id?, title, text } while the form is open
    this.status = {};
    this.search = InputState.new({ placeholder: "Search prompts" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.title = InputState.new({ placeholder: "Title" });
    this.body = TextareaState.new({ placeholder: "Prompt text", rows: 6 });
    this.instructions = TextareaState.new({ placeholder: "Rules every agent follows on this computer: language, code style, what never to do…", rows: 10 });
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.load();
      this.instructions.set_value(this.data.instructions ?? "");
      cx.notify();
    });
  }

  file() {
    return `${appHome()}/prompts.json`;
  }

  async load() {
    this.raw = await readTextFile(this.file()).catch(() => null);
    try {
      const d = JSON.parse(this.raw ?? "{}");
      this.data = { prompts: Array.isArray(d.prompts) ? d.prompts : [], instructions: d.instructions ?? "" };
    } catch {
      this.data = { prompts: [], instructions: "" };
    }
  }

  async store() {
    const text = JSON.stringify(this.data, null, 2) + "\n";
    try {
      await writeTextFile(this.file(), text, this.raw);
      this.raw = text;
    } catch (e) {
      notify({ title: "Not saved", body: String(e?.message ?? e), level: "error" });
      await this.load();
    }
  }

  save(cx) {
    const title = this.title.value().trim(), text = this.body.value().trim();
    if (!text) return;
    const e = this.editing;
    const id = e?.id ?? `p${Date.now()}`;
    const rest = this.data.prompts.filter((p) => p.id !== id);
    const old = this.data.prompts.find((p) => p.id === id);
    this.data.prompts = [{ ...old, id, title: title || text.split("\n")[0].slice(0, 60), text, starred: old?.starred ?? false }, ...rest];
    this.editing = null;
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  edit(p, cx) {
    this.editing = p ? { ...p } : { title: "", text: "" };
    this.title.set_value(p?.title ?? "");
    this.body.set_value(p?.text ?? "");
    cx.notify();
  }

  update(id, change, cx) {
    this.data.prompts = this.data.prompts.map((p) => (p.id === id ? { ...p, ...change } : p));
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  remove(id, cx) {
    this.data.prompts = this.data.prompts.filter((p) => p.id !== id);
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  send(p, cx) {
    const t = focused()?.terminal;
    if (!t) return notify({ title: "No terminal is focused", body: "Click an agent's terminal, then send again.", level: "info" });
    this.update(p.id, { used: (p.used ?? 0) + 1 }, cx);
    cx.spawn(async () => { await hc(["send", t, p.text]).catch(() => null); });
  }

  toChat(p, cx) {
    // The chat mod picks this up and puts it in its composer.
    setShared("finch.chat.insert", { text: p.text, at: Date.now() });
    this.update(p.id, { used: (p.used ?? 0) + 1 }, cx);
  }

  apply(cx) {
    const block = this.instructions.value();
    this.data.instructions = block;
    cx.spawn(async (cx) => {
      await this.store();
      for (const [name, rel, dir] of TARGETS) {
        // Only for agents installed here: their folder exists (the file may not yet).
        const installed = (await exec("test", ["-d", `${home()}/${dir}`]).catch(() => ({ code: 1 }))).code === 0;
        if (!installed) { this.status[name] = "not installed"; continue; }
        const path = `${home()}/${rel}`;
        const before = await readTextFile(path).catch(() => null);
        const next = withBlock(before ?? "", block);
        if (next === (before ?? "")) { this.status[name] = "up to date"; continue; }
        try {
          await writeTextFile(path, next, before);
          this.status[name] = "written";
        } catch (e) {
          this.status[name] = `not written: ${e?.message ?? e}`;
        }
      }
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

  tabButton(t, id, label) {
    const on = this.tab === id;
    return div().id(`pr-tab-${id}`).px(10).py(4).rounded(6).text_size(12.5).cursor_pointer()
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); })
      .child(label);
  }

  promptsTab(t) {
    if (this.editing) {
      return v_flex().p(12).gap(8)
        .child(div().rounded(6).border_1().border_color(t.input).px(8).py(4).child(Input.new(this.title)))
        .child(div().rounded(6).border_1().border_color(t.input).px(8).py(6).child(Textarea.new(this.body).h(180)))
        .child(h_flex().gap(6).child(div().flex_1())
          .child(this.button(t, "pr-cancel", "Cancel", (_e, cx) => { this.editing = null; cx.notify(); }))
          .child(this.button(t, "pr-save", "Save", (_e, cx) => this.save(cx), true)));
    }
    const q = this.search.value().trim().toLowerCase();
    const list = this.data.prompts
      .filter((p) => !q || `${p.title}\n${p.text}`.toLowerCase().includes(q))
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (b.used ?? 0) - (a.used ?? 0));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().p(10).gap(6).items_center()
        .child(div().flex_1().rounded(6).border_1().border_color(t.input).px(8).py(4).child(Input.new(this.search)))
        .child(this.button(t, "pr-new", "New", (_e, cx) => this.edit(null, cx), true)))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(v_flex().id("pr-list").size_full().overflow_y_scroll().px(10).pb(10).gap(6)
          .when(!list.length, (el) => el.child(div().p(8).text_size(12.5).text_color(t.dim).child(this.data.prompts.length ? "No prompts match" : "No prompts yet. New saves one.")))
          .children(list.map((p) => v_flex().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface)
            .child(h_flex().gap(6).items_center()
              .child(div().id(`pr-star-${p.id}`).cursor_pointer().text_color(p.starred ? t.accent : t.dim).on_click((_e, cx) => this.update(p.id, { starred: !p.starred }, cx)).child(p.starred ? "★" : "☆"))
              .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(p.title)))
            .child(div().text_size(12).text_color(t.muted).child(p.text.length > 220 ? `${p.text.slice(0, 220)}…` : p.text))
            .child(h_flex().gap(6)
              .child(this.button(t, `pr-send-${p.id}`, "Send to agent", (_e, cx) => this.send(p, cx), true))
              .child(this.button(t, `pr-chat-${p.id}`, "To chat", (_e, cx) => this.toChat(p, cx)))
              .child(div().flex_1())
              .child(this.button(t, `pr-edit-${p.id}`, "Edit", (_e, cx) => this.edit(p, cx)))
              .child(this.button(t, `pr-del-${p.id}`, "Delete", (_e, cx) => this.remove(p.id, cx)))))))
        .child(Scrollbar.vertical("pr-list").absolute().inset_0()));
  }

  instructionsTab(t) {
    return v_flex().p(12).gap(10)
      .child(div().text_size(12.5).text_color(t.muted).child("Finch writes this text into each agent's global instructions file, between its own markers. The rest of each file stays as it is; an empty text removes Finch's part."))
      .child(div().rounded(6).border_1().border_color(t.input).px(8).py(6).child(Textarea.new(this.instructions).h(220)))
      .child(h_flex().gap(6).child(div().flex_1()).child(this.button(t, "pr-apply", "Apply to agents", (_e, cx) => this.apply(cx), true)))
      .children(TARGETS.map(([name, rel]) => h_flex().gap(8).text_size(12)
        .child(div().w(100).text_color(t.foreground).child(name))
        .child(div().flex_1().truncate().text_color(t.dim).child(`~/${rel}`))
        .child(div().text_color(this.status[name] === "written" ? t.done : t.dim).child(this.status[name] ?? ""))));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("prompts").size_full().bg(t.background)
      .child(h_flex().flex_none().h(40).px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tabButton(t, "prompts", "Prompts"))
        .child(this.tabButton(t, "instructions", "Instructions")))
      .child(this.tab === "prompts" ? this.promptsTab(t) : this.instructionsTab(t));
  }
}
