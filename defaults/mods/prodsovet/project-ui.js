// SPDX-License-Identifier: Apache-2.0
// Shared drawing pieces for PA-Advanced's project dialogs and tree: mono step
// labels, keyboard chips, agent glyph tiles and square project letter tiles.
// Only the profile's own tokens, pixel icons and Finch program icons are used.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appearance, fontSize, labelFont, radius, agentAccent } from "./appearance.js";
import { px } from "./agency.js";
import { accentKind, artFrame, artKind, artPath, ART_FRAMES, ART_KINDS } from "./creatures.js";
import { spaceColor } from "./space-colors.js";

export const mono = () => labelFont() ?? appearance().fonts.mono;

// The agent's own accent; Terminal and unknown programs use the foreground.
export function tint(t, key) {
  if (!key || key === "terminal") return t.foreground;
  return agentAccent(accentKind(key)) ?? t.foreground;
}

// "01  COMPUTER": a numbered mono section label, optionally with a right side.
export function stepLabel(t, n, text, right = null) {
  return h_flex().h(18).flex_none().gap(8).items_center().font_family(mono()).text_size(fontSize("agents.meta"))
    .child(div().text_color(t.dim).child(n))
    .child(div().font_weight(appearance().weights.semibold).text_color(t.foreground).child(text))
    .child(div().flex_1().h(1).bg(t.border))
    .when(right != null, el => el.child(right));
}

export function kbd(t, text) {
  return div().flex_none().h(18).min_w(18).px(4).flex().items_center().justify_center().rounded(radius(3))
    .border_1().border_color(t.border).font_family(mono()).text_size(10).text_color(t.dim).child(text);
}

// A program's own icon (tinted glyph or full-color image); the pixel terminal otherwise.
export function glyph(program, size, color) {
  if (!program?.icon) return svg(px("terminal")).size(size).flex_none().text_color(color);
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).size(size).flex_none();
}

// A square tile holding the glyph on a quiet wash of the owner's color.
export function glyphTile(t, program, size, color) {
  const inner = Math.round(size * 0.6);
  return div().size(size).flex_none().flex().items_center().justify_center().rounded(radius(Math.round(size / 5)))
    .bg(color + "1c").border_1().border_color(color + "38").child(glyph(program, inner, color));
}

// A still frame of the agent's mascot.
export function hasMascot(key) {
  return Boolean(key) && key !== "terminal" && ART_KINDS.includes(artKind(key)) && artKind(key) !== "other";
}
export function mascot(key, size, status = "working") {
  return div().size(size).flex_none().relative().overflow_hidden()
    .child(image(artPath(key, status)).absolute().top(0).left(-size * artFrame(key, status, 0)).w(size * ART_FRAMES).h(size));
}

// The square letter tile of a project (its Space color, as in the Spaces list).
export function projectTile(t, space, name, size = 18) {
  const color = space ? spaceColor(t, space) : t.dim;
  return h_flex().size(size).flex_none().items_center().justify_center().bg(color).rounded(radius(3))
    .font_family(appearance().fonts.mono).text_size(Math.round(size * 0.58 * 10) / 10).font_weight(appearance().weights.bold)
    .text_color("#000000").child([...(name || "?")][0].toUpperCase());
}
