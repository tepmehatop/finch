import { appearance, fontSize, metric, L } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
import { View, div } from "gpui-kit";
import { focused, spaces, props, appHome, readTextFile, exec, run, closeOverlay, theme } from "finch";
import { python } from "./filesystem.js";

export default class SessionFork extends View {
  init(_props, cx) {
    this.message = L("Finding the current conversation…", "Определяю текущий диалог…");
    this.error = false;
    const f = focused();
    const source = f ? { ...f } : null;
    const space = spaces().find((s) => s.id === source?.space);
    this.overlay = props()?.overlay;
    // finch check renders without an overlay; never launch during validation.
    if (!this.overlay) return;
    cx.spawn(async (cx) => {
      try {
        if (!source?.terminal || !space) throw new Error(L("Select a Codex or Claude Code pane.", "Выберите панель с Codex или Claude Code."));
        const machine = space.machine;
        const terminal = source.shown || source.terminal;
        const address = machine && terminal.startsWith(machine + "/")
          ? terminal.slice(machine.length + 1) : terminal;
        const script = await readTextFile(appHome() + "/mods/session_fork/resolve.py");
        if (!script) throw new Error(L("session_fork/resolve.py not found.", "Не найден обработчик session_fork/resolve.py."));
        // python3 there; on this Windows PC the py launcher (see filesystem.js).
        const result = await python(["-c", script, address], { on: machine, timeout: 20000 });
        let plan;
        try { plan = JSON.parse(result.stdout); }
        catch { throw new Error(L("Could not identify the session: ", "Не удалось определить сессию: ") + (result.stderr || L("no answer", "нет ответа"))); }
        if (result.code || plan.error) throw new Error(plan.error || L("Could not identify the session.", "Не удалось определить сессию."));
        // Source space is captured before any asynchronous work; focus changes cannot redirect it.
        if (!spaces().some((s) => s.id === source.space)) throw new Error(L("The source space is already closed.", "Исходное рабочее пространство уже закрыто."));
        run("tab.new", {
          space: source.space,
          folder: plan.cwd,
          name: plan.agent + " fork",
          argv: plan.argv,
        });
        closeOverlay(this.overlay);
      } catch (error) {
        this.message = String(error.message || error);
        this.error = true;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    return div().p(18).flex().flex_col().gap(12).text_color(t.foreground)
      .child(div().text_size(fontSize("fork.title")).font_weight(appearance().weights.semibold).child(L("Fork conversation", "Форк диалога")))
      .child(div().text_size(fontSize("fork.body")).child(this.message))
      .child(div().text_size(fontSize("fork.hint")).text_color(t.muted).child(this.error ? L("Esc - close", "Esc - закрыть") : L("A new tab opens in the same space.", "Откроется новая вкладка в том же пространстве.")));
  }
}
