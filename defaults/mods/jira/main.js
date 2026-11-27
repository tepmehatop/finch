// Finch: Jira issues to agents.
//
// Lists issues from Jira Server / Data Center (or Cloud) by a JQL query. An
// issue goes to work as a new branch and worktree with an agent that gets the
// issue as its first message, or to the agent in the focused terminal.
// Connection settings are in ~/.config/finch/jira.json (the token too, in
// plain text: keep the file yours). Requests run through curl, so the
// system's proxy settings and certificates apply; "insecure" allows a
// self-signed certificate.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView } from "gpui-base";
import { theme, appHome, home, readTextFile, writeTextFile, exec, hc, knownAgents, focused, spaces, panes, run, notify, checking, tr } from "finch";
import { launch, slug } from "./plan.js";

const DEFAULT_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";

export default class Jira extends View {
  init(_props, cx) {
    this.cfg = null;
    this.raw = null;
    this.issues = [];
    this.open = null;
    this.error = null;
    this.loading = false;
    this.agents = [];
    this.inputs = {
      url: InputState.new({ placeholder: tr("https://jira.example.com") }),
      user: InputState.new({ placeholder: tr("User (only for a password)") }),
      token: InputState.new({ placeholder: tr("Personal access token (or password)") }),
      jql: InputState.new({ placeholder: tr(DEFAULT_JQL) }),
    };
    this.insecure = false;
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.load();
      this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed);
      if (this.cfg?.url) await this.fetch();
      cx.notify();
    });
  }

  file() {
    return `${appHome()}/jira.json`;
  }

  async load() {
    this.raw = await readTextFile(this.file()).catch(() => null);
    try { this.cfg = this.raw ? JSON.parse(this.raw) : null; } catch { this.cfg = null; }
  }

  editSettings(cx) {
    const c = this.cfg ?? {};
    this.inputs.url.set_value(c.url ?? "");
    this.inputs.user.set_value(c.user ?? "");
    this.inputs.token.set_value(c.token ?? "");
    this.inputs.jql.set_value(c.jql ?? DEFAULT_JQL);
    this.insecure = Boolean(c.insecure);
    this.editing = true;
    cx.notify();
  }

  saveSettings(cx) {
    const cfg = {
      url: this.inputs.url.value().trim().replace(/\/+$/, ""),
      user: this.inputs.user.value().trim(),
      token: this.inputs.token.value().trim(),
      jql: this.inputs.jql.value().trim() || DEFAULT_JQL,
      insecure: this.insecure,
    };
    cx.spawn(async (cx) => {
      const text = JSON.stringify(cfg, null, 2) + "\n";
      try {
        await writeTextFile(this.file(), text, this.raw);
        this.raw = text;
        this.cfg = cfg;
        this.editing = false;
        await this.fetch();
      } catch (e) {
        notify({ title: "Not saved", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  async curl(path) {
    const c = this.cfg;
    const args = ["-sS", "--max-time", "30", "-H", "Accept: application/json"];
    if (c.insecure) args.push("-k");
    if (c.user) args.push("-u", `${c.user}:${c.token}`);
    else if (c.token) args.push("-H", `Authorization: Bearer ${c.token}`);
    args.push("-w", "\n%{http_code}", `${c.url}${path}`);
    const r = await exec("curl", args, { timeout: 40000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "curl failed");
    const at = r.stdout.lastIndexOf("\n");
    const status = Number(r.stdout.slice(at + 1));
    const body = r.stdout.slice(0, at);
    if (status === 401 || status === 403) throw new Error(`Jira refused the credentials (HTTP ${status})`);
    if (status >= 400) throw new Error(`Jira answered HTTP ${status}`);
    return JSON.parse(body);
  }

  async fetch() {
    this.loading = true;
    this.error = null;
    try {
      const q = encodeURIComponent(this.cfg.jql || DEFAULT_JQL);
      const d = await this.curl(`/rest/api/2/search?jql=${q}&maxResults=50&fields=summary,status,priority,description,issuetype`);
      this.issues = (d.issues ?? []).map((i) => ({
        key: i.key,
        summary: i.fields?.summary ?? "",
        status: i.fields?.status?.name ?? "",
        type: i.fields?.issuetype?.name ?? "",
        description: i.fields?.description ?? "",
      }));
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.loading = false;
  }

  task(i) {
    return `Jira issue ${i.key}: ${i.summary}\n\n${(i.description || "").trim()}\n\n${this.cfg.url}/browse/${i.key}`.trim();
  }

  toWork(i, agent, cx) {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const cwd = pane?.cwd || f?.cwd || space?.folder;
    if (!cwd) return notify({ title: "Open a space in the issue's repository first", level: "info" });
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
        if (top.code !== 0) throw new Error("not a git repository");
        const root = top.stdout.trim();
        const branch = `${i.key}-${slug(i.summary)}`;
        const dir = `${home()}/.finch/worktrees/${root.split("/").pop()}/${branch}`;
        const r = await exec("git", ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: root });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git worktree add failed");
        run("space.new", { folder: dir, name: i.key, argv: launch(agent, this.task(i)) });
        notify({ title: `${i.key} is with ${agent.name}`, body: `Branch ${branch}`, level: "info" });
      } catch (e) {
        notify({ title: "Couldn't start", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  toFocused(i, cx) {
    const t = focused()?.terminal;
    if (!t) return notify({ title: "No terminal is focused", body: "Click an agent's terminal, then send again.", level: "info" });
    cx.spawn(async () => { await hc(["send", t, this.task(i)]).catch(() => null); });
  }

  // Drawing ------------------------------------------------------------

  button(t, id, label, onClick, primary) {
    return div().id(id).flex_none().px(9).py(3).rounded(6).text_size(12).cursor_pointer()
      .when(Boolean(primary), (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold().hover((s) => s.opacity(0.9)))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick)
      .child(label);
  }

  settingsForm(t) {
    const field = (label, input) => v_flex().gap(4).child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(div().rounded(6).border_1().border_color(t.input).px(8).py(4).child(Input.new(input)));
    return v_flex().p(12).gap(10)
      .child(field("Jira address", this.inputs.url))
      .child(field("Token", this.inputs.token))
      .child(field("User", this.inputs.user))
      .child(field("JQL", this.inputs.jql))
      .child(h_flex().id("jira-insecure").gap(8).items_center().cursor_pointer().on_click((_e, cx) => { this.insecure = !this.insecure; cx.notify(); })
        .child(div().size(14).rounded(4).border_1().border_color(this.insecure ? t.accent : t.input).bg(this.insecure ? t.accent : t.background)
          .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(this.insecure ? "✓" : ""))
        .child(div().text_size(12).text_color(t.muted).child("Don't check the certificate (self-signed)")))
      .child(div().text_size(11.5).text_color(t.dim).child("Saved in ~/.config/finch/jira.json, the token included."))
      .child(h_flex().gap(6).child(div().flex_1())
        .when(Boolean(this.cfg), (el) => el.child(this.button(t, "jira-cancel", "Cancel", (_e, cx) => { this.editing = false; cx.notify(); })))
        .child(this.button(t, "jira-save", "Save", (_e, cx) => this.saveSettings(cx), true)));
  }

  render(cx) {
    const t = theme();
    const header = h_flex().flex_none().h(40).px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(this.open), (el) => el.child(div().id("jira-back").cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.open = null; cx.notify(); }).child("←")))
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child(this.open ? this.open.key : "Jira"))
      .when(!this.editing && Boolean(this.cfg), (el) => el
        .child(this.button(t, "jira-refresh", this.loading ? "Loading…" : "Refresh", (_e, cx) => cx.spawn(async (cx) => { await this.fetch(); cx.notify(); })))
        .child(this.button(t, "jira-settings", "Settings", (_e, cx) => this.editSettings(cx))));
    let body;
    if (this.editing || !this.cfg) body = this.settingsForm(t);
    else if (this.open) {
      const i = this.open;
      body = v_flex().p(12).gap(10)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(i.summary))
        .child(div().text_size(11.5).text_color(t.dim).child(`${i.type} · ${i.status}`))
        .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`jira-d-${i.key}`, i.description || "—").selectable(true)))
        .child(div().pt(6).text_size(11.5).font_semibold().text_color(t.dim).child("TO WORK, ON A NEW BRANCH, WITH"))
        .child(h_flex().gap(6).flex_wrap().children(this.agents.map((a) => this.button(t, `jira-go-${a.key}`, a.name, (_e, cx) => this.toWork(i, a, cx), a.key === "gigacode"))))
        .child(this.button(t, "jira-send", "Send to the focused agent", (_e, cx) => this.toFocused(i, cx)));
    } else {
      body = v_flex()
        .when(Boolean(this.error), (el) => el.child(div().p(12).text_size(12.5).text_color(t.blocked).child(this.error)))
        .when(!this.error && !this.issues.length && !this.loading, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("No issues for this query")))
        .children(this.issues.map((i) => v_flex().id(`jira-${i.key}`).px(12).py(8).gap(2).cursor_pointer().border_b(1).border_color(t.border)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.open = i; cx.notify(); })
          .child(h_flex().gap(8).child(div().text_size(12).font_semibold().text_color(t.accent).child(i.key)).child(div().text_size(11).text_color(t.dim).child(i.status)))
          .child(div().text_size(12.5).text_color(t.foreground).child(i.summary))));
    }
    return v_flex().id("jira").size_full().bg(t.background).child(header)
      .child(v_flex().relative().flex_1().min_h(0)
        .child(div().id("jira-scroll").size_full().overflow_y_scroll().child(body))
        .child(Scrollbar.vertical("jira-scroll").absolute().inset_0()));
  }
}
