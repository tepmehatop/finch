// SPDX-License-Identifier: Apache-2.0
// Actions in the sidebar tree's sub-agent menu: give it a pane of its
// own, send it back under its parent, or stop it. Opened as a popup with
// props { role: "sub-menu", terminal }.
import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme, run, closeOverlay, terminals, panes } from "finch";
import { fontSize, metric, radius, L } from "./appearance.js";
import { px } from "./agency.js";

export function returnToParentItem(term, all, includeChild = false) {
  const parent = term?.state === "live" && term.parent && all.find(t => t.address === term.parent && t.state === "live");
  if (!parent) return null;
  const name = parent.name || [parent.program?.name, parent.address].filter(Boolean).join(" ");
  const child = includeChild ? (term.name || term.address) + ": " : "";
  return ["park", child + L(`Return to ${name}`, `Вернуть к ${name}`), "fold-down", () => run("terminal.park", { terminal: term.address })];
}

// terminal.keep uses the focused pane as its destination. Nested workers can
// have several pane-less ancestors before reaching the owning tab.
function detach(term, place) {
  const all = terminals(), views = panes(), seen = new Set();
  let addr = term.parent;
  while (addr && !seen.has(addr)) {
    const pane = views.find(p => p.terminal === addr);
    if (pane) {
      run("pane.focus", { pane: pane.pane });
      break;
    }
    seen.add(addr);
    addr = all.find(t => t.address === addr)?.parent;
  }
  run("terminal.keep", { terminal: term.address, place });
}

// The menu's items for a live terminal, as [id, label, icon, action, danger].
export function subAgentItems(address, allowDetach) {
  const all = terminals(), term = all.find(t => t.address === address && t.state === "live");
  if (!term) return [];
  const kept = panes().some(p => p.terminal === address);
  const park = kept && returnToParentItem(term, all);
  const keep = place => () => detach(term, place);
  return [
    ...(park ? [park] : []),
    ...(!kept && allowDetach ? [
        ["tab", L("Detach to a tab", "Открепить во вкладку"), "layers", keep("tab")],
        ["right", L("Detach to the right", "Открепить справа"), "split-right", keep("right")],
        ["down", L("Detach below", "Открепить снизу"), "split-down", keep("down")],
      ] : []),
    ["kill", L("Stop agent", "Остановить агента"), "trash", () => run("terminal.kill", { terminal: address }), true],
  ];
}

export default class SubAgentMenu extends View {
  init(_p, cx) { this.h = cx.focus_handle(); this.h.focus(); this.arming = false; }
  render() {
    const p = props(), t = theme();
    const list = subAgentItems(p.terminal, p.allowDetach);
    const close = () => closeOverlay(p.overlay);
    return v_flex().id("sub-menu").track_focus(this.h).w_full().p(5).bg(t.popover).text_size(fontSize("tabMenu.body"))
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .when(!list.length, el => el.child(div().px(9).py(6).text_color(t.dim).child(L("This agent has ended.", "Агент уже завершился."))))
      .children(list.map(([id, label, glyph, action, danger]) => {
        // Stopping takes a second click on the same item: no dialog, no accident.
        const armed = danger && this.arming;
        return div().id(`sub-menu-${id}`).h(metric("tabMenu.row")).px(9).gap(9).flex().items_center().rounded(radius(6))
          .when(danger, el => el.mt(4))
          .text_color(danger ? t.blocked : t.foreground)
          .bg(armed ? t.blocked + "22" : t.popover + "00").hover(s => s.bg(danger ? t.blocked + "22" : t.hover))
          .on_click((_e, cx) => {
            if (danger && !this.arming) { this.arming = true; cx.notify(); return; }
            close(); action();
          })
          .child(svg(px(glyph)).size(15).flex_none().text_color(danger ? t.blocked : t.muted))
          .child(armed ? L("Click again to stop", "Нажми ещё раз, чтобы остановить") : label);
      }));
  }
}
