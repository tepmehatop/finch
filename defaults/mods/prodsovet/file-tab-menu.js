import { appearance, fontSize, metric, radius, L } from "./appearance.js";
import { agency, px } from "./agency.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme, run, closeOverlay, terminals, panes } from "finch";
import { newTerminal } from "./filesystem.js";
import { returnToParentItem } from "./sub-menu.js";
export default class TabMenu extends View {
  init(_p, cx) { this.h = cx.focus_handle(); this.h.focus(); }
  render() {
    const p = props(), t = theme();
    const all = terminals(), tabPanes = panes().filter(pane => pane.tab === p.target.id);
    const list = [
      ["rename", L("Rename", "Переименовать"), "pencil", () => run("tab.rename", { id: p.target.id })],
      ["new", L("New terminal", "Новый терминал"), "terminal", () => newTerminal("tab", p.target.space)],
    ];
    for (const pane of tabPanes) {
      const item = returnToParentItem(all.find(term => term.address === pane.terminal), all, tabPanes.length > 1);
      if (item) list.push([`park-${pane.terminal}`, ...item.slice(1)]);
    }
    list.push(["close", L("Close", "Закрыть"), "close", () => run("tab.close", { id: p.target.id })]);
    return v_flex().id("file-tab-menu").track_focus(this.h).w_full().p(5).bg(t.popover).text_size(fontSize("tabMenu.body"))
      .children(list.map(([id, label, glyph, action]) => div().id(`item-${id}`).h(metric("tabMenu.row")).px(9).gap(9).flex().items_center().rounded(radius(6)).text_color(t.foreground).hover(s => s.bg(t.hover))
        .on_click(() => { closeOverlay(p.overlay); action(); })
        .when(agency(), el => el.child(svg(px(glyph)).size(15).flex_none().text_color(t.muted)))
        .child(div().min_w(0).truncate().tooltip(label).child(label))));
  }
}
