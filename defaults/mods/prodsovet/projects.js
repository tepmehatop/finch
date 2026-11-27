// SPDX-License-Identifier: Apache-2.0
// One project tree for PA-Advanced. Spaces remain independent native workspaces.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { isRecord, listOr } from "./storage.js";
import { spaces, machines, shared, setShared, exec, run, openOverlay, home, window, setAgentOrder } from "finch";
import { workspace, spaceLabel, join, within, native, thisComputer, shortcut } from "./filesystem.js";
import { appearance, fontSize, labelFont, L, radius } from "./appearance.js";
import { px, current, hovered, glitchy, typed } from "./agency.js";
import { mono, projectTile } from "./project-ui.js";
import { openProjectDialog, openSessionMenu, preferredSpace } from "./project-context.js";
import { pathKey, leaf, inspectCheckout, projectGroups } from "./project-model.js";

const CACHE = "projects.checkouts.v1";
const FOLDS = "projects.folded.v1";
// Which sidebar tab PA-Advanced shows: "projects" (the tree) or "sessions" (one flat list).
export const VIEW = "projects.view.v1";
// Hand order, shared by both tabs: project keys, and agent addresses (the
// Projects tab applies it inside each checkout). The Sessions tab follows the
// agent order only after a drag there, until "by urgency" is chosen again.
const PROJECT_ORDER = "projects.order.v1";
const SESSION_ORDER = "projects.sessionOrder.v1";
const SESSIONS_MANUAL = "projects.sessionsManual.v1";

