// Finch: the tab bar's More menu: the shipped panels, opened in the side panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, run, closeOverlay } from "finch";

export default class PanelsMenu extends View {
  render() {
    const t = theme();
    const panels = props()?.panels ?? [];
    return v_flex().size_full().p(5).bg(t.popover).text_size(12.8).children(panels.map(([id, label, icon]) =>
      h_flex().id(`pm-${id}`).h(31).px(9).gap(10).rounded(7).items_center().cursor_pointer().text_color(t.foreground)
        .hover((s) => s.bg(t.selected))
        .on_click(() => {
          closeOverlay(props().overlay);
          run("layout.select", { stack: "panel-body", child: id });
          run("layout.show", { id: "panel" });
        })
        .child(svg(icon).size(14).text_color(t.muted))
        .child(div().flex_1().child(label))));
  }
}
