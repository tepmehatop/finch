import { appearance, fontSize, metric, radius, L, advanced } from "./appearance.js";
import { agency, px } from "./agency.js";
import { mono, tint, kbd, glyphTile, projectTile } from "./project-ui.js";
import { leaf } from "./project-model.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
import { newTerminal, workspace, tilde } from "./filesystem.js";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, home } from "finch";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "new-menu.agents";

function shortcut(name) {
  const k = keys().find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

// Finch: how agents open (terminal, chat or both), shared with Finch's own + menu.
function finchViewRow(t, cx) {
  const view = shared("finch.agentView") ?? (shared("finch.chatWithAgents") === false ? "terminal" : "both");
  return h_flex().h(29).px(9).gap(6).items_center()
    .child(div().flex_1().text_size(12).text_color(t.muted).child(L("Open agents as", "Открывать агента")))
    .children([["terminal", L("Terminal", "Терминал")], ["chat", L("Chat", "Чат")], ["both", L("Both", "Оба")]].map(([v, label]) =>
      div().id(`pa-view-${v}`).px(7).py(2).rounded(5).text_size(11.5).cursor_pointer()
        .when(view === v, el => el.bg(t.selected).text_color(t.foreground))
        .when(view !== v, el => el.text_color(t.dim).hover(s => s.text_color(t.foreground)))
        .on_click((_e, cx) => { setShared("finch.agentView", v); cx.notify(); })
        .child(label)));
}

// Finch: one task to several agents (fan-out), as in Finch's own + menu.
function finchFanoutRow(t) {
  return h_flex().id("pa-fanout").h(29).px(9).gap(10).items_center().rounded(6).cursor_pointer().text_color(t.foreground)
    .hover(s => s.bg(t.hover))
    .on_click(() => { closeOverlay(props().overlay); run("tab.new", { mod: "fanout", name: "Fan-out" }); })
    .child(div().w(14).text_size(13).child("⑂"))
    .child(div().flex_1().text_size(12.8).child(L("Several agents…", "Несколько агентов…")));
}

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => props()?.space ? s.id === props().space : s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true) {
    const t = theme();
    return h_flex().id(id).h(metric("newMenu.row")).px(9).gap(10).rounded(radius(7)).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(fontSize("newMenu.hint")).text_color(t.dim).child(hint));
  }
  // PA-Advanced: the checkout's session menu, drawn with the project dialog's pieces.
  projectRow(id, lead, name, action, hint = "", enabled = true, color = null) {
    const t = theme();
    return h_flex().id(id).h(32).px(8).gap(10).rounded(radius(5)).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(!enabled, el => el.opacity(0.55))
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg((color ?? t.foreground) + "1c")))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(lead).child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(hint), el => el.child(/^[0-9⌘⌃⌥⇧A-Za-z+]+$/.test(hint) ? kbd(t, hint) : div().font_family(mono()).text_size(10).text_color(t.dim).child(hint)));
  }
  renderProject(space, choices, installed) {
    const t = theme();
    const cwd = workspace(space?.id).cwd || "";
    const name = cwd ? leaf(cwd) : L("Project", "Проект");
    const where = cwd && tilde(cwd) !== "~" ? tilde(cwd) : cwd;
    const pxIcon = n => div().size(22).flex_none().flex().items_center().justify_center().child(svg(px(n)).size(15).text_color(t.muted));
    const worktree = action => () => openOverlay({ mod: "worktree", kind: "dialog", width: action === "new" ? 460 : 560, height: action === "new" ? 280 : 480, props: { space: space?.id, folder: cwd, action } });
    const rows = choices.length + (this.failed || this.agents.length === 0 ? 1 : 0);
    return v_flex().id("new-menu").track_focus(this.handle).w_full().min_h(0).h(Math.min(540, 214 + Math.max(1, rows) * 32)).bg(t.popover).text_size(fontSize("newMenu.body"))
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        newTerminal("tab", space?.id, agent.run, agent.name);
      })
      .child(v_flex().flex_none().px(12).pt(11).pb(10).gap(7).border_b(1).border_color(t.border)
        .child(div().font_family(mono()).text_size(fontSize("agents.meta")).font_weight(appearance().weights.semibold).text_color(t.foreground).child(L("NEW SESSION", "НОВАЯ СЕССИЯ")))
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(projectTile(t, space, name, 20))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(fontSize("agents.body")).font_weight(appearance().weights.semibold).text_color(t.foreground).child(name))
            .child(div().truncate().tooltip(cwd).font_family(mono()).text_size(10).text_color(t.dim).child(where)))
          .when(Boolean(space?.machine), el => el.child(svg(px("server")).size(13).flex_none().text_color(t.muted).tooltip(space.machine)))))
      .child(v_flex().flex_1().min_h(0).p(5)
        .child(div().px(8).pt(4).pb(4).font_family(mono()).text_size(10).text_color(t.dim).child(L("AGENTS", "АГЕНТЫ")))
        .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
          .children(choices.map((a, i) => this.projectRow(a.key, glyphTile(t, a, 22, a.installed ? tint(t, a.key) : t.dim), a.name,
            () => newTerminal("tab", space?.id, a.run, a.name), a.installed ? (i < 9 ? String(i + 1) : "") : L("not installed", "не установлен"), a.installed, tint(t, a.key))))
          .when(this.failed || this.agents.length === 0, el => el.child(div().px(8).py(8).text_size(12).text_color(t.dim)
            .child(this.failed ? L("Could not check installed agents", "Не удалось проверить агентов") : L("Checking installed agents…", "Проверяю установленных агентов…")))))
        .child(div().h(1).mx(4).my(5).flex_none().bg(t.border))
        .child(finchViewRow(t))
        .child(finchFanoutRow(t))
        .child(this.projectRow("terminal", pxIcon("terminal"), L("Open terminal", "Открыть терминал"), () => newTerminal("tab", space?.id), shortcut("tab.new")))
        .child(this.projectRow("worktree", pxIcon("branch"), L("Create worktree…", "Создать worktree…"), worktree("new"), "", Boolean(space)))
        .child(this.projectRow("worktree-open", pxIcon("folder"), L("Open worktree…", "Открыть worktree…"), worktree("open"), "", Boolean(space))));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => props()?.space ? s.id === props().space : s.active);
    const projectMode = advanced();
    const installed = this.agents.filter(a => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    if (projectMode) return this.renderProject(space, choices, installed);
    return v_flex().min_h(0).w_full().h(Math.min(491, 167 + Math.max(1, choices.length + (this.failed ? 1 : 0)) * metric("newMenu.row"))).bg(t.popover).p(5).text_size(fontSize("newMenu.body"))
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        newTerminal("tab", space?.id, agent.run, agent.name);
      })
      .child(this.row("terminal", svg(agency() ? px("terminal") : "icons/shell.svg").size(agency() ? 15 : 14), L("Terminal", "Терминал"), () => newTerminal("tab", space?.id), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(fontSize("newMenu.hint")).text_color(t.dim).child(L("Start an agent", "Запустить агента")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => newTerminal("tab", space?.id, a.run, a.name), a.installed ? (i < 9 ? String(i + 1) : "") : L("not installed", "не установлен"), a.installed)))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? L("Could not check installed agents", "Не удалось проверить агентов") : L("Checking installed agents…", "Проверяю установленных агентов…")))))
      .child(finchViewRow(t))
      .child(finchFanoutRow(t))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", (agency() ? svg(px("plus")).size(15) : div().w(14).child("+")), L("New space", "Новое пространство"), () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg(agency() ? px("branch") : "mods/workspace-chrome/branch.svg").size(agency() ? 15 : 14), L("Create worktree…", "Создать worktree…"), () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: props()?.space ? workspace(space?.id).cwd : panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg(agency() ? px("branch") : "mods/workspace-chrome/branch.svg").size(agency() ? 15 : 14), L("Open worktree\u2026", "Открыть worktree…"), () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: props()?.space ? workspace(space?.id).cwd : panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
