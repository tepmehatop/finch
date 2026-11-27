// Finch: the More menu of the side panel, the same in every layout.
//
// Every shipped layout has the same side panels. Files, Changes and Review
// are buttons on the tab bar; the rest are here, in this order. A panel shows
// when its block is in the layout and its mod isn't turned off in Settings >
// Mods; GitHub and Issues don't exist in the closed edition.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, closeOverlay, layout, shared, finch } from "finch";

// [id, English label, icon]; the labels are translated by the locale file.
export const MORE = [
  ["asks", "Questions", "frame/welcome/messages.svg"],
  ["git-graph", "Git graph", "mods/workspace-chrome/branch.svg"],
  ["skillsgate", "Skills", "frame/welcome/layers.svg"],
  ["mcp", "MCP", "frame/welcome/layers.svg"],
  ["jira", "Jira", "mods/workspace-chrome/branch.svg"],
  ["prompts", "Prompts", "frame/palette/command.svg"],
  ["github", "GitHub", "mods/workspace-chrome/branch.svg"],
  ["issues", "Issues", "frame/welcome/messages.svg"],
];
const NETWORK = new Set(["github", "issues"]);

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const r = find(c, id);
    if (r) return r;
  }
  return null;
}

/** The More panels this window can show now. */
export function available(root = layout()) {
  const off = shared("finch.mods") ?? {};
  const closed = Boolean(finch()?.closed);
  return MORE.filter(([id]) => off[id] !== false && !(closed && NETWORK.has(id)) && find(root, id));
}

export default class PanelsMenu extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const panels = available();
    const close = () => (p.overlay ? closeOverlay(p.overlay) : run("overlay.close", { id: "mod-panels-menu" }));
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.8).children(panels.map(([id, label, icon]) =>
      h_flex().id(`pm-${id}`).h(31).px(9).gap(10).rounded(7).items_center().cursor_pointer().text_color(t.foreground)
        .hover((s) => s.bg(t.selected))
        .on_click(() => {
          close();
          run("layout.select", { stack: "panel-body", child: id });
          run("layout.show", { id: "panel" });
        })
        .child(svg(icon).size(14).text_color(t.muted))
        .child(div().flex_1().child(label))));
  }
}
