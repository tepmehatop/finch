// SPDX-License-Identifier: Apache-2.0
// Choose an explicit machine, folder and first session; reuse an open checkout.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { spaces, machines, knownAgents, pickFolder, exec, run, theme, props, closeOverlay, shared, setShared, home } from "finch";
import { workspace, isAbsolute, localOperation, onWindows, thisComputer } from "./filesystem.js";
import { inspectCheckout, pathKey, leaf } from "./project-model.js";
import { preferredSpace } from "./project-context.js";
import { L, radius, appearance, fontSize } from "./appearance.js";
import { px, glitchy } from "./agency.js";
import { mono, tint, stepLabel, kbd, glyphTile } from "./project-ui.js";

export default class OpenProject extends View {
  init(_props, cx) {
    this.on = null; this.path = ""; this.choice = "terminal"; this.agents = []; this.busy = false;
    this.input = InputState.new({ value: "", placeholder: L("Absolute project folder", "Полный путь к папке проекта") });
    this.input.on("change", (_e, cx) => { this.path = this.input.value(); this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.handle = cx.focus_handle(); this.handle.focus();
    this.loadAgents(cx);
    this.loadHome(cx);
    cx.timer.after(100, () => this.input.focus());
  }

  // The chosen machine's home folder is the default, so Open works at once;
  // another folder is typed in or picked. A path the person already typed is kept.
  loadHome(cx) {
    const on = this.on, request = this.homeRequest = (this.homeRequest ?? 0) + 1;
    const fill = path => {
      if (!path || this.homeRequest !== request || this.closed || this.path.trim()) return;
      this.path = path; this.input.set_value(path); cx.notify();
    };
    if (!on) { fill(home()); return; }
    cx.spawn(async () => {
      // exec on another machine starts in its home.
      try { const r = await exec("pwd", ["-P"], { on, timeout: 8000 }); if (!r.code) fill(r.stdout.trimEnd()); } catch {}
    });
  }

  loadAgents(cx) {
    const on = this.on, request = this.request = (this.request ?? 0) + 1;
    this.loading = true; this.agents = []; this.choice = "terminal";
    cx.spawn(async cx => {
      let found = [];
      try { found = (await knownAgents({ on })).filter(a => a.installed); } catch {}
      if (this.request !== request) return;
      this.agents = found;
      this.loading = false; cx.notify();
    });
  }

  machine(on, cx) {
    if (this.busy || this.picking || this.on === on) return;
    this.on = on; this.path = ""; this.input.set_value(""); this.error = "";
    this.loadAgents(cx);
    this.loadHome(cx);
    cx.timer.after(100, () => this.input.focus());
    cx.notify();
  }

  close() { this.closed = true; }

  chooseFolder(cx) {
    if (this.on || this.busy || this.picking || this.closed) return;
    this.picking = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const path = await pickFolder({ prompt: L("Open project folder", "Открыть папку проекта") });
        if (path && !this.closed) {
          this.path = path; this.input.set_value(path);
          this.picking = false;
          this.submit(cx);
        }
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.picking = false; cx.notify(); }
    });
  }

  submit(cx) {
    if (this.busy || this.picking || this.closed || (this.loading && this.choice !== "terminal")) return;
    const path = this.path.trim(), on = this.on;
    if (on ? !path.startsWith("/") : !isAbsolute(path)) { this.error = L("Choose a folder or enter its absolute path.", "Выбери папку или введи полный путь к ней."); cx.notify(); return; }
    const agent = this.agents.find(a => a.key === this.choice);
    if (this.choice !== "terminal" && !agent) return;
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        // cwd is passed separately, never interpolated into shell source.
        // Windows has no pwd: file-ops.py resolves the folder (links included) instead.
        const cantOpen = () => Error(L("This folder cannot be opened on the selected computer.", "Не удалось открыть папку на выбранном компьютере."));
        let cwd;
        if (onWindows(on)) cwd = (await localOperation({ action: "resolve", path }).catch(() => { throw cantOpen(); })).path;
        else {
          const resolved = await exec("pwd", ["-P"], { cwd: path, on, timeout: 8000 });
          if (resolved.code) throw cantOpen();
          cwd = resolved.stdout.trimEnd();
        }
        const meta = await inspectCheckout(exec, cwd, on);
        const folder = meta.root || cwd;
        const cache = { ...(shared("projects.checkouts.v1") ?? {}), [pathKey(on, folder)]: { ...meta, cwd: folder } };
        setShared("projects.checkouts.v1", cache);
        // Resolve uncached roots too, so an existing project is never duplicated
        // just because its sidebar discovery hasn't completed yet.
        const candidates = [];
        for (const s of spaces().filter(s => (s.machine ?? null) === on)) {
          const root = workspace(s.id).cwd;
          const own = cache[pathKey(on, root)] ?? await inspectCheckout(exec, root, on);
          if (pathKey(on, own.root || root) === pathKey(on, folder)) candidates.push(s);
        }
        if (this.closed) return;
        const existing = preferredSpace(candidates);
        if (existing) run("space.select", { id: existing.id });
        else run("space.new", { name: leaf(folder), folder, machine: on ?? "", tab: agent?.name ?? L("Terminal", "Терминал"), ...(agent ? { argv: agent.run } : {}) });
        closeOverlay(props().overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      this.busy = false; cx.notify();
    });
  }


  // ── drawing ──

  machineTile(t, m) {
    const on = this.on === m.name, ready = m.layout === "ready", enabled = ready && !this.busy && !this.picking;
    const state = !m.name ? thisComputer() : ready ? L("REMOTE", "УДАЛЁННЫЙ") : m.layout === "loading" ? L("CONNECTING", "ПОДКЛЮЧАЮ") : L("OFFLINE", "НЕТ СВЯЗИ");
    return h_flex().id(`project-machine-${m.name ?? "local"}`).h(48).flex_1().min_w(170).px(12).gap(10).items_center().rounded(radius(6))
      .border_1().border_color(on ? t.foreground + "70" : t.border).bg(on ? t.foreground + "14" : t.surface)
      .when(enabled && !on, el => el.cursor_pointer().hover(s => s.bg(t.hover).border_color(t.input)))
      .when(enabled, el => el.on_click((_e, cx) => this.machine(m.name, cx)))
      .when(!ready, el => el.opacity(0.5))
      .child(svg(px(m.name ? "server" : "monitor")).size(15).flex_none().text_color(on ? t.foreground : t.muted))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(fontSize("agents.body")).text_color(t.foreground).child(m.name ?? L("This computer", "Этот компьютер")))
        .child(div().truncate().font_family(mono()).text_size(10).text_color(ready ? t.dim : t.blocked).child(state)))
      .when(on, el => el.child(svg(px("check")).size(15).flex_none().text_color(t.foreground)));
  }

  sessionTile(t, key, program, name, caption) {
    const on = this.choice === key, color = tint(t, key), enabled = !this.busy && !this.picking;
    return h_flex().id(`project-agent-${key}`).w(145).h(48).flex_none().px(9).gap(9).items_center().rounded(radius(6))
      .border_1().border_color(on ? color + "90" : t.border).bg(on ? color + "1c" : t.surface)
      .when(enabled && !on, el => el.cursor_pointer().hover(s => s.bg(t.hover).border_color(t.input)))
      .when(enabled, el => el.on_click((_e, cx) => { this.choice = key; cx.notify(); }))
      .when(!enabled && !on, el => el.opacity(0.5))
      .child(glyphTile(t, program, 28, on ? color : t.muted))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(fontSize("agents.secondary")).text_color(on ? t.foreground : t.muted).when(on, el => el.font_weight(appearance().weights.semibold)).child(name))
        .child(div().truncate().font_family(mono()).text_size(10).text_color(t.dim).child(caption)));
  }

  render() {
    const t = theme(), p = props();
    const idle = !this.busy && !this.picking;
    const choices = [{ name: null, layout: "ready" }, ...machines().filter(m => m.name)];
    const agent = this.agents.find(a => a.key === this.choice);
    const sessionName = agent?.name ?? L("Terminal", "Терминал");
    const working = text => div().font_family(mono()).text_size(10).text_color(t.dim).frames([`${text}`, `${text}.`, `${text}..`, `${text}...`], 280);
    const canOpen = idle && Boolean(this.path.trim()) && (!this.loading || this.choice === "terminal");

    const local = !this.on;
    const browseLabel = this.picking ? L("Waiting…", "Жду…") : onWindows() ? L("Choose…", "Выбрать…") : L("Finder…", "Finder…");
    const folder = v_flex().gap(6)
      .child(h_flex().gap(6).items_center()
        .child(h_flex().flex_1().min_w(0).h(38).px(10).gap(8).items_center().rounded(radius(6)).border_1().border_color(t.input).bg(t.background)
          .child(svg(px("path")).size(15).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().min_w(0).h_full().font_family(appearance().fonts.mono).text_size(12)))
        .when(local, el => el.child(h_flex().id("project-browse").h(38).px(12).gap(7).flex_none().items_center().rounded(radius(6))
          .border_1().border_color(this.picking ? t.foreground + "70" : t.border).bg(t.surface)
          .text_size(fontSize("agents.secondary")).text_color(idle ? t.foreground : t.dim)
          .when(idle, el => el.cursor_pointer().hover(s => s.bg(t.hover).border_color(t.input)).on_click((_e, cx) => this.chooseFolder(cx)))
          .child(svg(px("folder")).size(15).flex_none())
          .child(browseLabel)))
        .child(h_flex().id("project-open").h(38).px(14).gap(7).flex_none().items_center().rounded(radius(6))
          .bg(canOpen ? t.solid : t.raised).text_color(canOpen ? t.solid_foreground : t.dim)
          .text_size(fontSize("agents.secondary")).font_weight(appearance().weights.semibold)
          .when(canOpen, el => el.cursor_pointer().hover(s => s.opacity(0.88)).on_click((_e, cx) => this.submit(cx)))
          .child(this.busy ? L("Opening…", "Открываю…") : L("Open", "Открыть"))
          .child(svg(px("go")).size(15).flex_none())))
      .child(div().text_size(11).text_color(t.dim).child(local
        ? L(`Home folder by default. Opens with ${sessionName}; an open project is selected, not duplicated.`, `По умолчанию домашняя папка. Откроется с: ${sessionName}; уже открытый проект выберется, а не продублируется.`)
        : L(`Home folder on ${this.on} by default. An already open project is selected, not duplicated.`, `По умолчанию домашняя папка на ${this.on}. Уже открытый проект будет выбран, а не продублирован.`)));

    return v_flex().id("open-project").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape" && idle) { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().h(46).flex_none().px(20).items_center().border_b(1).border_color(t.border)
        .child(glitchy(() => div().font_family(mono()).text_size(fontSize("files.body")).font_weight(appearance().weights.semibold), L("OPEN PROJECT", "ОТКРЫТЬ ПРОЕКТ"), t, { at: 30, length: 200 }))
        .child(div().flex_1())
        .child(div().id("project-esc").cursor_pointer().on_click(() => { if (idle) closeOverlay(p.overlay); }).child(kbd(t, "Esc"))))
      .child(v_flex().id("open-project-body").flex_1().min_h(0).px(20).pt(16).pb(8).gap(10).overflow_y_scrollbar()
        .child(stepLabel(t, "01", L("COMPUTER", "КОМПЬЮТЕР")))
        .child(h_flex().gap(6).flex_wrap().children(choices.map(m => this.machineTile(t, m))))
        .child(div().h(6).flex_none())
        .child(stepLabel(t, "02", L("FIRST SESSION", "ПЕРВАЯ СЕССИЯ"), this.loading ? working(L("checking", "проверяю")) : null))
        .child(h_flex().gap(6).flex_wrap()
          .child(this.sessionTile(t, "terminal", null, L("Terminal", "Терминал"), L("DEFAULT", "ПО УМОЛЧАНИЮ")))
          .children(this.agents.map(a => this.sessionTile(t, a.key, a, a.name, (a.run?.[0] ?? a.key).split("/").pop()))))
        .child(div().h(6).flex_none())
        .child(stepLabel(t, "03", this.on ? L("FOLDER ON THE SERVER", "ПАПКА НА СЕРВЕРЕ") : L("FOLDER", "ПАПКА")))
        .child(folder)
        .when(Boolean(this.error), el => el.child(h_flex().gap(8).px(10).py(7).items_center().rounded(radius(6)).bg(t.blocked + "18").border_1().border_color(t.blocked + "50")
          .child(div().size(6).flex_none().bg(t.blocked)).child(div().flex_1().min_w(0).text_size(12).text_color(t.blocked).child(this.error)))));
  }
}
