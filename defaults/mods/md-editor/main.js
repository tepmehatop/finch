// Finch: a Markdown editor with a formatting toolbar and a live preview.
//
// Props: { file } (absolute path). Without one it offers to open a file.
// The toolbar wraps the selection (bold, italic, code, link...) or starts the
// selected lines (headings, lists, quotes). Cmd+S / Ctrl+S saves; a file
// changed on disk while this has no unsaved edits reloads by itself.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar } from "gpui-base";
import { theme, props, readTextFile, writeTextFile, pickFiles, settings, notify, nextCommand, checking, run } from "finch";

// [id, label shown, what it does to the selection]
const WRAP = { bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], code: ["`", "`"] };
const LINE = { h1: "# ", h2: "## ", h3: "### ", ul: "- ", ol: "1. ", task: "- [ ] ", quote: "> " };
const TOOLS = [
  ["bold", "B", "Bold"], ["italic", "I", "Italic"], ["strike", "S", "Strikethrough"], ["code", "</>", "Inline code"],
  ["|"], ["h1", "H1", "Heading 1"], ["h2", "H2", "Heading 2"], ["h3", "H3", "Heading 3"],
  ["|"], ["ul", "•", "Bulleted list"], ["ol", "1.", "Numbered list"], ["task", "☐", "Checklist"], ["quote", "❝", "Quote"],
  ["|"], ["link", "Link", "Link"], ["block", "```", "Code block"], ["table", "Table", "Table"], ["rule", "—", "Divider"],
];

export default class MdEditor extends View {
  init(_props, cx) {
    this.file = props()?.file ?? null;
    this.saved = "";
    this.text = "";
    this.preview = true;
    this.error = null;
    this.state = EditorState.new({ language: "markdown", value: "", font_family: settings().font_family, syntax: this.syntax() });
    this.state.set_soft_wrap(true);
    this.state.on("change", (_e, cx) => { this.text = this.state.value(); cx.notify(); });
    if (checking()) return;
    if (this.file) this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") await this.save();
        cx.notify();
      }
    });
    // Reload a file another program changed, unless this has unsaved edits.
    cx.timer.every(2000, (cx) => {
      if (!this.file || this.dirty()) return;
      cx.spawn(async (cx) => {
        const text = await readTextFile(this.file).catch(() => null);
        if (text != null && text !== this.saved && !this.dirty()) { this.set(text); cx.notify(); }
      });
    });
  }

  syntax() {
    const t = theme();
    return { heading: t.accent, strong: t.foreground, emphasis: t.ansi5, code: t.ansi2, quote: t.dim, list: t.ansi3, link: t.ansi4 };
  }

  set(text) {
    this.saved = text;
    this.text = text;
    this.state.set_value(text);
  }

  dirty() {
    return this.text !== this.saved;
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file);
        if (text == null) throw new Error("not found");
        this.set(text);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  async save() {
    if (!this.file) return;
    const text = this.state.value();
    try {
      await writeTextFile(this.file, text, this.saved);
      this.saved = text;
      this.text = text;
    } catch (e) {
      notify({ title: "Not saved", body: String(e?.message ?? e), level: "error" });
    }
  }

  open(cx) {
    cx.spawn(async (cx) => {
      const files = await pickFiles({ prompt: "Open" }).catch(() => null);
      if (!files?.length) return;
      this.file = files[0];
      this.load(cx);
    });
  }

  // The toolbar --------------------------------------------------------

  apply(id) {
    const value = this.state.value();
    const r = this.state.selected_range();
    const start = Math.min(r.start, r.end), end = Math.max(r.start, r.end);
    const picked = value.slice(start, end);
    if (WRAP[id]) {
      const [a, b] = WRAP[id];
      this.state.replace(`${a}${picked || "text"}${b}`);
    } else if (LINE[id]) {
      // Prefix every line the selection touches.
      const from = value.lastIndexOf("\n", start - 1) + 1;
      const to = value.indexOf("\n", end) === -1 ? value.length : value.indexOf("\n", end);
      const lines = value.slice(from, to).split("\n").map((l, i) => (id === "ol" ? `${i + 1}. ` : LINE[id]) + l.replace(/^(#{1,6} |[-*] \[[ x]\] |[-*] |\d+\. |> )/, ""));
      this.state.set_selected_range({ start: from, end: to });
      this.state.replace(lines.join("\n"));
    } else if (id === "link") {
      this.state.replace(`[${picked || "text"}](https://)`);
    } else if (id === "block") {
      this.state.replace("\n```\n" + (picked || "code") + "\n```\n");
    } else if (id === "table") {
      this.state.replace("\n| Column | Column |\n| --- | --- |\n| | |\n");
    } else if (id === "rule") {
      this.state.replace("\n\n---\n\n");
    }
    this.text = this.state.value();
    this.state.focus();
  }

  tool(t, [id, label, title]) {
    if (id === "|") return div().w(1).h(16).mx(4).bg(t.border);
    return div()
      .id(`md-${id}`)
      .px(7)
      .h(24)
      .flex()
      .items_center()
      .rounded(5)
      .text_size(12)
      .font_semibold()
      .text_color(t.muted)
      .cursor_pointer()
      .tooltip(title)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.apply(id); cx.notify(); })
      .child(label);
  }

  button(t, id, label, onClick, primary) {
    return div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  render(cx) {
    const t = theme();
    if (!this.file) {
      return v_flex().size_full().items_center().justify_center().gap(10).bg(t.background)
        .child(div().text_size(13).text_color(t.muted).child("Markdown editor"))
        .child(this.button(t, "md-open", "Open a file…", (_e, cx) => this.open(cx), true));
    }
    const name = this.file.split("/").pop();
    const header = h_flex().flex_none().h(36).px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
      .when(this.dirty(), (el) => el.child(div().size(7).rounded(4).bg(t.accent)))
      .child(div().flex_1())
      .child(this.button(t, "md-preview", this.preview ? "Hide preview" : "Show preview", (_e, cx) => { this.preview = !this.preview; cx.notify(); }))
      .child(this.button(t, "md-save", "Save", (_e, cx) => cx.spawn(async (cx) => { await this.save(); cx.notify(); }), this.dirty()));
    const toolbar = h_flex().flex_none().h(34).px(8).gap(1).items_center().border_b(1).border_color(t.border).bg(t.background)
      .children(TOOLS.map((x) => this.tool(t, x)));
    if (this.error) {
      return v_flex().size_full().bg(t.background).child(header)
        .child(div().p(16).text_size(13).text_color(t.blocked).child(`Cannot open ${name}: ${this.error}`));
    }
    const editor = div().flex_1().min_w(0).h_full().child(Editor.new(this.state).size_full().text_size(settings().font_size ?? 14));
    const preview = v_flex().relative().flex_1().min_w(0).h_full().border_l(1).border_color(t.border)
      .child(div().id("md-preview-scroll").size_full().overflow_y_scroll().p(16).text_size(14).text_color(t.foreground)
        .child(TextView.markdown("md-preview-body", this.text).selectable(true)))
      .child(Scrollbar.vertical("md-preview-scroll").absolute().inset_0());
    return v_flex().size_full().bg(t.background)
      .child(header)
      .child(toolbar)
      .child(h_flex().flex_1().min_h(0).child(editor).when(this.preview, (el) => el.child(preview)));
  }
}
