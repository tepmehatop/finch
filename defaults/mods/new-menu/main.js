import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, readTextFile, home, agents, notify } from "finch";

// Finch: programs the chat mod can read (mods/chat/main.js).
const CHAT = new Set(["claude", "gigacode", "qwen"]);

// Finch: models people can pick per agent, and the flag that passes one at launch.
// GigaCode's list comes from its token file (config.chat.models / config.agent.models).
const MODEL_FLAG = { gigacode: "-m", qwen: "-m", claude: "--model", codex: "-m" };
const FIXED_MODELS = { claude: ["sonnet", "opus", "haiku"] };

async function gigacodeModels() {
  try {
    const text = await readTextFile(`${home()}/.gigacode/gigacode_token.json`);
    const cfg = JSON.parse(text ?? "{}").config ?? {};
    const names = [...(cfg.chat?.models ?? []), ...(cfg.agent?.models ?? [])].map(m => m?.model ?? m?.name ?? m?.id).filter(Boolean);
    return [...new Set(names)];
  } catch {
    return [];
  }
}

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

export default class NewMenu extends View {
  init(_props, cx) {
    const machine = spaces().find(s => s.active)?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.models = { ...FIXED_MODELS };
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
        // Finch: GigaCode's models, read only when it's installed here.
        if (!machine && this.agents.some(a => a.key === "gigacode" && a.installed)) {
          const giga = await gigacodeModels();
          if (giga.length) this.models = { ...this.models, gigacode: giga };
        }
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }
  row(id, icon, name, action, hint = "", enabled = true, extra = null) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click(() => { if (enabled) { closeOverlay(props().overlay); action(); } })
      .child(icon).child(div().flex_1().child(name)).when(Boolean(extra), el => el.child(extra)).child(div().text_size(11).text_color(t.dim).child(hint));
  }
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    // Finch: agents the chat reads open with their chat beside them, unless turned off below.
    const withChat = shared("finch.chatWithAgents") !== false;
    const model = key => shared(`finch.model.${key}`) ?? null;
    const argvOf = agent => (model(agent.key) && MODEL_FLAG[agent.key] ? [...agent.run, MODEL_FLAG[agent.key], model(agent.key)] : agent.run);
    const startAgent = agent => {
      const args = { space: space?.id, argv: argvOf(agent), ...(withChat && CHAT.has(agent.key) ? { chat: true } : {}) };
      // Finch: over the concurrency limit (Settings > Mods), the agent waits its turn.
      const limit = Number(shared("finch.limit") ?? 0);
      if (limit > 0 && agents().filter(a => a.status === "working").length >= limit) {
        setShared("finch.queue", [...(shared("finch.queue") ?? []), { name: agent.name, args }]);
        notify({ title: `${agent.name} is queued`, body: `${limit} agents are working; it starts when one finishes.`, level: "info" });
        return;
      }
      run("tab.new", args);
    };
    // Finch: a chip on an agent's row cycles through its models (none = the agent's default).
    const modelChip = agent => {
      const list = (this.models ?? FIXED_MODELS)[agent.key] ?? [];
      if (!list.length || !agent.installed) return null;
      const now = model(agent.key);
      const next = now === null ? list[0] : list.indexOf(now) + 1 < list.length ? list[list.indexOf(now) + 1] : null;
      return div().id(`model-${agent.key}`).flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.border)
        .text_size(11).text_color(now ? t.foreground : t.dim).hover(s => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared(`finch.model.${agent.key}`, next); cx.notify(); })
        .child(now ?? "default model");
    };
    const installed = this.agents.filter(a => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    return v_flex().min_h(0).w_full().h(Math.min(552, 227 + Math.max(1, choices.length + (this.failed ? 1 : 0)) * 31)).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        startAgent(agent);
      })
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => run("tab.new", { space: space?.id }), shortcut("tab.new")))
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => startAgent(a), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed, modelChip(a))))
        .when(this.failed || this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))))
      .child(h_flex().id("chat-with-agents").h(29).px(9).gap(8).items_center().rounded(7).cursor_pointer().hover(el => el.bg(t.selected))
        .on_click((_e, cx) => { setShared("finch.chatWithAgents", !withChat); cx.notify(); })
        .child(div().size(14).flex_none().rounded(4).border_1().border_color(withChat ? t.accent : t.input).bg(withChat ? t.accent : t.popover)
          .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(withChat ? "✓" : ""))
        .child(div().flex_1().text_size(12).text_color(t.muted).child("Open the chat with the agent")))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("fanout", div().w(14).child("⑂"), "Several agents…", () => run("tab.new", { space: space?.id, mod: "fanout", name: "Fan-out" }), "", Boolean(space)))
      .child(this.row("space", div().w(14).child("+"), "New space", () => run("space.new"), shortcut("space.new")))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)));
  }
}
