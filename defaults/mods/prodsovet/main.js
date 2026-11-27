import { stored } from "./storage.js";
import { appearance, fontSize, metric, radius, style, labelFont, brandFont, L, lang, advanced } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// ПродСовет: custom workspace features with the standard Finch styling.
// One mod, several roles (props.role): brand, agents, pane, status.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, props, run, theme, home, layout, window, shared, setShared, spaces, keys, focused, exec, appHome, closeOverlay, settings, terminals, nextCommand, openOverlay, setLanguage } from "finch";
import { conversationTitle, watchConversationTitles } from "./antigravity-titles.js";
import { panePalette, styledLayout, withTerminal } from "./palette.js";
import OpenProject from "./open-project.js";
import { openProjectDialog, nextProjectTab, openSessionMenu } from "./project-context.js";
import { Agents } from "./agents.js";
import { Spaces } from "./spaces.js";
import { Picker } from "./picker.js";
import { Changes } from "./changes.js";
import { GitHub } from "./github.js";
import { mini, word, artFrame, artPath, ART_FRAMES, ART_KINDS } from "./creatures.js";
import { agency, accentOf, railFrames, glitchy, icon, settled, watchBackground } from "./agency.js";

import { workspace, newTerminal, python, tilde, thisComputer } from "./filesystem.js";
import Tabs from "./file-tabs.js";
import NewMenu from "./file-new-menu.js";
import TabMenu from "./file-tab-menu.js";
import SubAgentMenu from "./sub-menu.js";
import { Issues } from "./issues.js";


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}
function folder(cwd) {
  return cwd ? tilde(cwd) : "";
}
const counts = () => {
  const all = terminals();
  const list = agents().map(a => ({ ...a, status: settled(a.status, a.address, all) }));
  return {
    total: list.length,
    working: list.filter((a) => a.status === "working").length,
    blocked: list.filter((a) => a.status === "blocked").length,
    done: list.filter((a) => a.status === "done").length,
  };
};

// Go to: the agency picker in agency profiles, Finch's own otherwise.
function openPicker() {
  if (agency()) openOverlay({ mod: "prodsovet", kind: "dialog", width: 640, height: 470, props: { role: "picker" } });
  else run("mod.open", { name: "picker" });
}

// ── brand: the stock Finch logo and name, search, sidebar toggle ──
class Brand {
  button(t, id, name, action) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(radius(6)).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .child(svg(icon(name, `mods/workspace-chrome/${name}.svg`)).size(15));
  }
  // Classic: muted green text. Chip style: inverse label on the accent, as on /agency.
  subtitle(t) {
    const color = appearance().brandColors[settings().dark ? "dark" : "light"];
    const text = div().font_weight(appearance().weights.semibold).text_size(fontSize("brand.subtitle")).line_height(`${metric("brand.subtitleLine")}px`).truncate();
    if (!style("brandChip")) return text.text_color(color).child("ProdAdvice");
    return h_flex().child(text.font_family(labelFont() ?? appearance().fonts.ui).px(4).bg(color).text_color(t.accent_foreground).child("PRODADVICE"));
  }
  // The title; with agency decoration, two offset copies flash a glitch every ~9 s.
  title(t) {
    const text = () => div().when(style("brandFont") != null, (el) => el.font_family(brandFont())).text_size(fontSize("brand.title"))
      .line_height(`${metric("brand.titleLine")}px`).font_weight(style("brandFont") != null ? 400 : appearance().weights.semibold);
    if (!agency()) return text().text_color(t.foreground).child("Finch");
    return glitchy(text, "Finch", t);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center()
      .border_b(1).border_color(t.border)
      .when(mac && !collapsed, (el) => el.pl(80))
      .when(!collapsed, (el) => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(image("frame/welcome/finch.png").size(20).flex_none().rounded(radius(5)))
        .child(v_flex().min_w(0)
          .child(this.title(t))
          .when(!agency(), (el) => el.child(this.subtitle(t))))))
      .when(!collapsed, (el) => el.child(this.button(t, "search", "search", () => openPicker())))
      .when(!(collapsed && mac), (el) => el.child(this.button(t, "sidebar-toggle", "sidebar", toggleSidebar)));
  }
}

