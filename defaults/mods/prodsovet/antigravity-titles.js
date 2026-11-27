// SPDX-License-Identifier: Apache-2.0
import { appHome, exec, shared, setShared, terminals, window } from "finch";
import { artKind } from "./creatures.js";

const key = "prodsovet.antigravityTitles";
const isAntigravity = pane => artKind(pane?.program?.key) === "antigravity";

export function conversationTitle(pane, terminal) {
  if (!isAntigravity(pane)) return "";
  const id = pane.terminal ?? pane.address;
  const saved = terminal?.foreground?.pid && id && !id.includes("/") && shared(key)?.[terminal.foreground.pid];
  if (saved) return saved;
  const title = pane.title?.trim();
  if (!title || title === id || title === id?.split("/").pop() || /^(agy|antigravity(?:[ -]cli)?)$/i.test(title)) return "";
  return title;
}

// One poll for all local conversations, shared by the sidebar, tab strip and pane headers.
export function watchConversationTitles(cx) {
  if (window()?.platform !== "macos") return;
  let busy = false;
  const refresh = cx => {
    if (busy) return;
    const pids = terminals().filter(t => t.state === "live" && !t.address.includes("/") && isAntigravity(t))
      .map(t => t.foreground?.pid).filter(pid => Number.isInteger(pid) && pid > 0);
    if (!pids.length && !Object.keys(shared(key) ?? {}).length) return;
    busy = true;
    cx.spawn(async () => {
      try {
        let result = {};
        if (pids.length) {
          const r = await exec("python3", [`${appHome()}/mods/prodsovet/antigravity-titles.py`, ...pids.map(String)], { timeout: 5000 });
          if (r.code) return;
          result = JSON.parse(r.stdout);
        }
        if (JSON.stringify(result) !== JSON.stringify(shared(key) ?? {})) setShared(key, result);
      } catch { /* A missing helper or a locked store can be retried on the next poll. */ } finally { busy = false; }
    });
  };
  refresh(cx);
  cx.timer.every(5000, refresh);
}
