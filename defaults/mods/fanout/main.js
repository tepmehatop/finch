// Finch: one task to several agents, each on its own branch, then compare.
//
// "Start" makes one git worktree and branch per chosen agent (from the space's
// repository, at HEAD), opens a space there with the agent and the task, and
// remembers the run. Below, every run's worktrees show what they changed
// (files, lines). Open one, merge the one you like into the branch you started
// from, or remove a worktree and its branch.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { theme, spaces, panes, focused, knownAgents, exec, run, shared, setShared, appHome, home, readTextFile, notify, checking, tr } from "finch";
import { launch, slug, MODEL_FLAG } from "./plan.js";

const RUNS = "finch.fanout.runs";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder };
}

async function worktreesDir() {
  const raw = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
  let dir = "~/.finch/worktrees";
  try { dir = JSON.parse(raw ?? "{}")?.worktrees?.directory ?? dir; } catch {}
  return dir.replace(/^~(?=\/|$)/, home());
}

export default class Fanout extends View {
  init(_props, cx) {
    this.agents = [];
    this.slots = []; // [{ agent, model }]: one worktree and agent each
    this.models = {}; // agent key → models it can run
    this.stats = {};
    this.busy = false;
    this.confirm = null;
    this.task = TextareaState.new({ placeholder: tr("The task every agent gets"), rows: 5 });
    if (checking()) return;
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed);
      for (const a of this.agents) this.models[a.key] = await this.modelsOf(a.key);
      cx.notify();
      await this.refresh();
      cx.notify();
    });
    cx.timer.every(8000, (cx) => cx.spawn(async (cx) => { await this.refresh(); cx.notify(); }));
  }

  runs() {
    return shared(RUNS) ?? [];
  }

  // The models an agent can be started on: GigaCode's from its token file
  // (as the + menu lists them), Claude Code's aliases.
  async modelsOf(key) {
    if (!MODEL_FLAG[key]) return [];
    if (key === "claude") return ["opus", "sonnet", "haiku"];
    if (!key.startsWith("gigacode")) return [];
    try {
      const cfg = JSON.parse((await readTextFile(`${home()}/.gigacode/gigacode_token.json`)) ?? "{}").config ?? {};
      const names = [...(cfg.chat?.models ?? []), ...(cfg.agent?.models ?? [])].map((m) => m?.model ?? m?.name ?? m?.id).filter(Boolean);
      return [...new Set(names)];
    } catch {
      return [];
    }
  }

  // The next model for a copy: each copy of one agent starts on a different one.
  nextModel(key, current) {
    const list = this.models[key] ?? [];
    if (!list.length) return null;
    const i = list.indexOf(current);
    return i < 0 ? list[0] : i + 1 < list.length ? list[i + 1] : null;
  }

  add(a, cx) {
    const used = this.slots.filter((s) => s.agent.key === a.key).map((s) => s.model);
    const model = (this.models[a.key] ?? []).find((m) => !used.includes(m)) ?? null;
    this.slots.push({ agent: a, model });
    cx.notify();
  }

  async refresh() {
    for (const r of this.runs()) {
      for (const it of r.items) {
        const st = await exec("git", ["diff", "--shortstat", r.base], { cwd: it.dir }).catch(() => null);
        const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: it.dir }).catch(() => null);
        if (!st || st.code !== 0) { this.stats[it.dir] = null; continue; }
        const extra = (untracked?.stdout ?? "").split("\n").filter(Boolean).length;
        this.stats[it.dir] = (st.stdout.trim() || "no changes") + (extra ? `, ${extra} new files` : "");
      }
    }
  }

  start(cx) {
    const task = this.task.value().trim();
    const chosen = this.slots;
    if (!task || !chosen.length) return notify({ title: "Write a task and pick at least one agent", level: "info" });
    const { cwd } = location();
    if (!cwd) return notify({ title: "Open a space in a git repository first", level: "info" });
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
        if (top.code !== 0) throw new Error("not a git repository");
        const root = top.stdout.trim();
        const base = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();
        const repo = root.split("/").pop();
        const id = `${slug(task)}-${Date.now().toString(36).slice(-4)}`;
        const dir = `${await worktreesDir()}/${repo}`;
        const items = [];
        for (const [n, { agent, model }] of chosen.entries()) {
          const branch = `fanout/${id}-${n + 1}-${agent.key}`;
          const path = `${dir}/${branch.replace(/\//g, "-")}`;
          const r = await exec("git", ["worktree", "add", "-b", branch, path, "HEAD"], { cwd: root });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
          const label = model ? `${agent.name} · ${model}` : `${agent.name} ${n + 1}`;
          run("space.new", { folder: path, name: label, argv: launch(agent, task, model), focus: n === 0 });
          items.push({ agent: label, key: agent.key, model, branch, dir: path });
        }
        setShared(RUNS, [{ id, task, root, base, items, at: Date.now() }, ...this.runs()].slice(0, 20));
        this.task.set_value("");
        this.slots = [];
        await this.refresh();
      } catch (e) {
        notify({ title: "Fan-out failed", body: String(e?.message ?? e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  merge(r, it, cx) {
    if (this.confirm !== `merge:${it.dir}`) { this.confirm = `merge:${it.dir}`; cx.notify(); return; }
    this.confirm = null;
    cx.spawn(async (cx) => {
      const commit = await exec("sh", ["-c", 'git add -A && (git diff --cached --quiet || git commit -q -m "$1")', "sh", `fan-out: ${r.task.slice(0, 60)} (${it.agent})`], { cwd: it.dir });
      const m = commit.code === 0 ? await exec("git", ["merge", "--no-ff", "--no-edit", it.branch], { cwd: r.root }) : commit;
      notify(m.code === 0 ? { title: `Merged ${it.branch} into ${r.base}`, level: "info" } : { title: "Merge failed", body: (m.stderr || m.stdout).trim(), level: "error" });
      cx.notify();
    });
  }

  remove(r, it, cx) {
    if (this.confirm !== `rm:${it.dir}`) { this.confirm = `rm:${it.dir}`; cx.notify(); return; }
    this.confirm = null;
    cx.spawn(async (cx) => {
      const space = spaces().find((s) => s.folder === it.dir);
      if (space) run("space.close", { id: space.id, confirmed: true });
      await exec("git", ["worktree", "remove", "--force", it.dir], { cwd: r.root }).catch(() => null);
      await exec("git", ["branch", "-D", it.branch], { cwd: r.root }).catch(() => null);
      const runs = this.runs().map((x) => (x.id === r.id ? { ...x, items: x.items.filter((i) => i.dir !== it.dir) } : x)).filter((x) => x.items.length);
      setShared(RUNS, runs);
      cx.notify();
    });
  }

  // Drawing ------------------------------------------------------------

  button(t, id, label, onClick, primary, warn) {
    return div().id(id).flex_none().px(9).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(warn ? t.blocked : t.border).text_color(warn ? t.blocked : t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  render(cx) {
    const t = theme();
    // Add buttons: one per installed agent; each click adds one more copy.
    const adds = this.agents.map((a) => h_flex().id(`fo-add-${a.key}`).gap(5).px(8).py(4).rounded(6).items_center().cursor_pointer()
      .border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.add(a, cx))
      .child(div().text_size(12).text_color(t.accent).child("+"))
      .child(div().text_size(12.5).text_color(t.foreground).child(a.name)));
    // The copies to start: agent, model (click to change), remove.
    const slots = this.slots.map((s, i) => h_flex().gap(8).px(8).py(5).rounded(6).items_center().border_1().border_color(t.border).bg(t.surface)
      .child(div().w(18).text_size(11.5).text_color(t.dim).child(`${i + 1}`))
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(s.agent.name))
      .when((this.models[s.agent.key] ?? []).length > 0, (el) => el.child(h_flex().id(`fo-model-${i}`).gap(4).px(7).py(1).rounded(5).cursor_pointer()
        .border_1().border_color(t.border).text_size(11.5).text_color(t.muted).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { s.model = this.nextModel(s.agent.key, s.model); cx.notify(); })
        .child(s.model ?? "default model").child(div().text_size(9).child("▾"))))
      .child(div().flex_1())
      .child(div().id(`fo-rm-slot-${i}`).px(6).text_size(13).text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.blocked))
        .on_click((_e, cx) => { this.slots.splice(i, 1); cx.notify(); })
        .child("×")));
    const runs = this.runs();
    return v_flex().id("fanout").size_full().bg(t.background)
      .child(h_flex().flex_none().h(40).px(12).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Fan-out")))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(v_flex().id("fo-scroll").size_full().overflow_y_scroll().p(12).gap(10)
          .child(div().text_size(12.5).text_color(t.muted).child("One task to several agents, each on its own branch and worktree, so they don't touch each other's files. Add agents below; one agent can run several times, each copy on its own model (click the model to change it)."))
          .child(div().rounded(6).border_1().border_color(t.input).px(8).py(6).child(Textarea.new(this.task).h(110)))
          .child(h_flex().gap(6).flex_wrap().children(adds))
          .when(slots.length > 0, (el) => el.child(v_flex().gap(5).children(slots)))
          .child(h_flex().child(div().flex_1()).child(this.button(t, "fo-start", this.busy ? "Starting…" : "Start", (_e, cx) => { if (!this.busy) this.start(cx); }, true)))
          .children(runs.map((r) => v_flex().gap(6).pt(10)
            .child(div().text_size(11.5).font_semibold().text_color(t.dim).child(`${new Date(r.at).toLocaleString()} · ${r.base}`))
            .child(div().text_size(12.5).text_color(t.foreground).child(r.task.length > 160 ? `${r.task.slice(0, 160)}…` : r.task))
            .children(r.items.map((it, i) => v_flex().p(8).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface)
              .child(h_flex().gap(8).items_center()
                .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(`${it.agent} ${i + 1}`))
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.stats[it.dir] ?? "…")))
              .child(h_flex().gap(6)
                .child(this.button(t, `fo-open-${it.dir}`, "Open", () => { const s = spaces().find((x) => x.folder === it.dir); if (s) run("space.select", { id: s.id }); else run("space.new", { folder: it.dir }); }))
                .child(div().flex_1())
                .child(this.button(t, `fo-merge-${it.dir}`, this.confirm === `merge:${it.dir}` ? `Merge into ${r.base}?` : "Merge", (_e, cx) => this.merge(r, it, cx), false, this.confirm === `merge:${it.dir}`))
                .child(this.button(t, `fo-rm-${it.dir}`, this.confirm === `rm:${it.dir}` ? "Remove for good?" : "Remove", (_e, cx) => this.remove(r, it, cx), false, this.confirm === `rm:${it.dir}`))))))))
        .child(Scrollbar.vertical("fo-scroll").absolute().inset_0()));
  }
}