// Pane header: a one-line creature, standard UI typography, and the folder.
class PaneHead {
  init() { this.hovered = false; }
  button(t, id, name, command, args) {
    return div().id(id).p(3).rounded(radius(4)).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); if (command === "pane.split") { run("pane.focus", { pane: args.pane }); newTerminal(args.direction); } else run(command, args); })
      .child(svg(agency() ? icon(name) : `mods/pane/${name}.svg`).size(agency() ? 15 : 14));
  }
  render() {
    const t = theme();
    const p = panes().find((x) => x.pane === props()?.pane);
    if (!p) return div();
    const all = terminals();
    const name = conversationTitle(p, all.find(t => t.address === p.terminal)) || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const st = settled(p.status, p.terminal, all);
    const palette = panePalette(layout(), withTerminal(p, all), settings().dark);
    const pt = palette ? { ...t, ...palette } : t;
    const pane = p.pane;
    const m = st ? (agency() || palette?.google ? railFrames(st, palette?.google) : mini(st)) : null;
    // Agency: working is the agent's own color; blocked/done stay the shared status colors.
    const tone = (s) => (agency() && !palette?.google && s === "working" ? accentOf(p.program, t) : pt[s] ?? t.dim);
    return h_flex().id(`ps-head-${pane}`).size_full().px(10).gap(8).items_center().text_size(fontSize("pane.body"))
      .bg(pt.background).border_b(1).border_color(st === "working" || palette?.google ? pt.border : t.border)
      .on_hover((h, cx) => { this.hovered = h; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(m), (el) => el.child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("pane.status")).text_color(tone(st)).frames(m.frames, m.ms)))
      .when(!m, (el) => el.child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("pane.status")).text_color(t.dim).child(">_")))
      .child(div().flex_none().truncate().max_w(260).font_weight(appearance().weights.medium).text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(st) && st !== "idle" && st !== "working", (el) => el.child(div().flex_none().text_size(fontSize("pane.state")).text_color(tone(st))
        .when(st === "blocked", (e) => e.loop("opacity", { from: 0.3, to: 1, period: 700 }))
        .child(word(st))))
      // Finch: agents whose conversation the chat mod reads get a Chat toggle.
      .when(["claude", "gigacode", "gigacode-qa", "qwen"].includes(p.program?.key) && Boolean(p.terminal), (el) => el.child(h_flex().flex_none().gap(1).p(1).rounded(5).border_1().border_color(t.border)
        .children([["terminal", L("Terminal", "Терминал")], ["chat", L("Chat", "Чат")], ["both", L("Both", "Оба")]].map(([v, label]) =>
          div().id(`ps-view-${v}-${pane}`).px(6).h(18).flex().items_center().rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("agent.view", { terminal: p.terminal, view: v }); })
            .child(label)))))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ps-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ps-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ps-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ps-x-${pane}`, "close", "pane.close", { pane })));
  }
}

// Status bar: machine, branch, crew counts, and Claude/Codex/Antigravity limits.
const DAYS = () => (lang() === "ru" ? ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"] : ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
function resetIn(sec) {
  if (!sec) return "";
  const left = sec * 1000 - Date.now();
  if (left <= 0) return "";
  if (left < 3600e3) return `↻${Math.ceil(left / 60e3)}${L("M", "М")}`;
  if (left < 24 * 3600e3) return `↻${Math.round(left / 3600e3)}${L("H", "Ч")}`;
  return `↻${DAYS()[new Date(sec * 1000).getDay()]}`;
}
// Activity: whether agents worked, per 2-minute bucket, for the last hour.
const BUCKET = 120000, BUCKETS = 30;
const WINDOW_SEC = { "5h": 5 * 3600, "7d": 7 * 86400 };
class Status {
  init(_p, cx) {
    watchConversationTitles(cx);
    this.limits = null;
    this.refresh(cx);
    cx.timer.every(180000, (cx) => this.refresh(cx));
    this.activity = stored("activity", {});
    this.sample(cx);
    cx.timer.every(20000, (cx) => this.sample(cx));
    // The one copy that announces finished turns with background work left.
    watchBackground();
    cx.timer.every(1500, () => watchBackground());
  }
  sample(cx) {
    if (!agency()) return;
    const now = Math.floor(Date.now() / BUCKET);
    const working = counts().working;
    let dirty = false;
    if ((this.activity[now] ?? -1) < working) { this.activity[now] = working; dirty = true; }
    for (const k of Object.keys(this.activity)) if (k <= now - BUCKETS) { delete this.activity[k]; dirty = true; }
    if (!dirty) return;
    localStorage.setItem("activity", JSON.stringify(this.activity));
    cx?.notify();
  }
  // Minutes in the last hour with at least one agent working (2-minute buckets).
  busyMinutes() {
    const now = Math.floor(Date.now() / BUCKET);
    let busy = 0;
    for (let i = 0; i < BUCKETS; i++) if ((this.activity?.[now - i] ?? 0) > 0) busy++;
    return Math.min(60, busy * (BUCKET / 60000));
  }
  // Plan/fact bar: the fill is what's used, the tick is where an even pace would be.
  bar(t, used, resets, key) {
    const span = WINDOW_SEC[key];
    const plan = resets && span ? Math.min(1, Math.max(0, 1 - (resets - Date.now() / 1000) / span)) : null;
    const fact = Math.min(1, Math.max(0, used / 100));
    const color = used >= 80 ? t.blocked : plan != null && fact > plan + 0.05 ? t.working : t.done;
    const W = 34;
    return div().w(W).h(5).flex_none().relative().bg(t.input + "66")
      .child(div().absolute().top(0).left(0).h(5).w(Math.max(1, Math.round(W * fact))).bg(color))
      .when(plan != null, (el) => el.child(div().absolute().top(-2).left(Math.min(W - 1, Math.round(W * plan))).w(1).h(9).bg(t.foreground)));
  }
  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await python([`${appHome()}/mods/prodsovet/limits.py`], { timeout: 40000 });
        if (r.code === 0) { this.limits = JSON.parse(r.stdout); cx.notify(); }
      } catch (_e) { /* keep the last numbers */ }
    });
  }
  limit(t, label, src, tip = null) {
    const parts = [];
    if (!src || src.error) return div().flex_none().text_color(t.dim).when(Boolean(tip), el => el.tooltip(tip)).child(`${label} -`);
    for (const key of ["5h", "7d"]) {
      const w = src[key];
      if (!w) continue;
      const used = Math.round(w.used);
      const color = used >= 80 ? t.blocked : used >= 50 ? t.foreground : t.muted;
      if (agency()) {
        parts.push(h_flex().flex_none().gap(4).items_center()
          .child(div().text_color(t.dim).child(key === "5h" ? L("5H", "5Ч") : L("7D", "7Д")))
          .child(this.bar(t, used, w.resets, key))
          .child(div().text_color(color).child(`${used}% ${resetIn(w.resets)}`.trim())));
        continue;
      }
      parts.push(div().flex_none().text_color(color).child(`${key === "5h" ? L("5H", "5Ч") : L("7D", "7Д")} ${used}% ${resetIn(w.resets)}`.trim()));
    }
    if (!parts.length) return div().flex_none().text_color(t.dim).when(Boolean(tip), el => el.tooltip(tip)).child(`${label} -`);
    return h_flex().flex_none().gap(5).items_center().child(div().text_color(t.dim).when(Boolean(tip), el => el.tooltip(tip)).child(label)).children(parts);
  }
  // EN / RU: the whole ProdAdvice interface follows shared("ui.lang").
  language(t) {
    const option = (code) => div().id(`lang-${code}`).flex_none().px(3).cursor_pointer()
      .when(lang() === code, (el) => el.bg(t.foreground).text_color(t.background))
      .when(lang() !== code, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => { setShared("ui.lang", code); setLanguage(code); })
      .child(code.toUpperCase());
    return h_flex().flex_none().gap(2).items_center().child(option("en")).child(option("ru"));
  }
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((x) => mod[x.toLowerCase()] ?? x.toUpperCase()).join("");
    return key ? `${key}  ${L("COMMANDS", "КОМАНДЫ")}` : L("COMMANDS", "КОМАНДЫ");
  }
  // Reconcile only on focus/theme/status changes; no redraw timer.
  syncFrame() {
    const f = focused();
    const p = f?.terminal ? panes().find(x => x.terminal === (f.shown ?? f.terminal)) : null;
    const next = styledLayout(layout(), withTerminal(p, terminals()), settings().dark);
    if (!next) { this.pending = null; return; }
    const signature = JSON.stringify(next);
    if (this.pending === signature) return;
    this.pending = signature;
    try { run("layout.set", { layout: next }); }
    catch (error) { this.pending = null; throw error; }
  }
  render() {
    const t = theme();
    this.syncFrame();
    const space = spaces().find((s) => s.active);
    const c = counts();
    const cell = (text, color) => div().flex_none().text_color(color ?? t.muted).child(text);
    return h_flex().size_full().px(10).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .when(Boolean(labelFont()), (el) => el.font_family(labelFont()))
      .text_size(fontSize("status.body")).text_color(t.muted)
      .child(cell(space?.machine ? space.machine.toUpperCase() : thisComputer()))
      .when(Boolean(space?.branch), (el) => el.child(cell(`⎇ ${space.branch}`)))
      .child(cell(`${L("AGENTS", "АГЕНТЫ")} ${c.total}`))
      .when(c.working > 0, (el) => el.child(cell(`${L("WORKING", "РАБОТАЮТ")} ${c.working}`, t.working)))
      .when(agency(), (el) => el.child(h_flex().flex_none().gap(5).items_center()
        .child(cell(L("1H", "ЧАС"), t.dim)).child(cell(`${this.busyMinutes()}${L("m", "м")}`, c.working > 0 ? t.working : t.muted))))
      .when(c.blocked > 0, (el) => el.child(cell(`! ${L("WAITING", "ЖДУТ")} ${c.blocked}`, t.blocked).loop("opacity", { from: 0.35, to: 1, period: 800 })))
      .when(c.done > 0, (el) => el.child(cell(`✓ ${L("DONE", "ГОТОВО")} ${c.done}`, t.done)))
      .when(Boolean(this.limits?.claude), el => el.child(this.limit(t, "CLAUDE", this.limits.claude)))
      .when(Boolean(this.limits?.codex), el => el.child(this.limit(t, "CODEX", this.limits.codex)))
      .when(Boolean(this.limits?.antigravity), el => el.child(this.limit(t, "AGY", this.limits.antigravity, "Antigravity")))
      .child(div().flex_1().min_w(0))
      .child(this.language(t))
      .child(div().id("palette").flex_none().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click(() => run("app.palette")).child(this.hint()));
  }
}

// ── toast: agent notes stay silent (Finch still plays its sound; the sidebar shows who
// waits). Everything else (errors, logins, failed commands) shows as before, bottom right. ──
const TOAST_DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };
function aboutAgent(n) {
  const args = n.action?.args ?? {};
  const list = agents();
  if (args.pane && list.some((a) => a.pane === args.pane)) return true;
  if (args.terminal && list.some((a) => a.address === args.terminal || a.address.endsWith(`/${args.terminal}`)
    || panes().some((p) => p.terminal === args.terminal && p.pane === a.pane))) return true;
  return /\b(finished|needs you|is done|needs your)\b/i.test(`${n.title ?? ""} ${n.body ?? ""}`);
}
class Toast {
  init() {
    const n = props() ?? {};
    this.silent = aboutAgent(n);
    if (this.silent) closeOverlay(n.overlay);
  }
  render() {
    if (this.silent) return div();
    const t = theme();
    const n = props() ?? {};
    return h_flex().id("toast").size_full().px(18).gap(12).items_center().bg(t.popover).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => { if (n.action?.name) run(n.action.name, n.action.args ?? {}); closeOverlay(n.overlay); })
      .child(n.icon ? image(n.icon).w(18).h(18).flex_none() : div().size(8).rounded(radius(4)).flex_none().bg(t[TOAST_DOT[n.level] ?? "accent"]))
      .child(v_flex().flex_1().overflow_hidden()
        .child(div().truncate().font_weight(appearance().weights.semibold).text_size(fontSize("toast.title")).text_color(t.foreground).child(n.title ?? ""))
        .when(Boolean(n.body), (el) => el.child(div().truncate().tooltip(n.body).text_size(fontSize("toast.body")).text_color(t.muted).child(n.body ?? ""))));
  }
}

// ── zoo: every creature in every state, for previewing ──
class Zoo {
  init(_p, cx) { this.tick = 0; cx.timer.every(100, (cx) => { this.tick++; cx.notify(); }); }
  render() {
    const t = theme();
    const sts = ["working", "blocked", "done", "idle"];
    return v_flex().p(16).gap(10).bg(t.chrome)
      .children(ART_KINDS.map((k) => h_flex().gap(18).items_center()
      .child(div().w(90).text_size(fontSize("zoo.label")).text_color(t.dim).child(k.toUpperCase()))
      .children(sts.map((st) => div().size(64).flex_none().relative().overflow_hidden()
        .child(image(artPath(k, st)).absolute().top(0).left(-64 * artFrame(k, st, this.tick, this.tick * 100)).w(64 * ART_FRAMES).h(64))))));
  }
}

const ROLES = { tabs: Tabs, "new-menu": NewMenu, "tab-menu": TabMenu, "sub-menu": SubAgentMenu, toast: Toast, zoo: Zoo, brand: Brand, agents: Agents, projects: Agents, "open-project": OpenProject, spaces: Spaces, picker: Picker, changes: Changes, github: GitHub, issues: Issues, pane: PaneHead, status: Status };

export default class ProdSovet extends View {
  init(p, cx) {
    // Pane headers get {pane, terminal} without a role.
    // The layout's toast gets {title, body, level, overlay} without a role.
    const pr = props() ?? {};
    const role = pr.role ?? (pr.pane ? "pane" : pr.overlay && "title" in pr ? "toast" : "brand");
    this.impl = new (ROLES[role] ?? Brand)();
    this.impl.init?.(p, cx);
    if (role === "status") {
      for (const s of spaces()) workspace(s.id);
      cx.spawn(async cx => { for (;;) {
        const c = await nextCommand(), name = c?.name ?? c?.command ?? c;
        if (name === "new-terminal") newTerminal();
        else if (name === "split-right") newTerminal("right");
        else if (name === "split-down") newTerminal("down");
        else if (name === "picker") openPicker();
        else if (name === "open-project") openProjectDialog();
        else if (name === "next-tab") nextProjectTab(1);
        else if (name === "prev-tab") nextProjectTab(-1);
        else if (name === "new-menu" && advanced()) openSessionMenu();
        else if (name === "new-menu") openOverlay({ mod: "prodsovet", kind: "popup", width: 250, height: 512, props: { role: "new-menu" } });
        cx.notify();
      } });
    }
  }
  render(cx) {
    const f = focused();
    if (f?.terminal && f?.space) {
      const agents = shared("files.agents") ?? {};
      if (agents[f.space] !== f.terminal) setShared("files.agents", { ...agents, [f.space]: f.terminal });
    }
    return this.impl.render(cx);
  }
  async close(cx) {
    await this.impl.close?.(cx);
  }
}
