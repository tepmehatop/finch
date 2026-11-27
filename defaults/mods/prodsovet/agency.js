import { style, agentAccent, appearance, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Agency-page decoration (profiles with style.agency): agent colors, tinted
// selection, pixel icons, the halftone, text rails, typewriter and glitch frames.
// Everything here is native gpui: tinted one-color SVGs and text frames.

import { div, svg } from "gpui-kit";
import { settings, terminals, shared, setShared, focused, window, notify, playSound } from "finch";
import { accentKind } from "./creatures.js";
import { paletteFor } from "./palette.js";

const ART = "mods/prodsovet/art/agency";

export const agency = () => style("agency") === true;

// Claude Code keeps reporting "working" after its turn ends while background
// shells or agents it started still run ("1 shell still running"); a dev
// server never ends, so the spinner would never stop. The report's message
// tells the two apart (during a turn it names the current step). A turn that
// is over counts as done, with Finch's sound and a notification, until you
// look at that agent; then it is idle (watchBackground, run by the status bar).
const BACKGROUND = /\bstill running\b/i;
export function backgroundOnly(terminal) {
  const r = terminal?.report ?? terminal?.status;
  const msg = typeof r === "object" && r ? r.msg : null;
  return typeof msg === "string" && BACKGROUND.test(msg);
}
const BACKGROUND_TURNS = "prodsovet.backgroundTurns.v1";
export function settled(status, address, all = terminals()) {
  if (status !== "working" || !address) return status;
  const t = all.find(x => x.address === address);
  if (!backgroundOnly(t)) return status;
  const seen = (shared(BACKGROUND_TURNS) ?? {})[address];
  return seen && seen.turn === (t.turn ?? null) && !seen.seen ? "done" : "idle";
}

// One pass: a finished turn nobody is looking at is announced once and kept
// "done"; looking at it (focus, window in front) marks it seen.
export function watchBackground() {
  const all = terminals(), f = focused(), w = window();
  const old = shared(BACKGROUND_TURNS) ?? {}, next = {};
  for (const t of all) {
    if (t.state !== "live" || !backgroundOnly(t)) continue;
    const turn = t.turn ?? null, rec = old[t.address];
    const looking = w?.active !== false && (f?.terminal === t.address || f?.agent === t.address);
    if (rec && rec.turn === turn) { next[t.address] = rec.seen || !looking ? rec : { turn, seen: true }; continue; }
    next[t.address] = { turn, seen: looking };
    if (looking) continue;
    const name = t.labels?.where || t.name || t.program?.name || t.address;
    if (settings()?.sounds?.enabled !== false) playSound("done");
    notify({ title: L(`${name} finished`, `${name}: готово`), body: L("Background work is still running.", "Фоновые задачи ещё идут."),
      level: "success", action: { name: "agent.focus", args: { terminal: t.address } } });
  }
  if (JSON.stringify(next) !== JSON.stringify(old)) setShared(BACKGROUND_TURNS, next);
}

// The agent's own color where the profile has one; otherwise the status color.
export function accentOf(program, t, status = "working") {
  const own = program ? agentAccent(accentKind(program.key)) : null;
  return own ?? t[status] ?? t.accent;
}

// Detached workers retain their core parent address, even across tabs.
export function googleActivityColor(agent, byAddress) {
  if (!agent) return null;
  const google = appearance().agentPalettes.google;
  const color = settings()?.dark === false ? google.dayWorking : google.working;
  if (paletteFor(agent) === google) return color;
  let term = byAddress.get(agent.terminal ?? agent.address) ?? agent;
  const seen = new Set();
  while (term && !seen.has(term)) {
    if (paletteFor(term) === google || (term.report && paletteFor(term.report) === google)) return color;
    seen.add(term);
    term = byAddress.get(term.parent);
  }
  return null;
}

export function activitySpinner(googleColor, fallback) {
  return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(googleColor ?? fallback).spin(900);
}

// One neutral look everywhere, never an owner's color (agent colors stay on
// mascots, icons and working spinners). Selected: an 10% paper fill. Current
// (the one focused session): that fill plus a 2 px paper bar on the left.
// Hover: a 4% fill, only on rows that are not selected, so pointing at the
// selected row never changes it.
export function selected(el, t, _color) {
  return el.bg(t.foreground + "1a");
}
export function current(el, t) {
  return selected(el, t).relative().child(div().absolute().left(0).top(0).bottom(0).w(2).bg(t.foreground));
}
// On the PROJECTS tree the same 2 px bar sits on the project rail beside the
// card (the rail line runs 5 px left of a card) and covers it there.
export function onRail(el, t) { return selected(el, t).relative().child(div().absolute().left(-5).top(0).bottom(0).w(2).bg(t.foreground)); }
export function hovered(el, t) {
  return el.hover(s => s.bg(t.foreground + "0b"));
}

// The 7 px halftone screen fading upwards (420 x 84), for the bottom of a column.
export const halftone = (color) => svg(`${ART}/halftone.svg`).w(420).h(84).text_color(color);

// A lead running along a dotted rail (pane headers): working moves, done arrived.
const RAIL = 9;
const rail = (i, mark = "●") => "·".repeat(i) + mark + "·".repeat(RAIL - 1 - i);
const RAILS = {
  working: Array.from({ length: RAIL }, (_, i) => rail(i)),
  blocked: [rail(4, "!"), "·".repeat(RAIL)],
  done: [rail(RAIL - 1)],
  idle: ["·".repeat(RAIL)],
};
const GOOGLE_SWEEP = [...RAILS.working, ...RAILS.working.slice(1, -1).reverse()];
export function railFrames(status, google = false) {
  if (google && status === "working") return { frames: GOOGLE_SWEEP, ms: 140 };
  const st = RAILS[status] ? status : "idle";
  return { frames: RAILS[st], ms: { working: 120, blocked: 420, done: 1000, idle: 1000 }[st] };
}

// Typewriter frames: the text appears, the cursor blinks, then it starts over.
export function typed(text, hold = 14) {
  const out = [];
  for (let i = 0; i <= text.length; i++) out.push(text.slice(0, i) + "_");
  for (let i = 0; i < hold; i++) out.push(text + (i % 2 ? " " : "_"));
  return out;
}

// A rare two-frame glitch for an overlay copy of a title: blank for `length`
// 100 ms frames (~9 s by default), shown only at `at` and `at + 2`.
export function glitch(text, at, length = 90) {
  return Array.from({ length }, (_, i) => (i === at || i === at + 2 ? text : ""));
}

// A text with the brand glitch: offset neon and coral copies flash rarely.
// `base` is a function returning a fresh styled div (font, size, line height).
export function glitchy(base, text, t, { color = t.foreground, at = 80, length = 90 } = {}) {
  const neon = appearance().brandColors[settings()?.dark === false ? "light" : "dark"];
  return div().relative().flex_none()
    .child(base().text_color(color).child(text))
    .child(base().absolute().top(0).left(-2).opacity(0.85).text_color(neon).frames(glitch(text, at, length), 100))
    .child(base().absolute().top(0).left(2).opacity(0.8).text_color(t.blocked).frames(glitch(text, at + 1, length), 100));
}

// Pixel icons (12 x 12 dot matrix) in agency profiles, the stock icon otherwise.
export const px = (name) => `mods/prodsovet/art/px/${name}.svg`;
export const icon = (name, stock) => (agency() ? px(name) : stock);
