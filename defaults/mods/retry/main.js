// Finch: retries an agent that stopped on a provider error.
//
// When an agent leaves "working", this reads the end of its screen. A transient
// provider error (API error, overload, 5xx, a dropped connection) is retried a
// minute later; a usage limit with a reset time waits until then. A retry sends
// one message to the agent (hc send). At most MAX_TRIES in a row per agent; any
// new work (the agent working again) resets the count and cancels a pending retry.
// Runs as an invisible block; Settings > Mods turns it off.

import { View, div } from "gpui-kit";
import { agents, hc, notify, shared, setShared, checking, run, finch } from "finch";
import { diagnose } from "./rules.js";

const CHECK_MS = 5000;
const DELAY_MS = 60 * 1000;
const MAX_TRIES = 3;
const MESSAGE = "Continue from where you stopped.";
const MESSAGE_RU = "Продолжай с того места, где остановился.";

export default class Retry extends View {
  init(_props, cx) {
    this.last = {}; // address → last status seen
    this.plan = {}; // address → { at, kind, tries }
    if (checking()) return;
    cx.timer.every(CHECK_MS, (cx) => this.tick(cx));
  }

  on() {
    return (shared("finch.mods") ?? {}).retry !== false;
  }

  // Finch: agents started over the limit wait in shared("finch.queue"); one starts
  // whenever fewer than shared("finch.limit") agents are working (0: no limit).
  drain() {
    const queue = shared("finch.queue") ?? [];
    if (!queue.length) return;
    const limit = Number(shared("finch.limit") ?? 0);
    const working = agents().filter((a) => a.status === "working").length;
    if (limit > 0 && working >= limit) return;
    const [next, ...rest] = queue;
    setShared("finch.queue", rest);
    run("tab.new", next.args);
    notify({ title: `Started from the queue: ${next.name}`, level: "info" });
  }

  tick(cx) {
    this.drain();
    if (!this.on()) { this.plan = {}; return; }
    const now = Date.now();
    for (const a of agents()) {
      const was = this.last[a.address];
      this.last[a.address] = a.status;
      if (a.status === "working") {
        // Working again: whatever was planned is moot; a finished retry streak resets.
        if (this.plan[a.address]?.at) this.plan[a.address] = { tries: this.plan[a.address].tries };
        continue;
      }
      if (was === "working") this.check(a, cx);
      const p = this.plan[a.address];
      if (p?.at && now >= p.at) this.retry(a, p, cx);
    }
  }

  check(a, cx) {
    cx.spawn(async () => {
      const r = await hc(["read", a.address, "--lines", "40"]).catch(() => null);
      const found = diagnose(r?.stdout ?? "");
      const p = this.plan[a.address] ?? { tries: 0 };
      if (!found) { this.plan[a.address] = { tries: 0 }; return; }
      if (p.tries >= MAX_TRIES) {
        notify({ title: `${a.title || a.address}: still failing`, body: "Auto-retry stopped after 3 tries. Check the agent.", level: "error" });
        return;
      }
      const at = found.kind === "limit" ? found.at : Date.now() + DELAY_MS;
      if (!at) return; // a limit with no reset time: nothing sensible to wait for
      this.plan[a.address] = { at, kind: found.kind, tries: p.tries };
      const when = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      notify({ title: `${a.title || a.address}: ${found.kind === "limit" ? "limit reached" : "provider error"}`, body: `Auto-retry at ${when}.`, level: "info" });
    });
  }

  retry(a, p, cx) {
    this.plan[a.address] = { tries: p.tries + 1 };
    const ru = finch()?.language === "ru";
    cx.spawn(async () => {
      await hc(["send", a.address, ru ? MESSAGE_RU : MESSAGE]).catch(() => null);
    });
  }

  render() {
    return div();
  }
}