// Stable sort by a stored order; unknown items keep their place after known ones.
function byOrder(items, key, order) {
  const at = new Map(order.map((k, i) => [k, i]));
  return items.map((x, i) => [x, at.get(key(x)) ?? Infinity, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(x => x[0]);
}
// `list` with `from` moved onto `to`: after it when moving down, before it when moving up.
export function moved(list, from, to) {
  const a = list.indexOf(from), b = list.indexOf(to);
  if (a < 0 || b < 0 || a === b) return list;
  const out = list.filter(x => x !== from);
  out.splice(out.indexOf(to) + (a < b ? 1 : 0), 0, from);
  return out;
}
const ranks = { blocked: 4, done: 3, working: 2, idle: 1 };
const SECTION = () => ({ 4: L("NEED YOU", "ЖДУТ ТЕБЯ"), 3: L("DONE", "ГОТОВО"), 2: L("WORKING", "РАБОТАЮТ"), 1: L("RESTING", "ОТДЫХАЮТ") });
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

export class ProjectTree {
  init(cx) {
    const cache = shared(CACHE);
    this.cache = isRecord(cache) ? cache : {};
    this.folded = new Set(listOr(shared(FOLDS)));
    this.pending = new Set();
    this.queue = new Map();
    this.workers = 0;
    this.checked = new Map();
    this.pressed = null; // { kind, id, scope, moved } while a row is being dragged
    this.over = null;
    this.sync(cx);
    cx.timer.every(15000, cx => { if (window().active) this.sync(cx); });
  }

  entries(list = []) {
    return spaces().map(space => {
      const cwd = workspace(space.id).cwd || space.folder;
      return { space, cwd, label: spaceLabel(space), meta: this.cache[pathKey(space.machine, cwd)], members: list.filter(a => a.space === space.id) };
    });
  }

  sync(cx) {
    for (const e of this.entries()) {
      const on = e.space.machine ?? null, key = pathKey(on, e.cwd);
      if (!e.cwd || this.pending.has(key) || Date.now() - (this.checked.get(key) ?? 0) < 60000) continue;
      this.queue.set(key, { cwd: e.cwd, on });
    }
    while (this.queue.size && this.workers < 6) {
      this.workers++;
      cx.spawn(async cx => {
        try {
          while (this.queue.size) {
            const [key, { cwd, on }] = this.queue.entries().next().value;
            this.queue.delete(key);
            this.pending.add(key);
            try {
              const next = await inspectCheckout(exec, cwd, on, this.cache[key]);
              this.cache[key] = next;
              const saved = shared(CACHE) ?? {};
              if (JSON.stringify(saved[key]) !== JSON.stringify(next)) setShared(CACHE, { ...saved, [key]: next });
            } finally {
              this.checked.set(key, Date.now());
              this.pending.delete(key);
              cx.notify();
            }
          }
        } finally { this.workers--; }
      });
    }
  }

  toggle(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    setShared(FOLDS, [...this.folded]);
    cx.notify();
  }

  menu(space) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 300, props: { tab: "space", target: { id: space.id } } });
  }

  add(space) {
    openSessionMenu(space);
  }

  // Inner buttons stop their click, so the row under them never sees the
  // release: they end the press here, or hovering later would draw a drop line.
  release() { this.pressed = null; this.over = null; }

  // Press, move onto another row of the same kind and scope, release: `drop(from, to)`.
  // A plain click never moves (the row's own on_click still runs).
  drag(el, t, kind, id, scope, list, drop) {
    const p = this.pressed, mine = p && p.kind === kind && p.scope === scope;
    const from = mine ? list.indexOf(p.id) : -1, at = list.indexOf(id);
    return el.relative()
      .when(Boolean(mine && p.moved && p.id === id), e => e.opacity(0.45))
      .when(Boolean(mine && p.moved && this.over === id && p.id !== id), e => e.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(from < at, l => l.bottom(0)).when(from > at, l => l.top(0))))
      .on_mouse_down("left", () => { this.pressed = { kind, id, scope, moved: false }; this.over = id; })
      .on_mouse_move((_e, cx) => {
        const q = this.pressed;
        if (!q || q.kind !== kind || q.scope !== scope || this.over === id) return;
        this.over = id; q.moved = q.moved || q.id !== id; cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        const q = this.pressed;
        this.pressed = null; this.over = null;
        if (q && q.moved && q.kind === kind && q.scope === scope && q.id !== id) { cx.stop_propagation(); drop(q.id, id); }
        cx.notify();
      });
  }

  render(cx, owner, list, withKids, collapsed, t, all) {
    this.sync(cx);
    const entries = this.entries(list);
    // Recover only Finch's managed path convention, with one unambiguous local
    // repository. Cached Git identity takes precedence; never match arbitrary basenames.
    for (const e of entries) {
      if (e.space.machine || !e.meta?.unavailable || e.meta.repo) continue;
      const managed = join(join(home(), ".finch"), "worktrees");
      if (!within(e.cwd, managed) || within(managed, e.cwd)) continue;
      const parts = native(e.cwd).slice(native(managed).length + 1).split(/[/\\]/);
      if (parts.length !== 2) continue;
      const candidates = new Map(entries.filter(x => !x.space.machine && x.meta?.repo && !x.meta.linked && leaf(x.meta.main) === parts[0]).map(x => [x.meta.repo, x.meta]));
      if (candidates.size === 1) {
        const main = [...candidates.values()][0];
        e.meta = { ...e.meta, repo: main.repo, main: main.main, root: e.cwd, linked: true, inferred: true };
        const key = pathKey(null, e.cwd);
        this.cache[key] = e.meta;
        setShared(CACHE, { ...(shared(CACHE) ?? {}), [key]: e.meta });
      }
    }
    const projects = byOrder(projectGroups(entries), p => p.key, listOr(shared(PROJECT_ORDER)));
    const sessionOrder = listOr(shared(SESSION_ORDER));
    for (const p of projects) for (const c of p.checkouts) c.members = byOrder(c.members, a => a.address, sessionOrder);
    // Agents that are on screen, in their shown order, with the drag applied.
    this.reorderAgents = (shown, from, to) => {
      const next = moved(shown, from, to);
      setShared(SESSION_ORDER, [...next, ...sessionOrder.filter(x => !next.includes(x) && all.some(k => k.address === x))]);
    };
    owner.dragCard = null;
    owner.dragEnd = () => this.release();
    owner.rail = false;
    const view = shared(VIEW) === "sessions" ? "sessions" : "projects";
    owner.caption = null;
    owner.rail = view === "projects" && !collapsed;
    if (view === "sessions") return this.sessions(cx, owner, projects, entries, withKids, collapsed, t, all);
    const ordered = projects.flatMap(p => p.checkouts.flatMap(c => c.members));
    if (!collapsed) {
      const checkoutOf = new Map(projects.flatMap(p => p.checkouts.flatMap(c => c.members.map(a => [a.address, c]))));
      const shownAll = ordered.map(a => a.address);
      owner.dragCard = (el, a) => {
        const c = checkoutOf.get(a.address);
        if (!c) return el;
        return this.drag(el, t, "agent", a.address, c.key, c.members.map(m => m.address), (from, to) => this.reorderAgents(shownAll, from, to));
      };
    }
    // Hidden descendants stay in navigation after their parent, once each.
    const addresses = ordered.flatMap(a => [a.address, ...owner.tree(all, a.address).map(s => s.t.address)]);
    setAgentOrder([...new Set(addresses)]);
    const index = new Map(ordered.map((a, i) => [a.address, i]));
    const top = members => members.flatMap(a => [a.status, ...owner.tree(all, a.address).map(s => s.t.status)])
      .reduce((best, s) => (ranks[s] ?? 0) > (ranks[best] ?? 0) ? s : best, null);
    const button = (id, icon, hint, act, size = 14) => div().id(id).size(22).flex_none().flex().items_center().justify_center()
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(hint)
      .on_click((_e, cx) => { cx.stop_propagation(); this.release(); act(cx); }).child(svg(px(icon)).size(size));
    // Only an informative branch: the usual trunk names say nothing new.
    const TRUNK = new Set(["main", "master", "trunk", "develop", "dev"]);
    const branchMark = branch => h_flex().flex_none().max_w(96).gap(3).items_center().text_color(t.dim)
      .child(svg(px("branch")).size(12).flex_none())
      .child(div().min_w(0).truncate().font_family(mono()).text_size(10).child(branch));
    const head = (id, name, members, active, space, nested, hint, detail) => {
      // Expanded, the agent cards below already show each status; folded, the
      // header carries the loudest one. Idle never adds a mark.
      const folded = this.folded.has(id), loud = top(members), status = folded && loud && loud !== "idle" ? loud : null;
      return h_flex().id(id).h(nested ? 28 : 34).flex_none().gap(6).pl(2).pr(3).items_center()
        // No fill for the active project: the current session card is the one
        // selection. The active project only reads brighter; others are muted.
        .when(true, el => hovered(el, t))
        .on_click(() => { if (space) run("space.select", { id: space.id }); })
        .when(Boolean(space), el => el.on_mouse_down("right", () => this.menu(space)))
        .child(button(`${id}-fold`, `fold-${folded ? "right" : "down"}`, folded ? L("Expand", "Развернуть") : L("Collapse", "Свернуть"), cx => this.toggle(id, cx), 16))
        .child(nested ? svg(px("branch")).size(14).flex_none().text_color(active ? t.foreground : t.dim) : projectTile(t, space, name, 18).opacity(active ? 1 : 0.55))
        .child(div().flex_1().min_w(0).truncate().text_size(nested ? 12 : fontSize("agents.body"))
          .when(nested, el => el.font_family(mono()))
          .when(!nested, el => el.font_weight(appearance().weights.semibold)).text_color(active ? t.foreground : t.muted).tooltip(hint || name).child(name))
        // A worktree says what it is in words, not only with the branch icon.
        .when(nested, el => el.child(div().flex_none().h(15).px(4).flex().items_center().border_1().border_color(t.border)
          .font_family(mono()).text_size(9).text_color(t.dim).tooltip(hint).child("WORKTREE")))
        .when(Boolean(detail) && !TRUNK.has(detail), el => el.child(branchMark(detail)))
        .when(Boolean(status), el => el.child(owner.status(t, { status }, true)))
        .when(members.length > 0, el => el.child(div().min_w(16).h(16).px(3).flex().items_center().justify_center().border_1().border_color(t.border)
          .font_family(mono()).text_size(10).text_color(t.dim).tooltip(L(`Agents: ${members.length}`, `Агентов: ${members.length}`)).child(String(members.length))))
        .when(Boolean(space), el => el.child(button(`${id}-add`, "plus", L("New session / worktree", "Новая сессия / worktree"), () => this.add(space))));
    };
    // The rail is a line drawn first, so a card's selection bar can cover it.
    const rail = el => el.relative().pl(5).child(div().absolute().left(0).top(0).bottom(0).w(1).bg(t.border));
    const rows = [];
    const machineNames = [...new Set([...projects.map(p => p.machine), ...machines().map(m => m.name)])];
    // One section per computer once any remote machine is known: this Mac first.
    const showMachines = machineNames.some(Boolean);
    machineNames.forEach((machine, at) => {
      const mine = projects.filter(p => p.machine === machine);
      if (showMachines && collapsed && at > 0) rows.push(div().h(1).mx(10).my(6).flex_none().bg(t.border));
      if (showMachines && !collapsed) {
        const state = machine ? machines().find(m => m.name === machine)?.layout : "ready";
        const away = state !== "ready";
        rows.push(h_flex().id(`projects-machine-${machine ?? "local"}`).h(28).mt(at > 0 ? 10 : 2).px(8).gap(7).items_center().flex_none()
          .font_family(mono()).text_size(fontSize("agents.meta")).text_color(t.muted)
          .child(svg(px(machine ? "server" : "monitor")).size(13).flex_none().text_color(away ? t.blocked : t.dim))
          .child(div().flex_none().max_w(180).truncate().font_weight(appearance().weights.semibold).child(machine ? machine.toUpperCase() : thisComputer()))
          .child(div().flex_1().h(1).bg(t.border))
          .when(away, el => el.child(div().text_size(10).text_color(t.blocked).child(state === "loading" ? L("connecting", "подключаю") : L("offline", "нет связи")))));
        if (!mine.length) rows.push(div().px(28).pb(4).text_size(11).text_color(t.dim).child(L("No open projects", "Нет открытых проектов")));
      }
      for (const project of mine) {
        const id = `project-${project.key}`, members = project.checkouts.flatMap(c => c.members);
        const main = project.checkouts.find(c => !c.meta.linked);
        const target = preferredSpace(main?.spaces ?? project.checkouts[0].spaces);
        const active = project.checkouts.some(c => c.spaces.some(s => s.active));
        if (collapsed) {
          rows.push(h_flex().id(id).h(34).flex_none().items_center().justify_center()
            .when(active, el => current(el, t)).when(!active, el => hovered(el, t)).tooltip(machine ? `${project.name} · ${machine}` : project.name)
            .on_click(() => run("space.select", { id: target.id })).child(projectTile(t, target, project.name, 20)));
          rows.push(...members.flatMap(a => withKids(a, index.get(a.address))));
          continue;
        }
        const tip = [main?.root || project.main, main?.meta.branch && L(`Branch: ${main.meta.branch}`, `Ветка: ${main.meta.branch}`)].filter(Boolean).join("\n");
        const peers = projects.filter(p => p.machine === machine).map(p => p.key);
        rows.push(this.drag(head(id, project.name, members, active, target, false, tip, main?.meta.branch), t, "project", project.key, JSON.stringify(machine), peers,
          (from, to) => setShared(PROJECT_ORDER, moved(projects.map(p => p.key), from, to))));
        if (this.folded.has(id)) continue;
        // Everything a project owns hangs on one rail under its fold arrow: the
        // main checkout's sessions first, then each worktree in its own box.
        const inside = [];
        for (const c of project.checkouts) {
          const cid = `checkout-${c.key}`, nested = Boolean(c.meta.linked);
          const part = [];
          if (nested) part.push(head(cid, c.meta.branch || leaf(c.root), c.members, c.spaces.some(s => s.active), preferredSpace(c.spaces), true, `${c.root}\n${L("Git worktree of this project", "Git worktree этого проекта")}`, null));
          if (!nested || !this.folded.has(cid)) {
            if (c.meta.unavailable) part.push(h_flex().pl(10).pb(4).gap(6).items_center().font_family(mono()).text_size(10).text_color(t.blocked)
              .child(div().size(5).flex_none().bg(t.blocked)).child(L("Folder unavailable", "Папка недоступна")));
            part.push(v_flex().id(`checkout-content-${c.key}`).flex_none().min_w(0).children(c.members.flatMap(a => withKids(a, index.get(a.address)))));
          }
          if (!nested) { inside.push(...part); continue; }
          // A worktree branches off the project rail and carries its own rail.
          const [top, ...body] = part;
          inside.push(v_flex().id(`checkout-box-${c.key}`).flex_none().min_w(0).mt(2)
            .child(h_flex().min_w(0).items_center().child(div().w(7).h(1).ml(-5).flex_none().bg(t.border)).child(div().flex_1().min_w(0).child(top)))
            .when(body.length > 0, el => el.child(rail(v_flex().min_w(0).ml(13)).children(body))));
        }
        rows.push(rail(v_flex().id(`project-content-${project.key}`).flex_none().min_w(0).ml(12).pb(4)).children(inside));
      }
    });
    return this.frame(rows, collapsed, t, view);
  }

  // Sessions tab: every agent in one list, most urgent and most recent first;
  // each card says which project (and worktree branch) it works in.
  sessions(cx, owner, projects, entries, withKids, collapsed, t, all) {
    const home = new Map();
    for (const p of projects) {
      const main = p.checkouts.find(c => !c.meta.linked);
      const tile = preferredSpace(main?.spaces ?? p.checkouts[0].spaces);
      for (const c of p.checkouts) for (const s of c.spaces) home.set(s.id, { p, c, tile });
    }
    const cwdOf = new Map(entries.map(e => [e.space.id, e.cwd]));
    const urgency = a => Math.max(ranks[a.status] ?? 0, ...owner.tree(all, a.address).map(s => ranks[owner.listed?.get(s.t.address) ?? s.t.status] ?? 0));
    const manual = shared(SESSIONS_MANUAL) === true, order = listOr(shared(SESSION_ORDER));
    const all2 = projects.flatMap(p => p.checkouts.flatMap(c => c.members));
    const byUrgency = list => [...list].sort((x, y) => urgency(y) - urgency(x) || owner.since(y) - owner.since(x));
    // By hand: new sessions (not placed yet) come first, by urgency, then the placed ones.
    const flat = manual ? [...byUrgency(all2.filter(a => !order.includes(a.address))), ...byOrder(all2.filter(a => order.includes(a.address)), a => a.address, order)] : byUrgency(all2);
    if (!collapsed) {
      const shown = flat.map(a => a.address);
      owner.dragCard = (el, a) => this.drag(el, t, "agent", a.address, "sessions", shown, (from, to) => { this.reorderAgents(shown, from, to); setShared(SESSIONS_MANUAL, true); });
    }
    setAgentOrder([...new Set(flat.flatMap(a => [a.address, ...owner.tree(all, a.address).map(s => s.t.address)]))]);
    owner.caption = new Map(flat.map(a => {
      const where = home.get(a.space);
      const name = where?.p.name ?? leaf(cwdOf.get(a.space) ?? "");
      const branch = where?.c.meta.linked ? where.c.meta.branch || leaf(where.c.root) : null;
      return [a.address, h_flex().min_w(0).gap(5).items_center().tooltip(where?.c.root || cwdOf.get(a.space) || name)
        .child(projectTile(t, where?.tile, name, 13))
        .child(div().min_w(0).truncate().text_color(t.muted).child(name))
        .when(Boolean(branch), el => el.child(svg(px("branch")).size(11).flex_none()).child(div().min_w(0).max_w(90).truncate().font_family(mono()).text_size(10).child(branch)))];
    }));
    // By status: the same sections as the Workshop (need you, done, working,
    // resting); each header folds its section. By hand: one flat list.
    const rows = [];
    let last = null;
    flat.forEach((a, i) => {
      const r = urgency(a) || ranks.idle, id = `sessions-sec-${r}`;
      if (!manual && !collapsed && last !== r) {
        last = r;
        rows.push(this.section(cx, owner, t, id, r, flat.filter(x => (urgency(x) || ranks.idle) === r).length));
      }
      if (manual || collapsed || !owner.folded.has(id)) rows.push(...withKids(a, i));
    });
    if (!flat.length && !collapsed) rows.push(v_flex().px(10).pt(10).gap(6)
      .child(div().font_family(appearance().fonts.mono).text_size(fontSize("agents.secondary")).text_color(t.foreground).frames(typed(L("> start an agent", "> запусти агента")), 110))
      .child(div().text_size(fontSize("agents.meta")).text_color(t.dim).child(L("Agent sessions from every project show up here.", "Здесь появятся сессии агентов из всех проектов."))));
    return this.frame(rows, collapsed, t, "sessions", manual);
  }

  // A status section header in SESSIONS: colored mark, label, count, fold.
  section(cx, owner, t, id, r, count) {
    const open = !owner.folded.has(id), status = SECTION_STATUS[r];
    return h_flex().id(id).h(26).px(8).pt(6).flex_none().gap(6).items_center().cursor_pointer()
      .font_family(mono()).text_size(fontSize("agents.meta")).font_weight(appearance().weights.medium)
      .hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? owner.folded.add(id) : owner.folded.delete(id); cx.notify(); })
      .when(Boolean(status), el => el.child(div().size(6).flex_none().bg(t[status])))
      .child(div().truncate().text_color(t[status] ?? t.dim).child(SECTION()[r]))
      .child(div().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .when(!open, el => el.child(svg(px("fold-right")).size(14).flex_none().text_color(t.dim)));
  }

  // The column: PROJECTS | SESSIONS tabs, the open button and the scrolling list.
  frame(rows, collapsed, t, view, manual = false) {
    const label = () => div().font_family(labelFont() ?? appearance().fonts.ui).text_size(fontSize("files.body"));
    const tab = (id, text) => {
      const on = view === id;
      return div().id(`projects-view-${id}`).h_full().flex_none().flex().items_center().border_b(2).border_color(on ? t.foreground : t.chrome)
        .when(!on, el => el.cursor_pointer().hover(s => s.text_color(t.muted)).on_click((_e, cx) => { setShared(VIEW, id); cx.notify(); }))
        .child(on ? glitchy(label, text, t, { color: t.foreground, at: 40, length: 230 }) : label().text_color(t.dim).child(text));
    };
    return v_flex().size_full().min_h(0).bg(t.chrome)
      .child(h_flex().h(36).px(collapsed ? 4 : 12).flex_none().items_center().gap(14)
        .when(!collapsed, el => el.child(tab("projects", L("PROJECTS", "ПРОЕКТЫ"))).child(tab("sessions", L("SESSIONS", "СЕССИИ"))))
        .child(div().flex_1())
        // SESSIONS sorts like the Workshop did: by status, or in your own order.
        .when(view === "sessions" && !collapsed, el => el.child(h_flex().flex_none().gap(2).items_center().children([
          ["sessions-sort-status", "clock", L("By status: need you, done, working, resting", "По статусу: ждут тебя, готово, работают, отдыхают"), false],
          ["sessions-sort-manual", "order", L("Your order (drag to arrange)", "Свой порядок (перетаскивай)"), true],
        ].map(([id, icon, hint, hand]) => {
          const on = manual === hand;
          return div().id(id).size(22).flex_none().flex().items_center().justify_center().tooltip(hint)
            .when(on, e => e.bg(t.raised).text_color(t.foreground))
            .when(!on, e => e.cursor_pointer().text_color(t.dim).hover(h => h.text_color(t.foreground))
              .on_click((_e, cx) => { cx.stop_propagation(); setShared(SESSIONS_MANUAL, hand); cx.notify(); }))
            .child(svg(px(icon)).size(14));
        }))))
        // Open project: a bare Finder-style folder icon at its native 16px.
        .child(div().id("project-new").size(26).flex_none().flex().items_center().justify_center().rounded(radius(5))
          .text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(L(`Open project… (${shortcut("⌘N", "Ctrl+Shift+N")})`, `Открыть проект… (${shortcut("⌘N", "Ctrl+Shift+N")})`))
          .on_click((_e, cx) => { cx.stop_propagation(); openProjectDialog(); })
          .child(svg(px("project-open")).size(16).flex_none())))
      .child(v_flex().id("project-list").flex_1().min_h(0).px(collapsed ? 0 : 6).pb(12).overflow_y_scrollbar().mode("always")
        // A release or exit anywhere else ends a drag without moving anything.
        .on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = null; this.over = null; cx.notify(); } })
        .on_hover((on, cx) => { if (!on && this.pressed) { this.pressed = null; this.over = null; cx.notify(); } })
        .children(rows));
  }
}
