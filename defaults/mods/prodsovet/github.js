import { appearance, fontSize, metric, radius, labelFont, style, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// GitHub panel for the focused folder's repository, read with the `gh` CLI:
// the current branch (ahead/behind, last commit), its pull request, your PRs,
// review requests, other open PRs, recent workflow runs and open issues.
// A row opens in the browser; "@" pastes its link into the space's agent.
// Read only: it never pushes, merges or comments.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, shared, run, notify } from "finch";
import { openExternal, pasteInto } from "./filesystem.js";

const REFRESH = 120000;
const px = (name) => `mods/prodsovet/art/px/${name}.svg`;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => { const l = location(); return JSON.stringify([l.cwd, l.on]); };

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}${L("m", "м")}`;
  if (s < 86400) return `${Math.round(s / 3600)}${L("h", "ч")}`;
  return `${Math.round(s / 86400)}${L("d", "д")}`;
}

// A check rollup or a run, as one state: pass, fail, pending or none.
function checks(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  if (!list.length) return "none";
  const value = (c) => (c.conclusion || c.state || c.status || "").toUpperCase();
  if (list.some((c) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(value(c)))) return "fail";
  if (list.some((c) => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(value(c)))) return "pending";
  return "pass";
}
const runState = (r) => (r.status !== "completed" ? "pending" : r.conclusion === "success" ? "pass" : ["skipped", "neutral"].includes(r.conclusion) ? "none" : "fail");

export class GitHub {
  init(_p, cx) {
    this.data = null;
    this.error = null;
    this.loading = false;
    this.folded = new Set();
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => this.refresh(cx, true));
  }

  refresh(cx, quiet = false) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.data = null; this.error = null; }
    if (!cwd) return;
    this.loading = true;
    if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      const sh = (cmd, args, at = cwd) => exec(cmd, args, { cwd: at, on, timeout: 30000 });
      const json = async (args, at) => {
        const r = await sh("gh", args, at);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        return JSON.parse(r.stdout || "null");
      };
      try {
        const top = await sh("git", ["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) throw new Error(L("Not a git repository", "Не git-репозиторий"));
        const root = top.stdout.trim();
        const [branch, counts, last] = await Promise.all([
          sh("git", ["branch", "--show-current"], root),
          sh("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], root),
          sh("git", ["log", "-1", "--format=%s%x00%cI"], root),
        ]);
        const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
        const [subject, when] = last.stdout.trim().split("\0");
        const repo = await json(["repo", "view", "--json", "nameWithOwner,url"], root);
        const fields = "number,title,url,isDraft,reviewDecision,statusCheckRollup,headRefName,author,updatedAt";
        const [status, open, runs, issues] = await Promise.all([
          json(["pr", "status", "--json", fields], root),
          json(["pr", "list", "--state", "open", "--limit", "15", "--json", fields], root),
          json(["run", "list", "--limit", "6", "--json", "status,conclusion,workflowName,headBranch,url,createdAt,displayTitle"], root),
          json(["issue", "list", "--state", "open", "--limit", "8", "--json", "number,title,url,updatedAt,labels"], root).catch(() => []),
        ]);
        if (key() !== context) return;
        const mine = new Set([status.currentBranch?.number, ...(status.createdBy ?? []).map((p) => p.number), ...(status.needsReview ?? []).map((p) => p.number)].filter(Boolean));
        this.data = {
          root, repo, branch: branch.stdout.trim() || "(detached)", ahead, behind, subject, when,
          current: status.currentBranch ?? null,
          createdBy: (status.createdBy ?? []).filter((p) => p.number !== status.currentBranch?.number),
          needsReview: status.needsReview ?? [],
          others: (open ?? []).filter((p) => !mine.has(p.number)),
          runs: runs ?? [], issues: issues ?? [],
          at: Date.now(),
        };
        this.error = null;
      } catch (e) {
        if (key() === context) { this.error = String(e.message ?? e); this.data = null; }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  open(url) { if (url) openExternal(url).catch((e) => notify({ title: L("Not opened", "Не открылось"), body: String(e.message ?? e), level: "error" })); }

  // Paste "PR #12 title <url>" into the space's agent, as the editor's "@ to agent" does.
  async toAgent(text) {
    const target = (shared("files.agents") ?? {})[location().space];
    if (!target) return notify({ title: L("No agent", "Нет агента"), body: L("Click the agent terminal once and try again", "Кликни в терминал агента один раз и попробуй снова"), level: "warning" });
    await pasteInto(target, text + " ").catch((e) => notify({ title: L("Not sent", "Не отправлено"), body: String(e.message ?? e), level: "error" }));
  }

  mark(t, state) {
    const color = { pass: t.done, fail: t.blocked, pending: t.working }[state];
    if (state === "pending") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(color).spin(1100);
    return div().size(7).mx(2).flex_none().when(Boolean(color), (e) => e.bg(color)).when(!color, (e) => e.border_1().border_color(t.dim));
  }

  section(t, id, title, count, rows) {
    if (!rows.length) return [];
    const open = !this.folded.has(id);
    const head = h_flex().id(`gh-sec-${id}`).h(26).flex_none().px(8).gap(6).items_center().cursor_pointer()
      .text_size(fontSize("files.meta")).text_color(t.dim).when(Boolean(labelFont()), (e) => e.font_family(labelFont()))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
      .child(div().child(title)).child(div().child(String(count))).child(div().flex_1())
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none());
    return [head, ...(open ? rows : [])];
  }

  pr(t, p, i) {
    const state = checks(p.statusCheckRollup);
    const review = p.reviewDecision === "APPROVED" ? [L("approved", "одобрен"), t.done] : p.reviewDecision === "CHANGES_REQUESTED" ? [L("changes", "правки"), t.blocked] : null;
    return h_flex().id(`gh-pr-${i}-${p.number}`).min_h(metric("files.row")).py(3).flex_none().px(8).gap(8).items_center().rounded(radius(6)).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => this.open(p.url))
      .child(this.mark(t, state))
      .child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("files.meta")).text_color(t.dim).child(`#${p.number}`))
      .child(div().flex_1().min_w(0).truncate().text_color(p.isDraft ? t.muted : t.foreground).tooltip(p.title).child(p.title))
      .when(Boolean(review), (e) => e.child(div().flex_none().text_size(fontSize("files.badge")).text_color(review[1]).child(review[0])))
      .when(p.isDraft, (e) => e.child(div().flex_none().text_size(fontSize("files.badge")).text_color(t.dim).child(L("draft", "черновик"))))
      .child(div().id(`gh-at-${i}-${p.number}`).flex_none().px(4).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip(L("Paste into the agent", "Вставить агенту"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toAgent(`PR #${p.number} ${p.title} ${p.url}`); }).child("@"));
  }

  render(cx) {
    // Another folder in focus (a space or pane switch): read its repository.
    if (key() !== this.context && cx) this.refresh(cx, true);
    const t = theme();
    const d = this.data;
    const label = (text) => div().font_weight(appearance().weights.semibold).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(text);
    const button = (id, name, fallback, fn) => div().id(id).h(25).min_w(24).px(5).flex().items_center().justify_center().rounded(radius(5)).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(fn)
      .child(style("agency") === true ? svg(px(name)).size(15) : fallback);
    const rows = [];
    if (d) {
      const sync = [d.ahead ? `↑${d.ahead}` : "", d.behind ? `↓${d.behind}` : ""].filter(Boolean).join(" ");
      rows.push(v_flex().id("gh-branch").flex_none().mx(2).mb(6).px(8).py(7).gap(3).bg(t.foreground + "0d").rounded(radius(6))
        .child(h_flex().gap(8).items_center()
          .child(svg(style("agency") === true ? px("branch") : "mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().font_family(appearance().fonts.mono).text_color(t.foreground).child(d.branch))
          .when(Boolean(sync), (e) => e.child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("files.meta")).text_color(d.ahead ? t.working : t.blocked).child(sync)))
          .when(d.ahead === 0 && d.behind === 0, (e) => e.child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.done).child(L("in sync", "синхронно")))))
        .when(Boolean(d.subject), (e) => e.child(h_flex().gap(6).text_size(fontSize("files.meta")).text_color(t.dim)
          .child(div().flex_1().min_w(0).truncate().tooltip(d.subject).child(d.subject)).child(div().flex_none().child(ago(d.when))))));
      if (d.current) rows.push(...this.section(t, "current", L("THIS BRANCH", "ЭТА ВЕТКА"), 1, [this.pr(t, d.current, "c")]));
      else rows.push(div().px(8).pb(6).text_size(fontSize("files.meta")).text_color(t.dim).child(L("No pull request for this branch", "У этой ветки нет pull request")));
      rows.push(...this.section(t, "review", L("REVIEW REQUESTS", "ЖДУТ РЕВЬЮ"), d.needsReview.length, d.needsReview.map((p) => this.pr(t, p, "r"))));
      rows.push(...this.section(t, "mine", L("YOUR PRS", "ТВОИ PR"), d.createdBy.length, d.createdBy.map((p) => this.pr(t, p, "m"))));
      rows.push(...this.section(t, "others", L("OPEN PRS", "ОТКРЫТЫЕ PR"), d.others.length, d.others.map((p) => this.pr(t, p, "o"))));
      rows.push(...this.section(t, "runs", L("WORKFLOWS", "СБОРКИ"), d.runs.length, d.runs.map((r, i) =>
        h_flex().id(`gh-run-${i}`).h(metric("files.row")).flex_none().px(8).gap(8).items_center().rounded(radius(6)).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => this.open(r.url))
          .child(this.mark(t, runState(r)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(r.displayTitle || r.workflowName || "").child(r.workflowName || r.displayTitle || L("workflow", "сборка")))
          .child(div().flex_none().max_w(110).truncate().font_family(appearance().fonts.mono).text_size(fontSize("files.meta")).text_color(t.dim).child(r.headBranch))
          .child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.dim).child(ago(r.createdAt))))));
      rows.push(...this.section(t, "issues", L("ISSUES", "ЗАДАЧИ"), d.issues.length, d.issues.map((s, i) =>
        h_flex().id(`gh-issue-${i}`).h(metric("files.row")).flex_none().px(8).gap(8).items_center().rounded(radius(6)).cursor_pointer()
          .hover((h) => h.bg(t.hover)).on_click(() => this.open(s.url))
          .child(div().flex_none().font_family(appearance().fonts.mono).text_size(fontSize("files.meta")).text_color(t.dim).child(`#${s.number}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(s.title).child(s.title))
          .child(div().flex_none().text_size(fontSize("files.meta")).text_color(t.dim).child(ago(s.updatedAt))))));
    }
    const message = this.error
      ? (/gh: command not found|executable file not found|No such file/i.test(this.error) ? L("Install the GitHub CLI: brew install gh", "Установи GitHub CLI: brew install gh")
        : /auth login|authentication/i.test(this.error) ? L("Log in to GitHub: gh auth login", "Войди в GitHub: gh auth login")
        : /no git remotes|none of the git remotes|not a git repository|^Не git/i.test(this.error) ? L("No GitHub repository in this folder", "В этой папке нет репозитория GitHub")
        : this.error)
      : this.loading && !d ? L("Loading GitHub…", "Загружаю GitHub…") : null;
    return v_flex().id("github").size_full().min_h(0).rounded(radius(10)).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(fontSize("files.body"))
      .child(h_flex().h(metric("files.toolbar")).flex_none().px(10).gap(3).items_center()
        .child(label(labelFont() ? "GITHUB" : "GitHub"))
        .child(div().flex_1().min_w(0).truncate().px(6).text_size(fontSize("files.meta")).text_color(t.dim).when(Boolean(labelFont()), (el) => el.font_family(labelFont())).child(d?.repo?.nameWithOwner ?? ""))
        .when(this.loading, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.dim).spin(900)))
        .child(button("gh-refresh", "refresh", "↻", (_e, cx) => this.refresh(cx)))
        .when(Boolean(d?.repo?.url), (el) => el.child(button("gh-web", "reveal", "↗", () => this.open(d.repo.url)))))
      .child(v_flex().id("gh-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(Boolean(message), (el) => el.child(div().p(8).text_size(fontSize("files.hint")).text_color(this.error ? t.blocked : t.dim).child(message)))
        .children(rows));
  }
}
