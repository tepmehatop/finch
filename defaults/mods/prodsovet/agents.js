import { stored, isRecord } from "./storage.js";
import { appearance, fontSize, metric, radius, style, labelFont, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { div, image, svg } from "gpui-kit";
import { word, artFrame, artPath, artKind, ART_FRAMES } from "./creatures.js";
import { conversationTitle } from "./antigravity-titles.js";
import { spaceLabel } from "./filesystem.js";
import { ProjectTree } from "./projects.js";
import { agency, accentOf, activitySpinner, googleActivityColor, current, onRail, hovered, glitchy, halftone, typed, px, icon as assetIcon, settled } from "./agency.js";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, appHome, exec } from "finch";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

// Codex titles are "thread-id | thread-name | project-name": session_fork needs
// the id first, the card shows only the dialog's name (project is the space already).
function codexName(raw) {
  const s = (raw ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "");
  const m = s.match(/^(?:Thread(?: ID)?[: ]+)?[0-9a-f]{8}-[0-9a-f-]*(?:\.\.\.|\u2026)?(?:\s*\|\s*(.*))?$/i);
  if (!m) return raw;
  const parts = (m[1] ?? "").split(/\s*\|\s*/).filter(Boolean);
  parts.pop();
  return parts.join(" | ");
}

function sameId(live, l) {
  const id = l?.terminal ?? l?.address;
  if (!id) return false;
  const bare = id.includes("/") ? id.split("/").pop() : id;
  return live === id || live === bare;
}

