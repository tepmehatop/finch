import { appearance, fontSize, metric, radius, labelFont, style, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Issues panel for the focused folder's GitHub repository, through the `gh`
// CLI (on the folder's machine): a filtered list, one issue with its comments,
// and writing: new issue, edit, comment, close/reopen, labels, assign to me.
// "@" pastes an issue into the space's agent, as the GitHub panel does.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, theme, shared, notify } from "finch";
import { openExternal, pasteInto } from "./filesystem.js";

const REFRESH = 120000;
const px = (name) => `mods/prodsovet/art/px/${name}.svg`;
const LIST_FIELDS = "number,title,url,state,updatedAt,labels,assignees,author";
const VIEW_FIELDS = "number,title,body,url,state,stateReason,createdAt,updatedAt,author,labels,assignees,comments";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => { const l = location(); return JSON.stringify([l.cwd, l.on]); };

export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}${L("m", "м")}`;
  if (s < 86400) return `${Math.round(s / 3600)}${L("h", "ч")}`;
  return `${Math.round(s / 86400)}${L("d", "д")}`;
}

// The `gh issue list` arguments for a filter. Search uses GitHub's own syntax.
export function listArgs({ state, mine, search }) {
  const args = ["issue", "list", "--state", state, "--limit", "60", "--json", LIST_FIELDS];
  if (mine) args.push("--assignee", "@me");
  if (search?.trim()) args.push("--search", search.trim());
  return args;
}

// `gh issue create`/`edit` print the issue URL: its number.
export const numberFromUrl = (text) => Number(/\/issues\/(\d+)/.exec(text ?? "")?.[1]) || null;

// A readable message for the usual gh failures.
export function explain(error) {
  if (/gh: command not found|executable file not found|No such file/i.test(error)) return L("Install the GitHub CLI: brew install gh", "Установи GitHub CLI: brew install gh");
  if (/auth login|authentication/i.test(error)) return L("Log in to GitHub: gh auth login", "Войди в GitHub: gh auth login");
  if (/no git remotes|none of the git remotes|not a git repository|^Не git/i.test(error)) return L("No GitHub repository in this folder", "В этой папке нет репозитория GitHub");
  if (/has disabled issues/i.test(error)) return L("Issues are turned off for this repository", "В этом репозитории выключены Issues");
  return error;
}

export class Issues {
  init(_p, cx) {
    this.view = "list";           // "list" | "issue" | "form"
    this.filter = { state: "open", mine: false, search: "" };
    this.list = null; this.issue = null; this.labels = []; this.repo = null; this.me = null;
    this.error = null; this.note = null; this.loading = false; this.busy = false;
    this.draftLabels = new Set(); this.draftAssign = false; this.editing = null; this.arming = null;
    this.search = InputState.new({ placeholder: L("Search issues…", "Поиск задач…") });
    this.search.on("submit", (_e, cx) => { this.filter.search = this.search.value(); this.refresh(cx); });
    this.search.on("change", (_e, cx) => { if (!this.search.value() && this.filter.search) { this.filter.search = ""; this.refresh(cx); } });
    this.title = InputState.new({ placeholder: L("Title", "Заголовок") });
    this.title.on("submit", (_e, cx) => this.save(cx));
    this.body = TextareaState.new({ placeholder: L("Description (Markdown)", "Описание (Markdown)"), rows: 8 });
    this.comment = TextareaState.new({ placeholder: L("Write a comment…", "Написать комментарий…"), rows: 3 });
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => { if (this.view === "list") this.refresh(cx, true); });
  }

  gh(args) {
    const { cwd, on } = location();
    return exec("gh", args, { cwd: this.root ?? cwd, on, timeout: 30000 });
  }
  async json(args) {
    const r = await this.gh(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return JSON.parse(r.stdout || "null");
  }
  async must(args) {
    const r = await this.gh(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return r.stdout;
  }

  refresh(cx, quiet = false) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.list = null; this.issue = null; this.repo = null;
      this.labels = []; this.error = null; this.view = "list";
    }
    if (!cwd) return;
    this.loading = true;
    if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on, timeout: 15000 });
          if (top.code !== 0) throw new Error(L("Not a git repository", "Не git-репозиторий"));
          if (key() !== context) return;
          this.root = top.stdout.trim();
        }
        const [repo, list, labels, me] = await Promise.all([
          this.repo ?? this.json(["repo", "view", "--json", "nameWithOwner,url,hasIssuesEnabled"]),
          this.json(listArgs(this.filter)),
          this.labels.length ? this.labels : this.json(["label", "list", "--limit", "100", "--json", "name,color"]).catch(() => []),
          this.me ?? this.must(["api", "user", "--jq", ".login"]).then((s) => s.trim()).catch(() => null),
        ]);
        if (key() !== context) return;
        this.repo = repo; this.list = list ?? []; this.labels = labels ?? []; this.me = me; this.error = null;
      } catch (e) {
        if (key() === context) { this.error = String(e.message ?? e); this.list = null; }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  show(number, cx) {
    this.view = "issue"; this.arming = null; this.note = null;
    if (this.issue?.number !== number) this.issue = { number, loading: true };
    const context = key();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const issue = await this.json(["issue", "view", String(number), "--json", VIEW_FIELDS]);
        if (key() === context && this.issue?.number === number) this.issue = issue;
      } catch (e) {
        if (key() === context) this.issue = { number, error: String(e.message ?? e) };
      }
      cx.notify();
    });
  }

  // One write, then the issue (and the list) read again. Errors stay in view.
  act(args, cx, after) {
    if (this.busy) return;
    this.busy = true; this.note = null; cx.notify();
    const context = key();
    cx.spawn(async (cx) => {
      try {
        const out = await this.must(args);
        if (key() !== context) return;
        const number = after?.(out) ?? (this.view === "issue" ? this.issue?.number : null);
        if (number) this.show(number, cx);
        this.refresh(cx, true);
      } catch (e) {
        if (key() === context) this.note = explain(String(e.message ?? e));
      } finally {
        this.busy = false; cx.notify();
      }
    });
  }

  newIssue(cx) {
    this.view = "form"; this.editing = null; this.note = null;
    this.title.set_value(""); this.body.set_value(""); this.draftLabels = new Set(); this.draftAssign = false;
    cx.timer.after(50, () => this.title.focus());
    cx.notify();
  }

  edit(cx) {
    const s = this.issue;
    if (!s?.title) return;
    this.view = "form"; this.editing = s.number; this.note = null;
    this.title.set_value(s.title); this.body.set_value(s.body ?? "");
    this.draftLabels = new Set((s.labels ?? []).map((l) => l.name));
    this.draftAssign = (s.assignees ?? []).some((a) => a.login === this.me);
    cx.timer.after(50, () => this.title.focus());
    cx.notify();
  }

  save(cx) {
    const title = this.title.value().trim(), body = this.body.value();
    if (!title) { this.note = L("A title is needed.", "Нужен заголовок."); cx.notify(); return; }
    if (this.editing) {
      const s = this.issue, had = new Set((s.labels ?? []).map((l) => l.name));
      const args = ["issue", "edit", String(this.editing), "--title", title, "--body", body];
      for (const name of this.draftLabels) if (!had.has(name)) args.push("--add-label", name);
      for (const name of had) if (!this.draftLabels.has(name)) args.push("--remove-label", name);
      const mine = (s.assignees ?? []).some((a) => a.login === this.me);
      if (this.draftAssign && !mine) args.push("--add-assignee", "@me");
      if (!this.draftAssign && mine) args.push("--remove-assignee", "@me");
      const number = this.editing;
      this.act(args, cx, () => number);
      return;
    }
    const args = ["issue", "create", "--title", title, "--body", body];
    for (const name of this.draftLabels) args.push("--label", name);
    if (this.draftAssign) args.push("--assignee", "@me");
    this.act(args, cx, (out) => {
      const number = numberFromUrl(out);
      if (!number) this.view = "list";
      return number;
    });
  }

  send(cx) {
    const text = this.comment.value();
    if (!text.trim() || !this.issue?.number) return;
    this.act(["issue", "comment", String(this.issue.number), "--body", text], cx, () => { this.comment.set_value(""); });
  }

  open(url) { if (url) openExternal(url).catch((e) => notify({ title: L("Not opened", "Не открылось"), body: String(e.message ?? e), level: "error" })); }

  async toAgent(s) {
    const target = (shared("files.agents") ?? {})[location().space];
    if (!target) return notify({ title: L("No agent", "Нет агента"), body: L("Click the agent terminal once and try again", "Кликни в терминал агента один раз и попробуй снова"), level: "warning" });
    await pasteInto(target, `Issue #${s.number} ${s.title} ${s.url} `).catch((e) => notify({ title: L("Not sent", "Не отправлено"), body: String(e.message ?? e), level: "error" }));
  }

  // ── drawing ──

  button(t, id, glyph, fallback, hint, fn, enabled = true) {
    return div().id(id).h(25).min_w(24).px(5).flex().items_center().justify_center().rounded(radius(5))
      .text_color(enabled ? t.muted : t.dim).tooltip(hint)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(fn))
      .child(style("agency") === true ? svg(px(glyph)).size(15) : fallback);
  }

  pill(t, id, label, on, fn) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(radius(5)).text_size(fontSize("files.meta"))
      .border_1().border_color(on ? t.foreground + "60" : t.border).bg(on ? t.foreground + "14" : t.background)
      .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(fn).child(label);
  }

  label(t, l, i, on = true) {
    const color = /^[0-9a-f]{6}$/i.test(l.color ?? "") ? `#${l.color}` : t.dim;
    return h_flex().id(`issue-label-${i}-${l.name}`).flex_none().h(18).px(6).gap(4).items_center().rounded(radius(9))
      .bg(on ? color + "2e" : t.background).border_1().border_color(on ? color + "90" : t.border)
      .text_size(fontSize("files.badge")).text_color(on ? t.foreground : t.dim)
      .child(div().size(6).flex_none().rounded(radius(3)).bg(color)).child(div().truncate().child(l.name));
  }

  state(t, s) {
    const open = s.state === "OPEN";
    const color = open ? t.done : s.stateReason === "NOT_PLANNED" ? t.dim : t.accent;
    return div().flex_none().h(18).px(6).flex().items_center().rounded(radius(4)).bg(color + "24")
      .text_size(fontSize("files.badge")).text_color(color)
      .child(open ? L("open", "открыта") : s.stateReason === "NOT_PLANNED" ? L("not planned", "не планируется") : L("closed", "закрыта"));
  }

  field(t, el, focused = false) {
    return div().w_full().px(8).py(5).rounded(radius(6)).border_1().border_color(focused ? t.accent : t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(el);
  }

  // Markdown as written, line by line: readable without a renderer.
  text(t, body) {
    const lines = (body ?? "").replace(/\r/g, "").split("\n");
    return v_flex().gap(2).text_size(fontSize("files.body")).text_color(t.foreground)
      .children(lines.map((line, i) => div().id(`issue-line-${i}`).min_h(14)
        .when(/^#{1,6}\s/.test(line), (e) => e.font_weight(appearance().weights.semibold))
        .when(/^\s*```/.test(line) || /^ {4}/.test(line), (e) => e.font_family(appearance().fonts.mono).text_color(t.muted))
        .child(line.replace(/^#{1,6}\s+/, "") || " ")));
  }

  listView(t) {
    const rows = [];
    rows.push(h_flex().flex_none().px(4).pb(6).gap(5).items_center().flex_wrap()
      .child(this.pill(t, "issues-open", L("Open", "Открытые"), this.filter.state === "open", (_e, cx) => { this.filter.state = "open"; this.refresh(cx); }))
      .child(this.pill(t, "issues-closed", L("Closed", "Закрытые"), this.filter.state === "closed", (_e, cx) => { this.filter.state = "closed"; this.refresh(cx); }))
      .child(this.pill(t, "issues-mine", L("Mine", "Мои"), this.filter.mine, (_e, cx) => { this.filter.mine = !this.filter.mine; this.refresh(cx); })));
    rows.push(div().flex_none().px(4).pb(6).child(this.field(t, Input.new(this.search).h(20).text_size(12).text_color(t.foreground))));
    if (this.list && !this.list.length) rows.push(div().p(8).text_size(fontSize("files.hint")).text_color(t.dim)
      .child(this.filter.search ? L("Nothing found.", "Ничего не найдено.") : this.filter.state === "open" ? L("No open issues. + creates one.", "Открытых задач нет. + создаёт новую.") : L("No closed issues.", "Закрытых задач нет.")));
    for (const [i, s] of (this.list ?? []).entries()) {
      const assignee = s.assignees?.[0]?.login;
      rows.push(v_flex().id(`issue-row-${s.number}`).flex_none().px(8).py(5).gap(3).rounded(radius(6)).cursor_pointer()
        .hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.show(s.number, cx))
        .child(h_flex().gap(8).items_center()
          .child(div().size(7).flex_none().rounded(radius(4)).bg(s.state === "OPEN" ? t.done : t.dim))
          .child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("files.meta")).text_color(t.dim).child(`#${s.number}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(s.title).child(s.title))
          .child(div().id(`issue-at-${s.number}`).flex_none().px(4).text_color(t.dim).hover((h) => h.text_color(t.foreground))
            .tooltip(L("Paste into the agent", "Вставить агенту"))
            .on_click((_e, cx) => { cx.stop_propagation(); this.toAgent(s); }).child("@")))
        .when(Boolean(s.labels?.length || assignee), (e) => e.child(h_flex().pl(15).gap(4).items_center().min_w(0).overflow_hidden()
          .children((s.labels ?? []).slice(0, 4).map((l) => this.label(t, l, `r${i}`)))
          .child(div().flex_1())
          .when(Boolean(assignee), (e) => e.child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.dim).child(`@${assignee}`)))
          .child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.dim).child(ago(s.updatedAt))))));
    }
    return rows;
  }

  issueView(t) {
    const s = this.issue;
    if (!s) return [];
    if (s.loading) return [div().p(8).text_size(fontSize("files.hint")).text_color(t.dim).child(L("Loading…", "Загружаю…"))];
    if (s.error) return [div().p(8).text_size(fontSize("files.hint")).text_color(t.blocked).child(explain(s.error))];
    const open = s.state === "OPEN", mine = (s.assignees ?? []).some((a) => a.login === this.me);
    const action = (id, label, fn, tone) => div().id(id).h(26).px(9).flex().items_center().rounded(radius(6)).border_1()
      .border_color(tone ? tone + "70" : t.border).text_size(fontSize("files.meta")).text_color(tone ?? t.foreground)
      .when(!this.busy, (e) => e.cursor_pointer().hover((h) => h.bg(tone ? tone + "1c" : t.hover)).on_click(fn))
      .when(this.busy, (e) => e.opacity(0.5)).child(label);
    const labelNames = new Set((s.labels ?? []).map((l) => l.name));
    const rows = [
      v_flex().flex_none().px(8).pb(8).gap(6)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_family(appearance().fonts.mono).text_color(t.dim).child(`#${s.number}`))
          .child(this.state(t, s)).child(div().flex_1())
          .child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.dim).child(`@${s.author?.login ?? "?"} · ${ago(s.createdAt)}`)))
        .child(div().text_size(fontSize("files.body") + 2).font_weight(appearance().weights.semibold).text_color(t.foreground).child(s.title))
        .child(h_flex().gap(4).flex_wrap().items_center()
          .children((s.labels ?? []).map((l) => this.label(t, l, "v")))
          .when(Boolean(s.assignees?.length), (e) => e.child(div().text_size(fontSize("files.meta")).text_color(t.dim)
            .child(L("assignee: ", "исполнитель: ") + s.assignees.map((a) => "@" + a.login).join(", ")))))
        .child(h_flex().gap(5).flex_wrap().items_center()
          .child(action("issue-edit", L("Edit", "Изменить"), (_e, cx) => this.edit(cx)))
          .when(Boolean(this.me), (e) => e.child(action("issue-assign", mine ? L("Unassign me", "Снять с себя") : L("Assign me", "Взять себе"),
            (_e, cx) => this.act(["issue", "edit", String(s.number), mine ? "--remove-assignee" : "--add-assignee", "@me"], cx))))
          .child(open
            ? action("issue-close", this.arming === "close" ? L("Click again to close", "Нажми ещё раз") : L("Close", "Закрыть"), (_e, cx) => {
              if (this.arming !== "close") { this.arming = "close"; cx.notify(); return; }
              this.arming = null; this.act(["issue", "close", String(s.number)], cx);
            }, t.blocked)
            : action("issue-reopen", L("Reopen", "Открыть снова"), (_e, cx) => this.act(["issue", "reopen", String(s.number)], cx), t.done))
          .child(action("issue-agent", L("@ to agent", "@ агенту"), () => this.toAgent(s)))
          .child(action("issue-web", "GitHub ↗", () => this.open(s.url)))),
    ];
    // Labels toggle in place: one click adds or removes.
    if (this.labels.length) rows.push(h_flex().flex_none().px(8).pb(8).gap(4).flex_wrap()
      .children(this.labels.map((l, i) => div().id(`issue-toggle-${i}`).cursor_pointer().when(this.busy, (e) => e.opacity(0.5))
        .on_click((_e, cx) => this.act(["issue", "edit", String(s.number), labelNames.has(l.name) ? "--remove-label" : "--add-label", l.name], cx))
        .child(this.label(t, l, `t${i}`, labelNames.has(l.name))))));
    rows.push(v_flex().flex_none().mx(4).mb(8).p(8).rounded(radius(6)).bg(t.foreground + "08").border_1().border_color(t.border)
      .child(s.body?.trim() ? this.text(t, s.body) : div().text_color(t.dim).child(L("No description.", "Без описания."))));
    for (const [i, c] of (s.comments ?? []).entries()) {
      rows.push(v_flex().id(`issue-comment-${i}`).flex_none().mx(4).mb(6).p(8).gap(4).rounded(radius(6)).border_1().border_color(t.border)
        .child(div().text_size(fontSize("files.meta")).text_color(t.dim).child(`@${c.author?.login ?? "?"} · ${ago(c.createdAt)}`))
        .child(this.text(t, c.body)));
    }
    rows.push(v_flex().flex_none().mx(4).mt(2).gap(6)
      .child(this.field(t, Textarea.new(this.comment).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6).items_center().child(div().flex_1())
        .child(action("issue-comment", this.busy ? L("Sending…", "Отправляю…") : L("Comment", "Комментировать"), (_e, cx) => this.send(cx)))));
    return rows;
  }

  formView(t) {
    const editing = this.editing;
    return [
      v_flex().flex_none().px(4).gap(8)
        .child(div().px(4).text_size(fontSize("files.meta")).text_color(t.dim)
          .child(editing ? L(`Editing #${editing}`, `Изменение #${editing}`) : L("New issue", "Новая задача")))
        .child(this.field(t, Input.new(this.title).h(22).text_size(13).text_color(t.foreground)))
        .child(this.field(t, Textarea.new(this.body).w_full().text_size(12).text_color(t.foreground)))
        .when(this.labels.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap()
          .children(this.labels.map((l, i) => div().id(`form-label-${i}`).cursor_pointer()
            .on_click((_e, cx) => { this.draftLabels.has(l.name) ? this.draftLabels.delete(l.name) : this.draftLabels.add(l.name); cx.notify(); })
            .child(this.label(t, l, `f${i}`, this.draftLabels.has(l.name)))))))
        .child(h_flex().gap(6).items_center()
          .when(Boolean(this.me), (e) => e.child(this.pill(t, "form-assign", L("Assign to me", "Назначить на меня"), this.draftAssign, (_e, cx) => { this.draftAssign = !this.draftAssign; cx.notify(); })))
          .child(div().flex_1())
          .child(div().id("form-cancel").h(28).px(10).flex().items_center().rounded(radius(6)).text_color(t.muted).cursor_pointer()
            .hover((h) => h.bg(t.hover)).on_click((_e, cx) => { this.view = editing ? "issue" : "list"; this.note = null; cx.notify(); }).child(L("Cancel", "Отмена")))
          .child(div().id("form-save").h(28).px(12).flex().items_center().rounded(radius(6)).bg(this.busy ? t.raised : t.solid)
            .text_color(this.busy ? t.dim : t.solid_foreground).font_weight(appearance().weights.semibold)
            .when(!this.busy, (e) => e.cursor_pointer().hover((h) => h.opacity(0.88)).on_click((_e, cx) => this.save(cx)))
            .child(this.busy ? L("Saving…", "Сохраняю…") : editing ? L("Save", "Сохранить") : L("Create", "Создать")))),
    ];
  }

  render(cx) {
    if (key() !== this.context && cx) this.refresh(cx, true);
    const t = theme();
    const head = (text) => div().font_weight(appearance().weights.semibold).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(text);
    const message = this.error ? explain(this.error) : this.loading && !this.list ? L("Loading issues…", "Загружаю задачи…") : null;
    const back = this.view !== "list";
    const body = this.view === "issue" ? this.issueView(t) : this.view === "form" ? this.formView(t) : this.listView(t);
    return v_flex().id("issues").size_full().min_h(0).rounded(radius(10)).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(fontSize("files.body"))
      .child(h_flex().h(metric("files.toolbar")).flex_none().px(10).gap(3).items_center()
        .when(back, (el) => el.child(this.button(t, "issues-back", "fold-right", "‹", L("Back to the list", "К списку"), (_e, cx) => { this.view = "list"; this.note = null; this.arming = null; cx.notify(); })))
        .child(head(labelFont() ? L("ISSUES", "ЗАДАЧИ") : L("Issues", "Задачи")))
        .child(div().flex_1().min_w(0).truncate().px(6).text_size(fontSize("files.meta")).text_color(t.dim).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(this.repo?.nameWithOwner ?? ""))
        .when(this.loading || this.busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.dim).spin(900)))
        .child(this.button(t, "issues-refresh", "refresh", "↻", L("Refresh", "Обновить"), (_e, cx) => { this.refresh(cx); if (this.view === "issue" && this.issue?.number) this.show(this.issue.number, cx); }))
        .when(Boolean(this.repo), (el) => el.child(this.button(t, "issues-new", "plus", "+", L("New issue", "Новая задача"), (_e, cx) => this.newIssue(cx)))))
      .child(v_flex().id("issues-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(Boolean(message), (el) => el.child(div().p(8).text_size(fontSize("files.hint")).text_color(this.error ? t.blocked : t.dim).child(message)))
        .when(Boolean(this.note), (el) => el.child(div().mx(4).mb(6).px(8).py(6).rounded(radius(6)).bg(t.blocked + "18").text_size(fontSize("files.meta")).text_color(t.blocked).child(this.note)))
        .when(!this.error, (el) => el.children(body)));
  }
}
