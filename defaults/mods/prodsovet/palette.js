import { appearance, allProfiles } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Finch shares pane frames within a tab, so the focused terminal chooses it.
export function paletteFor(agent) {
  const PALETTES = appearance().agentPalettes;
  for (const value of [agent?.program?.key, agent?.app, agent?.program?.name, agent?.foreground?.name]) {
    if (typeof value !== "string") continue;
    const name = value.toLowerCase().trim().split(/[\\/]/).pop().replace(/\.(exe|cmd)$/, "");
    if (/^(codex|openai-codex)(\b|$)/.test(name)) return PALETTES.codex;
    if (/^claude(\b|$)/.test(name)) return PALETTES.claude;
    if (/^(?:google[ -])?(?:antigravity|gemini|agy)(?:[ -]cli)?$/.test(name)) return PALETTES.google;
  }
  return null;
}
export function withTerminal(agent, all) {
  const id = agent?.terminal ?? agent?.address;
  const terminal = id && all.find(t => t.address === id);
  return terminal ? { ...terminal, ...agent, foreground: terminal.foreground } : agent;
}
export function enabled(tree, dark) {
  const name = typeof tree?.theme === "string" ? tree.theme : tree?.theme?.[dark ? "dark" : "light"];
  return dark && appearance().agentTints && name === appearance().darkThemeName;
}
export function panePalette(tree, agent, dark) {
  const palette = paletteFor(agent);
  if (!palette) return null;
  const profile = appearance();
  if (palette === profile.agentPalettes.google) {
    const name = typeof tree?.theme === "string" ? tree.theme : tree?.theme?.light;
    if (enabled(tree, dark)) return { ...palette, google: true };
    if (!dark && profile.agentTints && name === profile.lightTheme) {
      return { google: true, working: palette.dayWorking, accent: palette.accent, border: palette.border };
    }
    return null;
  }
  return enabled(tree, dark) ? palette : null;
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}
// Release the previous revision's global accents; agent colors now stay in terminals.
const OLD_ACCENTS = ["#91abc9", "#c6a084", "#bdb17c", "#a8b3ae"];
const OLD_SELECTIONS = ["#303b49", "#42362e", "#3d3b2b", "#343a3c"];
const OWN_BACKGROUNDS = ["#24282e", "#2b2724", "#2a2923", "#252629", ...Object.values(allProfiles).flatMap(p => Object.values(p.agentPalettes).map(a => a.background))];
const GOOGLE_FRAMES = Object.values(allProfiles).flatMap(p => [p.agentPalettes.google.accent, p.agentPalettes.google.border]);
export function styledLayout(tree, agent, dark) {
  if (!find(tree, "main")?.content?.pane) return null;
  const next = JSON.parse(JSON.stringify(tree));
  const pane = find(next, "main").content.pane;
  for (const key of ["accent", "working", "cursor"]) {
    if (OLD_ACCENTS.includes(next.colors?.[key])) delete next.colors[key];
  }
  if (OLD_SELECTIONS.includes(next.colors?.selection)) delete next.colors.selection;
  if (next.colors && !Object.keys(next.colors).length) delete next.colors;
  const active = enabled(tree, dark);
  const p = panePalette(tree, agent, dark);
  const resetTint = active || OWN_BACKGROUNDS.includes(pane.background);
  if (p?.background) {
    pane.background = p.background;
    next.terminal_opacity = 0;
  } else if (resetTint) {
    pane.background = "background";
    if (next.terminal_opacity === 0) delete next.terminal_opacity;
  }
  if (p) {
    pane.focus = { width: 1, color: agent?.status === "working" ? p.accent : p.google ? p.border : "border" };
  } else if (resetTint || GOOGLE_FRAMES.includes(pane.focus?.color)) {
    pane.focus = { width: 1, color: active && agent?.status !== "working" ? "border" : "accent" };
  }
  return JSON.stringify(next) === JSON.stringify(tree) ? null : next;
}