function title(tab, l, terminal) {
  const conversation = conversationTitle(l, terminal);
  if (conversation && (!tab.named || tab.name === l.program.name)) return conversation;
  const prog = l?.program?.name;
  const live = clean(codexName(l?.title));
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && !sameId(live, l) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? settled(k.status, k.address);
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const showChildStatus = status => status === "working" || status === "blocked";
const SORTS = [
  { id: "priority", label: () => L("By urgency", "По срочности"), icon: "clock" },
  { id: "grouped", label: () => L("By space", "По пространствам"), icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = () => ({ 4: L("NEED YOU", "ЖДУТ ТЕБЯ"), 3: L("DONE", "ГОТОВО"), 2: L("WORKING", "РАБОТАЮТ"), 1: L("RESTING", "ОТДЫХАЮТ") });
const chrome = (name) => assetIcon(name, `mods/workspace-chrome/${name}.svg`);
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export class Agents {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    if (props()?.role === "projects") { this.projects = new ProjectTree(); this.projects.init(cx); }
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = stored("changed", {});
    for (const [address, change] of Object.entries(this.changed)) {
      if (!isRecord(change)) delete this.changed[address];
    }
    this.pendingPins = stored("pins", []).filter(address => typeof address === "string");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    // Art shows once its files exist; checked now and every minute.
    this.hasArt = false;
    const probe = (cx) => cx.spawn(async (cx) => {
      let ok = false;
      try { ok = (await exec("test", ["-f", `${appHome()}/mods/prodsovet/art/creatures/codex-working.png`])).code === 0; } catch {}
      if (ok !== this.hasArt) { this.hasArt = ok; cx.notify(); }
    });
    probe(cx);
    cx.timer.every(60000, probe);
    // The sprite clock: 10 fps, only while characters are on screen.
    this.tick = 0;
    this.flaskDoneSince = new Map();
    cx.timer.every(100, (cx) => {
      if (!this.hasArt || narrow() || !this.drawn) return;
      // All asleep: a third of the rate, the breathing is slow anyway.
      this.beat = (this.beat ?? 0) + 1;
      if (!this.busy && this.beat % 3) return;
      this.tick = (this.tick + 1) % (ART_FRAMES * 1000);
      cx.notify();
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    const doneSince = new Map();
    let dirty = false;
    for (const a of list) {
      if (a.status === "done" && artKind(a.program?.key) === "antigravity") {
        doneSince.set(a.address, this.flaskDoneSince.get(a.address) ?? now);
      }
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    this.flaskDoneSince = doneSince;
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["finch.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(fontSize("agents.menu"))
      .child(div().px(8).pt(4).pb(6).text_size(fontSize("agents.section")).text_color(t.dim).child(L("SORT", "СОРТИРОВКА")))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(metric("agents.menuRow"))
        .px(8)
        .gap(9)
        .rounded(radius(7))
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(chrome(s.icon)).size(agency() ? 15 : 14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label()))
        .when(s.id === on, (el) => el.child(svg(chrome("check")).size(agency() ? 15 : 14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = [], origin = this.projectSpaces?.get(addr)) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live"
      && (!this.projects || !this.projectSpaces?.has(k.address) || this.projectSpaces.get(k.address) === origin));
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"], origin),
      ];
    });
  }

  subRow(t, s, shown, compact, live) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const google = st === "working" ? googleActivityColor(k, live) : null;
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(radius(8))
      .h(metric("agents.compactRow"))
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(fontSize("agents.compact"))
      .when(on && !agency(), (el) => el.bg(t.raised))
      .when(on && agency(), (el) => (this.rail ? onRail : current)(el, t))
      .when(!on && !agency(), (el) => el.hover((s) => s.bg(t.hover)))
      .when(!on && agency(), (el) => hovered(el, t))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.subMenu(k.address); })
      .on_hover((over, cx) => {
        if (over) this.hoveredSub = k.address;
        else if (this.hoveredSub === k.address) this.hoveredSub = null;
        cx.notify();
      })
      .when(!agency(), el => el.children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(radius(6))))))
      // Agency: the tree in box-drawing text; a working branch lights in the agent's color.
      .when(agency(), el => el.child(div().flex_none().mr(5).font_family(appearance().fonts.mono)
        .text_color(st === "working" ? google ?? accentOf(k.program, t) : t.input)
        .child(s.lines.map((l, i) => (i === s.lines.length - 1 ? `${l}─` : l ? `${l} ` : "  ")).join(""))))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || conversationTitle(k, k) || k.template || k.program?.name || k.address))
      .when(this.hoveredSub === k.address, el => el.child(this.subMenuButton(t, k)))
      .when(showChildStatus(st), el => el.child(this.status(t, { ...k, status: st }, compact, google)));
  }

  subMenuButton(t, k) {
    return div().id(`sub-more-${k.address}`).size(20).mr(4).flex_none().flex().items_center().justify_center()
      .rounded(radius(4)).text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(L("More…", "Ещё…"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.subMenu(k.address, true); })
      .child(svg(px("more")).size(15));
  }

  subMenu(address, allowDetach = false) {
    openOverlay({ mod: "prodsovet", kind: "popup", width: 270, props: { role: "sub-menu", terminal: address, allowDetach } });
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false, google = null) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return activitySpinner(google, agency() ? accentOf(a.program, t) : t.working).mx(1);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(radius(4)).bg(t.blocked + "26").text_size(fontSize("agents.badge")).font_weight(appearance().weights.bold).text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(radius(5)).bg(t.blocked + "26").text_size(fontSize("agents.badge")).font_weight(appearance().weights.semibold).text_color(t.blocked).flex().items_center().child(L("Needs you", "Ждёт тебя"));
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(radius(4)).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(radius(4)).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    const all = terminals();
    let list = agents();
    // Core may lose the report while the agent and its child terminals stay live.
    // Keep that pane in the workshop; a missing report is an unknown status.
    const listed = new Set(list.map(a => a.address));
    const live = new Map(all.filter(t => t.state === "live").map(t => [t.address, t]));
    const parents = new Set([...live.values()].filter(t => t.parent).map(t => t.parent));
    const locations = new Map(spaces().flatMap(s => s.tabs.map(tab => [tab.id, { s, tab }])));
    for (const p of panes()) {
      const terminal = live.get(p.terminal);
      const location = locations.get(p.tab);
      if (!terminal || !location || listed.has(p.terminal)) continue;
      if (!p.program?.agent && !terminal.program?.agent && !parents.has(p.terminal)) continue;
      const { s, tab } = location;
      list.push({
        address: p.terminal, pane: p.pane, space: s.id, space_name: s.name,
        tab: tab.id, tab_index: tab.index, tab_name: tab.name,
        status: p.status ?? null, app: p.app, program: p.program,
        title: p.title, seq: 0,
        pinned: Boolean(terminal.labels?.["finch.pinned"]), focused: p.focused,
      });
      listed.add(p.terminal);
    }
    // A finished turn with only background work left is done until seen, then idle.
    list = list.map(a => ({ ...a, status: settled(a.status, a.address, all) }));
    // PA-Advanced has no pinning: existing pins are left alone in core but ignored here.
    if (this.projects) list = list.filter(a => a.program?.agent || a.status != null).map(a => ({ ...a, pinned: false }));
    this.projectSpaces = this.projects ? new Map(list.map(a => [a.address, a.space])) : null;
    // Spaces read as in the Spaces list: a project root rather than "~".
    const spaceById = new Map(spaces().map((s) => [s.id, s]));
    list = list.map((a) => (spaceById.has(a.space) ? { ...a, space_name: spaceLabel(spaceById.get(a.space)) } : a));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.migratePins(all);
    const shown = focused()?.agent;
    const now_focus = focused();
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => (!this.projects && a.pinned) || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = !this.projects && sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));
    this.drawn = !collapsed && list.length > 0;
    this.busy = list.some((a) => a.status !== "idle");

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority, live))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(radius(4))
        .text_size(fontSize("agents.meta"))
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.dragEnd?.();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(this.projects ? svg(px(`fold-${open ? "down" : "right"}`)).size(13).flex_none() : svg(chrome(`chevron-${open ? "down" : "right"}`)).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const fallback = (a) => {
      const live = clean(codexName(a.title));
      return (live && !sameId(live, a) ? live : "") || a.program?.name || "";
    };
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      const lead = many ? a : leads.get(a.tab);
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, lead, live.get(lead?.terminal ?? a.address)) : conversationTitle(a, live.get(a.address)) || fallback(a)];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const isChild = Boolean(live.get(a.address)?.parent);
      const childMenu = el => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.subMenu(a.address); });
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(metric("agents.compactRow"))
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .when(isChild, childMenu)
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .when(!isChild || showChildStatus(a.status), el => el.child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true, googleActivityColor(a, live)))));
      }
      const when = this.since(a);
      // PA-Advanced: only the session that really has the window's focus is current.
      const on = this.projects ? Boolean(now_focus && (a.pane === now_focus.pane || a.address === now_focus.terminal || a.address === now_focus.agent)) : a.focused;
      const idle = a.status === "idle" && !on;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(radius(4))
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? L("Unpin", "Открепить") : L("Pin to the top", "Закрепить сверху"))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.dragEnd?.();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(chrome(isPinned ? "pin-off" : "pin")).size(agency() ? 15 : 13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || (isPinned && !this.projects);
      const raw = more ?? label(a);
      const name = full ? a.space_name || label(a) : /^\d+$/.test(raw) ? (a.program?.name ? (more ? `${a.program.name} ${more}` : a.program.name) : raw) : raw;
      const art = this.hasArt && (!this.projects || artKind(a.program?.key) !== "other");
      const tint = t[a.status] ?? t.dim;
      const own = agency() ? accentOf(a.program, t) : t.accent;
      return h_flex()
        .id(`ag-${a.address}`)
        .px(6)
        .h(metric("agents.row"))
        .flex_none()
        .items_center()
        .gap(8)
        .rounded(radius(8))
        .when(a.focused && !agency(), (el) => el.bg(t.selected).when(style("selectionBar"), (e) => e.border_l(2).border_color(own).pl(4)))
        .when(on && agency(), (el) => (this.rail ? onRail : current)(el, t))
        .when(agency(), (el) => el.relative())
        .cursor_pointer()
        .when(!agency(), (el) => el.hover((s) => s.bg(t.hover)))
        .when(agency() && !on, (el) => hovered(el, t))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(isChild, childMenu)
        // PA-Advanced: the project tree makes cards draggable (reorder).
        .when(Boolean(this.dragCard), el => this.dragCard(el, a))
        .child(div().id(`agent-fold-${a.address}`).flex_none().w(52).flex().items_center().justify_center()
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.dragEnd?.();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          }))
          .when(!art && Boolean(pic), el => el.child(pic))
          .when(art, el => el.child(div().size(44).flex_none().relative().overflow_hidden()
            .child(image(artPath(a.program?.key, a.status)).absolute().top(0)
              .left(-44 * artFrame(a.program?.key, a.status, this.tick + i * 5, now - (this.flaskDoneSince.get(a.address) ?? 0))).w(44 * ART_FRAMES).h(44)))))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(5).items_center()
            .child(div().min_w(0).max_w(this.projects ? 1000 : full && more ? 100 : 180).truncate().text_size(fontSize("agents.body")).text_color(idle ? t.muted : t.foreground).when(Boolean(this.projects), el => el.tooltip(name)).child(name))
            .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_size(fontSize("agents.secondary")).text_color(t.dim).child(`\u00b7 ${more}`))))
          .child(h_flex().min_w(0).gap(6).items_center().text_size(fontSize("agents.meta")).text_color(t.dim)
            .when(a.status === "blocked", el => el.child(div().flex_none().text_color(tint).child(word("blocked"))))
            .when(Boolean(this.caption?.get(a.address)), el => el.child(this.caption.get(a.address)))
            .when(a.status == null, el => el.child(div().text_color(t.dim).child(a.program?.shell ? L("TERMINAL", "ТЕРМИНАЛ") : L("STATUS UNKNOWN", "СТАТУС НЕИЗВЕСТЕН"))))
            .when(Boolean(machine), el => el.child(div().flex_none().child(machine)))
            .when(Boolean(when), el => el.child(div().flex_none().child(duration(now - when))))))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(!this.projects && this.hovered === a.address, el => el.child(pin));
    };

    if (this.projects) return this.projects.render(cx, this, list, withKids, collapsed, t, all);

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: L("PINNED", "ЗАКРЕПЛЕНЫ"), status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION()[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(metric("agents.groupRow"))
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(fontSize("agents.meta"))
        .font_weight(appearance().weights.medium)
        .when(Boolean(labelFont()), (el) => el.font_family(labelFont()))
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(agency() && Boolean(g.status), (el) => el.child(div().size(6).flex_none().bg(t[g.status])))
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true, googleActivityColor(g.members.find(a => a.status === top), live))))
          .child(svg(chrome("chevron-right")).size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(fontSize("agents.body"))
      .when(!collapsed && !agency(), (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(metric("agents.header"))
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().when(Boolean(labelFont()), (el) => el.font_family(labelFont())).text_size(fontSize("agents.group")).font_weight(appearance().weights.medium).text_color(t.dim).child(L("WORKSHOP", "МАСТЕРСКАЯ")))
            .child(
              div()
                .id("ag-sort")
                .text_size(fontSize("agents.meta"))
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "prodsovet", kind: "popup", width: 200, height: 140, props: { role: "agents", sortMenu: true } }))
                .tooltip(`${L("Sort agents", "Сортировка")}: ${sort.label()}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      // Agency: the title reads like FILES; both sort orders are pixel buttons side by side.
      .when(!collapsed && agency(), (el) =>
        el.child(
          h_flex().pl(16).pr(10).h(metric("agents.header")).pt(14).pb(5).flex_none().gap(8).items_center()
            .child(glitchy(() => div().font_family(labelFont() ?? appearance().fonts.ui).text_size(fontSize("files.body")).font_weight(appearance().weights.semibold),
              L("WORKSHOP", "МАСТЕРСКАЯ"), t, { color: t.foreground, at: 150, length: 260 }))
            .child(div().flex_1())
            .child(h_flex().flex_none().gap(2).items_center().children(SORTS.map((s) => {
              const on = s.id === sort.id;
              return div().id(`ag-sort-${s.id}`).size(24).flex_none().flex().items_center().justify_center().cursor_pointer()
                .when(on, (e) => e.bg(t.raised).text_color(t.foreground))
                .when(!on, (e) => e.text_color(t.dim).hover((h) => h.text_color(t.foreground)))
                .tooltip(s.label())
                .on_click(() => setShared("agents.sort", s.id))
                .child(svg(chrome(s.icon)).size(15));
            }))),
        ),
      )
      .when(list.length === 0 && !collapsed && agency(), (el) =>
        el.child(v_flex().px(16).gap(6)
          .child(div().font_family(appearance().fonts.mono).text_size(fontSize("agents.secondary")).text_color(t.foreground).frames(typed(L("> start an agent", "> запусти агента")), 110))
          .child(div().text_size(fontSize("agents.meta")).text_color(t.dim).child(L("Agents show up here once they report their status.", "Агенты появятся здесь, когда сообщат свой статус.")))),
      )
      .when(list.length === 0 && !collapsed && !agency(), (el) =>
        el.child(div().px(12).text_size(fontSize("agents.secondary")).text_color(t.dim).child(L("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.", "Статусов агентов пока нет. Агенты появятся здесь, когда сообщат свой статус. Старые версии и агенты внутри tmux могут не сообщать."))),
      )
      .when(agency() && !collapsed, (el) => el.relative().child(div().absolute().bottom(0).left(0).w_full().h(84).overflow_hidden().child(halftone(t.foreground + "40"))))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(fontSize("agents.body"))
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
