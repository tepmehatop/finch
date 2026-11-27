import { appearance, fontSize, metric, radius, L, style } from "./appearance.js";
// SPDX-License-Identifier: Apache-2.0
// ProdAdvice for Finch: customized interface and behavior, 2026. See NOTICE.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { props, theme, closeOverlay, shared, notify, run, exec } from "finch";
import { basename, parent, browse, openFile, showDialog, operation, localOperation, clipboard, paste, copyPath, reveal, revealLabel, trashLabel, onWindows } from "./filesystem.js";

const labels = () => ({ "create-file": L("New file", "Новый файл"), "create-folder": L("New folder", "Новая папка"), rename: L("Rename", "Переименовать"), duplicate: L("Duplicate", "Дублировать"), trash: onWindows() ? L("Delete to Recycle Bin", "Отправить в корзину") : L("Move to Trash", "Отправить в корзину"), paste: L("Paste", "Вставить"), goto: L("Go to folder", "Перейти в папку") });
const report = error => notify({ title: L("Failed", "Не выполнено"), body: String(error.message ?? error), level: "error" });

export class FileMenu extends View {
  init(_p, cx) { this.target = props().target; this.at = 0; this.h = cx.focus_handle(); this.h.focus(); }
  items() {
    const t = this.target, local = !t.on, selected = !t.root;
    return [
      ...(!t.dir ? [[L("Open file", "Открыть файл"), "open"]] : []),
      ...(local ? [[L("New file…", "Новый файл…"), "create-file"], [L("New folder…", "Новая папка…"), "create-folder"]] : []),
      ...(local && selected ? [[L("Rename…", "Переименовать…"), "rename"], [L("Duplicate", "Дублировать"), "duplicate"], [L("Copy", "Копировать"), "copy"], [L("Cut", "Вырезать"), "cut"]] : []),
      ...(local && shared("files.clipboard") ? [[L("Paste…", "Вставить…"), "paste"]] : []),
      [L("Copy path", "Копировать путь"), "copy-path"],
      ...(local ? [[revealLabel(), "reveal"]] : []),
      ...(local && selected ? [[trashLabel(), "trash"]] : []),
    ];
  }
  choose(action, cx) {
    if (["copy-path", "reveal"].includes(action)) {
      cx.spawn(async () => { try { await (action === "reveal" ? reveal(this.target.path) : copyPath(this.target.path)); } catch (e) { report(e); } closeOverlay(props().overlay); });
      return;
    }
    closeOverlay(props().overlay);
    const t = this.target;
    if (action === "open") openFile(t.path, t.on, t.space);
    else if (["copy", "cut"].includes(action)) clipboard(t, action === "cut");
    else showDialog(t, action);
  }
  render(cx) {
    const t = theme(), list = this.items();
    return v_flex().id("files-menu").track_focus(this.h).w_full().max_h(506).overflow_y_scrollbar().p(5).bg(t.popover).text_size(fontSize("fileDialog.menu"))
      .on_key_down((e, cx) => {
        if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "enter") this.choose(list[this.at][1], cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().px(9).py(7).truncate().text_color(t.dim).child(basename(this.target.path)))
      .children(list.map(([label, action], i) => div().id(`files-menu-${action}`).h(metric("fileDialog.menuRow")).px(9).gap(9).flex().items_center().rounded(radius(6)).cursor_pointer()
        .text_color(action === "trash" ? t.ansi1 : t.foreground).when(this.at === i, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(action, cx))
        .when(Boolean(style("agency")), el => el.child(svg(`mods/prodsovet/art/px/${MENU_ICONS[action] ?? "file"}.svg`).size(15).flex_none().text_color(action === "trash" ? t.ansi1 : t.muted)))
        .child(label)));
  }
}

// Agency profiles: a pixel icon for each file action.
const MENU_ICONS = { open: "go", "create-file": "file-plus", "create-folder": "folder-plus", rename: "pencil", duplicate: "copy", copy: "copy", cut: "cut", paste: "paste", "copy-path": "path", reveal: "reveal", trash: "trash" };

export class FileDialog extends View {
  init(_p, cx) {
    this.target = props().target; this.h = cx.focus_handle();
    const t = this.target;
    const value = t.action === "goto" ? (t.dir ? t.path : parent(t.path)) : t.action === "rename" ? basename(t.path) : t.action === "paste" ? basename(shared("files.clipboard")?.path) : "";
    this.input = InputState.new({ value, placeholder: t.action === "create-folder" ? "folder_name" : "filename.md" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    if (this.needsInput()) { this.input.focus(); if (value) this.input.set_selected_range({ start: 0, end: value.length }); }
    else this.h.focus();
  }
  needsInput() { return !["trash", "duplicate"].includes(this.target.action); }
  submit(cx) {
    if (this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const t = this.target, action = t.action, name = this.input.value();
        if (action === "goto") {
          let path = name.trim();
          if (t.on) { const r = await exec("test", ["-d", path], { on: t.on }); if (r.code) throw new Error(L("Folder not found", "Папка не найдена")); }
          // The normalized path: a typed C:\x/y must match the tree's C:\x\y.
          else path = (await localOperation({ action: "directory", path })).path ?? path;
          browse(path, t.space);
        } else {
          const request = { ...t, path: action.startsWith("create-") ? (t.dir ? t.path : parent(t.path)) : t.path };
          const result = action === "paste" ? await paste(t, name) : await operation(request, name);
          if (action === "create-file") openFile(result.path, null, t.space);
        }
        closeOverlay(props().overlay);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme(), target = this.target;
    const button = (id, label, fn, primary) => div().id(id).px(12).py(7).rounded(radius(7)).cursor_pointer().bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).hover(s => s.opacity(0.85)).on_click(fn).child(label);
    return v_flex().id("files-dialog").track_focus(this.h).size_full().p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(fontSize("fileDialog.body"))
      .on_key_down((e, cx) => { if (e.key === "escape" && !this.busy) closeOverlay(props().overlay); else if (e.key === "enter" && !this.needsInput()) this.submit(cx); else return; cx.stop_propagation(); })
      .child(div().text_size(fontSize("fileDialog.title")).font_weight(appearance().weights.semibold).child(labels()[target.action]))
      .child(div().truncate().tooltip(target.path).text_size(fontSize("fileDialog.hint")).text_color(t.dim).child(target.path))
      .when(this.needsInput(), el => el.child(Input.new(this.input).h(metric("fileDialog.input")).px(10).rounded(radius(7)).border_1().border_color(t.input).bg(t.background)))
      .when(target.action === "trash", el => el.child(div().text_color(t.muted).child(onWindows() ? L("The file or folder will be moved to the Recycle Bin.", "Файл или папка будут перемещены в корзину Windows.") : L("The file or folder will be moved to the macOS Trash.", "Файл или папка будут перемещены в корзину macOS."))))
      .when(target.action === "paste", el => el.child(div().text_size(fontSize("fileDialog.hint")).text_color(t.dim).child(L("You can change the name. Existing files are never overwritten.", "Можно изменить имя. Существующие файлы не перезаписываются."))))
      .when(target.action === "duplicate", el => el.child(div().text_color(t.muted).child(L("The copy appears next to the original under a free name.", "Копия появится рядом с оригиналом под свободным именем."))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(fontSize("fileDialog.hint")).text_color(t.ansi1).child(this.error ?? ""))
      .child(h_flex().gap(8).justify_end()
        .child(button("files-cancel", L("Cancel", "Отмена"), () => { if (!this.busy) closeOverlay(props().overlay); }))
        .child(button("files-confirm", this.busy ? L("Working…", "Выполняю…") : target.action === "trash" ? (onWindows() ? L("Delete", "В корзину") : L("Move to Trash", "В корзину")) : L("Done", "Готово"), (_e, cx) => this.submit(cx), true)));
  }
}
