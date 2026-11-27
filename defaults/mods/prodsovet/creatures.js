import { lang } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
// Agent characters: animated sprite strips by kind and status, plus the
// one-line status scanner for pane headers.

// One-line versions for pane headers and tabs.
const MINI = {
  working: ["▰▱▱▱▱", "▰▰▱▱▱", "▱▰▰▱▱", "▱▱▰▰▱", "▱▱▱▰▰", "▱▱▱▱▰", "▱▱▱▰▰", "▱▱▰▰▱", "▱▰▰▱▱", "▰▰▱▱▱"],
  blocked: ["▰▰!▰▰", "▱▱!▱▱"],
  done: ["▰▰▰▰▰", "▰▰▰▰▰", "▱▰▰▰▱"],
  idle: ["▱▱▱▱▱"],
};
export function mini(status) {
  const st = MINI[status] ? status : "idle";
  return { frames: MINI[st], ms: { working: 110, blocked: 350, done: 600, idle: 1100 }[st] };
}

// Status words, the site's small caps labels.
const WORDS = {
  en: { working: "WORKING", blocked: "NEEDS YOU", done: "DONE", idle: "ASLEEP" },
  ru: { working: "РАБОТАЕТ", blocked: "ЖДЁТ ТЕБЯ", done: "ГОТОВО", idle: "СПИТ" },
};
export const word = (status) => WORDS[lang()][status] ?? "";

// Animated characters (Codex's build.py), as 16-frame horizontal sprite strips.
// Finch plays an animated WebP only once, so the mod steps the strip itself.
export const ART_FRAMES = 16;
export const ART_KINDS = ["claude", "codex", "gemini", "antigravity", "hermes", "other"];
const ART_ALIAS = { agy: "antigravity", "antigravity-cli": "antigravity" };
export function artKind(programKey) {
  const k = ART_ALIAS[programKey] ?? programKey;
  return ART_KINDS.includes(k) ? k : "other";
}
// Antigravity has its own sprite and shares Gemini's appearance-profile accent.
export function accentKind(programKey) {
  const kind = artKind(programKey);
  return kind === "antigravity" ? "gemini" : kind;
}
export function artPath(programKey, status) {
  const st = ["working", "blocked", "done", "idle"].includes(status) ? status : "idle";
  return `mods/prodsovet/art/creatures/${artKind(programKey)}-${st}.png`;
}
// A finished flask drains once. Loop the other strips on their usual clock.
export function artFrame(programKey, status, tick, doneAgeMs = Infinity) {
  if (status === "done" && artKind(programKey) === "antigravity") {
    return Math.max(0, Math.min(ART_FRAMES - 1, Math.floor(doneAgeMs / 100)));
  }
  return tick % ART_FRAMES;
}
