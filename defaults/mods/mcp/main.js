// Finch: MCP servers for every agent, set up once.
//
// Servers are kept in ~/.config/finch/mcp.json, each with the agents it is on
// for. "Apply" writes them into each installed agent's own config (GigaCode,
// Qwen Code, Claude Code, Codex), touching only the servers Finch manages.
// "Import" brings in servers an agent already has.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { theme, appHome, home, readTextFile, writeTextFile, exec, notify, checking, tr } from "finch";
import { AGENTS, applyJson, applyToml, existing, parseEnv } from "./config.js";

export default class Mcp extends View {
  init(_props, cx) {
    this.data = { servers: [], managed: {} };
    this.raw = null;
    this.installed = {};
    this.status = {};
    this.editing = null;
    this.found = [];
    this.name = InputState.new({ placeholder: tr("Name (letters, digits, -)") });
    this.command = InputState.new({ placeholder: tr("Command, e.g. npx -y @modelcontextprotocol/server-filesystem ~/work") });
    this.url = InputState.new({ placeholder: tr("…or a URL for an HTTP server") });
    this.env = TextareaState.new({ placeholder: tr("Environment, one KEY=value per line"), rows: 3 });
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.load();
      for (const a of AGENTS) {
        this.installed[a.id] = (await exec("test", ["-d", `${home()}/${a.dir}`]).catch(() => ({ code: 1 }))).code === 0;
      }
      cx.notify();
    });
  }

  file() {
    return `${appHome()}/mcp.json`;
  }

  async load() {
    this.raw = await readTextFile(this.file()).catch(() => null);
    try {
      const d = JSON.parse(this.raw ?? "{}");
      this.data = { servers: Array.isArray(d.servers) ? d.servers : [], managed: d.managed ?? {} };
    } catch {
      this.data = { servers: [], managed: {} };
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

  edit(server, cx) {
    this.editing = server ? { ...server } : { name: "", command: "", url: "", env: {}, on: {} };
    this.name.set_value(this.editing.name);
    this.command.set_value(this.editing.command ?? "");
    this.url.set_value(this.editing.url ?? "");
    this.env.set_value(Object.entries(this.editing.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
    cx.notify();
  }

  save(cx) {
    const name = this.name.value().trim().replace(/[^A-Za-z0-9_-]/g, "-");
    const command = this.command.value().trim(), url = this.url.value().trim();
    if (!name || (!command && !url)) return notify({ title: "A name and a command or URL are needed", level: "info" });
    const old = this.editing.name;
    const server = { name, command: url ? "" : command, url, env: parseEnv(this.env.value()), on: this.editing.on ?? {} };
    this.data.servers = [server, ...this.data.servers.filter((s) => s.name !== old && s.name !== name)];
    this.editing = null;
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  toggle(server, agent, cx) {
    server.on = { ...(server.on ?? {}), [agent]: !(server.on ?? {})[agent] };
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  remove(name, cx) {
    this.data.servers = this.data.servers.filter((s) => s.name !== name);
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  apply(cx) {
    cx.spawn(async (cx) => {
      for (const a of AGENTS) {
        if (!this.installed[a.id]) { this.status[a.id] = "not installed"; continue; }
        const path = `${home()}/${a.file}`;
        const before = await readTextFile(path).catch(() => null);
        const servers = this.data.servers.filter((s) => (s.on ?? {})[a.id]);
        let next;
        try {
          next = a.kind === "toml" ? applyToml(before ?? "", servers) : applyJson(before ?? "", servers, this.data.managed[a.id] ?? [], a.kind);
        } catch (e) {
          this.status[a.id] = `can't read ${a.file}: ${e?.message ?? e}`;
          continue;
        }
        if (next === (before ?? "")) { this.status[a.id] = "up to date"; }
        else {
          try {
            await writeTextFile(path, next, before);
            this.status[a.id] = `${servers.length} servers`;
          } catch (e) {
            this.status[a.id] = `not written: ${e?.message ?? e}`;
            continue;
          }
        }
        this.data.managed[a.id] = servers.map((s) => s.name);
      }
      await this.store();
      cx.notify();
    });
  }

  scan(cx) {
    cx.spawn(async (cx) => {
      const mine = new Set(this.data.servers.map((s) => s.name));
      const seen = new Map();
      for (const a of AGENTS) {
        if (!this.installed[a.id]) continue;
        const text = await readTextFile(`${home()}/${a.file}`).catch(() => null);
        for (const s of existing(text, a.kind)) {
          if (mine.has(s.name)) continue;
          const had = seen.get(s.name) ?? { ...s, on: {} };
          had.on[a.id] = true;
          seen.set(s.name, had);
        }
      }
      this.found = [...seen.values()];
      if (!this.found.length) notify({ title: "Nothing new to import", level: "info" });
      cx.notify();
    });
  }

  take(server, cx) {
    this.data.servers = [server, ...this.data.servers];
    this.found = this.found.filter((s) => s.name !== server.name);
    cx.spawn(async (cx) => { await this.store(); cx.notify(); });
  }

  // Drawing ------------------------------------------------------------

  button(t, id, label, onClick, primary) {
    return div().id(id).flex_none().px(9).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  field(t, input) {
    return div().rounded(6).border_1().border_color(t.input).px(8).py(4).child(input);
  }

  form(t) {
    return v_flex().p(12).gap(8)
      .child(this.field(t, Input.new(this.name)))
      .child(this.field(t, Input.new(this.command)))
      .child(this.field(t, Input.new(this.url)))
      .child(div().rounded(6).border_1().border_color(t.input).px(8).py(6).child(Textarea.new(this.env).h(70)))
      .child(h_flex().gap(6).child(div().flex_1())
        .child(this.button(t, "mcp-cancel", "Cancel", (_e, cx) => { this.editing = null; cx.notify(); }))
        .child(this.button(t, "mcp-save", "Save", (_e, cx) => this.save(cx), true)));
  }

  server(t, s, importing) {
    const chips = AGENTS.filter((a) => this.installed[a.id]).map((a) => {
      const on = Boolean((s.on ?? {})[a.id]);
      return div().id(`mcp-${s.name}-${a.id}`).px(7).py(2).rounded(5).text_size(11.5).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.dim)
        .when(!importing, (el) => el.on_click((_e, cx) => this.toggle(s, a.id, cx)))
        .child(a.name);
    });
    return v_flex().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(s.name))
        .when(importing, (el) => el.child(this.button(t, `mcp-take-${s.name}`, "Import", (_e, cx) => this.take(s, cx), true)))
        .when(!importing, (el) => el
          .child(this.button(t, `mcp-edit-${s.name}`, "Edit", (_e, cx) => this.edit(s, cx)))
          .child(this.button(t, `mcp-del-${s.name}`, "Delete", (_e, cx) => this.remove(s.name, cx)))))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(s.url || s.command || ""))
      .child(h_flex().gap(4).flex_wrap().children(chips));
  }

  render(cx) {
    const t = theme();
    const header = h_flex().flex_none().h(40).px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("MCP servers"))
      .child(this.button(t, "mcp-scan", "Import", (_e, cx) => this.scan(cx)))
      .child(this.button(t, "mcp-new", "New", (_e, cx) => this.edit(null, cx)));
    const list = v_flex().relative().flex_1().min_h(0)
      .child(v_flex().id("mcp-list").size_full().overflow_y_scroll().p(10).gap(6)
        .when(Boolean(this.editing), (el) => el.child(this.form(t)))
        .when(!this.data.servers.length && !this.editing, (el) => el.child(div().p(6).text_size(12.5).text_color(t.dim).child("No servers yet. New adds one; Import brings in the ones your agents already have.")))
        .children(this.data.servers.map((s) => this.server(t, s, false)))
        .when(this.found.length > 0, (el) => el.child(div().pt(8).text_size(11.5).font_semibold().text_color(t.dim).child("FOUND IN YOUR AGENTS")).children(this.found.map((s) => this.server(t, s, true)))))
      .child(Scrollbar.vertical("mcp-list").absolute().inset_0());
    const footer = v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(6).child(div().flex_1().text_size(12).text_color(t.dim).child("Agents load new servers when they start again."))
        .child(this.button(t, "mcp-apply", "Apply to agents", (_e, cx) => this.apply(cx), true)))
      .children(AGENTS.filter((a) => this.status[a.id]).map((a) => h_flex().gap(8).text_size(11.5)
        .child(div().w(90).text_color(t.foreground).child(a.name))
        .child(div().flex_1().truncate().text_color(t.dim).child(this.status[a.id]))));
    return v_flex().id("mcp").size_full().bg(t.background).child(header).child(list).child(footer);
  }
}
