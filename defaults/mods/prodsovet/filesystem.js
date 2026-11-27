// Generated from mods/my-files/filesystem.js; keep copies identical.
// Shared workspace context and disk operations for the personal Finch mods.
import { spaces, panes, focused, home, shared, setShared, exec, appHome, run, openOverlay, window, settings } from "finch";
import { L, style } from "./appearance.js";

// ── Platform ──
// macOS keeps its own programs (pbcopy, open, trash). On Windows the same
// actions go through mods/my-files/system.py and file-ops.py. Commands on
// another machine (`on`) are Unix commands, as before.
export const onWindows = (on = null) => !on && window()?.platform === "windows";
export const onMac = (on = null) => !on && window()?.platform === "macos";
// A shortcut as people read it on this platform: shortcut("⌘⇧O", "Ctrl+Shift+S").
export const shortcut = (mac, pc) => onMac() ? mac : pc;
export const thisComputer = () => onWindows() ? L("THIS PC", "ЭТОТ ПК") : L("THIS MAC", "ЭТОТ MAC");

// ── Paths ──
// Unix paths use "/". A Windows path (C:\x, \\server\share\x) may use either
// separator; helpers return it with "\" and an upper-case drive letter, the
// way Finch reports folders on Windows, and compare it without case.
const WINDOWS_PATH = /^(?:[A-Za-z]:(?:[\\/]|$)|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;
export const isWindowsPath = p => typeof p === "string" && WINDOWS_PATH.test(p);
const windowsRoot = p => /^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)/.exec(p)[0] + "\\";
export function native(p) {
  if (!isWindowsPath(p)) return p;
  let s = p.replace(/\//g, "\\").replace(/^[a-z]:/, d => d.toUpperCase());
  s = s.slice(0, 2) + s.slice(2).replace(/\\{2,}/g, "\\");
  const root = windowsRoot(s);
  return s.length <= root.length ? root : s.replace(/\\+$/, "");
}
const folded = p => native(p).toLowerCase();
export const samePath = (a, b) => isWindowsPath(a) || isWindowsPath(b) ? Boolean(a && b) && folded(a) === folded(b) : a === b;
export const isAbsolute = p => typeof p === "string" && (p.startsWith("/") || isWindowsPath(p));
export function basename(p) {
  if (!isWindowsPath(p)) return p?.split("/").filter(Boolean).pop() || "/";
  const s = native(p), root = windowsRoot(s);
  return s.length <= root.length ? root : s.slice(s.lastIndexOf("\\") + 1);
}
export function parent(p) {
  if (!isWindowsPath(p)) return p?.slice(0, p.lastIndexOf("/")) || "/";
  const s = native(p), root = windowsRoot(s), at = s.lastIndexOf("\\");
  return at < root.length ? root : s.slice(0, at);
}
// `name` may be a relative path with "/" (tree keys, ripgrep output).
export function join(p, name) {
  if (!isWindowsPath(p)) return `${p === "/" ? "" : p}/${name}`;
  const s = native(p), rest = String(name).replace(/\//g, "\\");
  return s.endsWith("\\") ? s + rest : `${s}\\${rest}`;
}
export function within(p, root) {
  if (!isWindowsPath(p) && !isWindowsPath(root)) return p === root || p.startsWith(root === "/" ? "/" : root + "/");
  if (!p || !root) return false;
  const a = folded(p), b = folded(root);
  return a === b || a.startsWith(b.endsWith("\\") ? b : b + "\\");
}
// "~" for the home folder in labels.
export function tilde(p) {
  const h = home();
  if (!isWindowsPath(p)) return p === h ? "~" : p?.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
  return samePath(p, h) ? "~" : within(p, h) ? "~" + native(p).slice(native(h).length) : native(p);
}

// ── Programs ──
// Python 3: `python3` on macOS and other machines. On Windows `python3` is
// often the Microsoft Store stub, so the py launcher (or python) is used, in
// UTF-8 mode: the JSON these scripts print carries Russian text.
let windowsPython = null;
export async function python(args, options = {}) {
  if (!onWindows(options.on)) return exec("python3", args, options);
  if (!windowsPython) {
    for (const candidate of [["py", "-3"], ["python"]]) {
      const r = await exec(candidate[0], [...candidate.slice(1), "-c", "import sys; print(sys.version_info[0])"], { timeout: 15000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim() === "3") { windowsPython = [...candidate, "-X", "utf8"]; break; }
    }
    if (!windowsPython) throw new Error(L("Python 3 is required: install it from python.org", "Нужен Python 3: установите его с python.org"));
  }
  return exec(windowsPython[0], [...windowsPython.slice(1), ...args], options);
}
async function system(request) {
  const r = await python([`${appHome()}/mods/my-files/system.py`, JSON.stringify(request)], { timeout: 30000 });
  let value;
  try { value = JSON.parse(r.stdout); } catch { throw new Error(r.stderr || L("The system action failed", "Системное действие не выполнено")); }
  if (r.code || value.error) throw new Error(value.error || r.stderr);
  return value;
}
// Clipboard text. `delay` (seconds) writes it later without holding a timer.
export async function copyText(text, delay = 0) {
  if (onWindows()) return void await system({ action: "clipboard-set", text, delay });
  const r = await exec("sh", ["-c", `${delay ? `sleep ${Number(delay)}; ` : ""}printf %s "$1" | pbcopy`, "copy", text]);
  if (r.code) throw new Error(r.stderr);
}
export async function readClipboard() {
  if (onWindows()) return (await system({ action: "clipboard-get" }).catch(() => null))?.text ?? null;
  const r = await exec("pbpaste", []).catch(() => null);
  return r?.code === 0 ? r.stdout : null;
}
// Type text into an agent's terminal as a paste, then give the clipboard back.
// `ready` runs once the clipboard holds the text (a popup closes itself there):
// everything after it starts its programs at once, so a closed mod copy, which
// cancels what it still awaits, cannot stop the paste or the restore.
export async function pasteInto(terminal, text, ready) {
  const old = await readClipboard();
  await copyText(text);
  ready?.();
  run("pane.focus", { terminal });
  run("terminal.paste");
  if (old) copyText(old, 0.7).catch(() => {});
}
// A local file in its default app, or a web/app link (https:, vscode:, obsidian:).
export async function openExternal(target) {
  if (onWindows()) return void await system({ action: "open", target });
  const r = await exec("open", [target]);
  if (r.code) throw new Error(r.stderr);
}
export const revealLabel = () => onWindows() ? L("Show in Explorer", "Показать в Проводнике") : L("Reveal in Finder", "Показать в Finder");
export const trashLabel = () => onWindows() ? L("Delete to Recycle Bin…", "В корзину…") : L("Move to Trash…", "В корзину…");

export const fileKey = (file, on = null, space = "") => JSON.stringify([on, space, file]);
export function workspace(id) {
  const s = spaces().find(s => id ? s.id === id : s.active);
  if (!s) return { space: null, cwd: null, on: null };
  const roots = shared("files.workspace-roots") ?? {};
  let cwd = roots[s.id];
  if (!cwd || (!s.machine && samePath(cwd, home()))) {
    // HOME is provisional until a terminal reaches a project. Once found,
    // keep that root stable across tab switches and later shell navigation.
    const all = panes();
    const candidates = s.tabs.flatMap(t => all.filter(p => p.tab === t.id && p.terminal && p.cwd));
    const anchor = candidates.find(p => s.machine || !samePath(p.cwd, home()));
    cwd = anchor && s.folder && (s.machine || !samePath(s.folder, home())) && within(anchor.cwd, s.folder)
      ? s.folder : anchor?.cwd || s.folder || candidates[0]?.cwd || (!s.machine ? home() : null);
    if (cwd && cwd !== roots[s.id]) setShared("files.workspace-roots", { ...roots, [s.id]: cwd });
  }
  return { space: s.id, cwd, on: s.machine ?? null };
}
// What to call a space: its own name when someone named it; otherwise its
// project root (Finch would name it after its first terminal's folder, which
// turns into "~" once that tab is a shell at home).
export function spaceLabel(s) {
  if (!s || s.named) return s?.name ?? "";
  const root = workspace(s.id).cwd;
  if (!root) return s.name;
  return !s.machine && samePath(root, home()) ? "~" : basename(root) || s.name;
}
export function location() {
  const w = workspace(), browsed = (shared("files.browsed") ?? {})[w.space];
  return { ...w, cwd: browsed || w.cwd };
}
export function browse(cwd, space) {
  setShared("files.browsed", { ...(shared("files.browsed") ?? {}), [space]: cwd });
}
export function newTerminal(place = "tab", id, argv, name) {
  const w = workspace(id);
  if (place === "tab") run("tab.new", { ...(w.space ? { space: w.space } : {}), ...(w.cwd ? { folder: w.cwd } : {}), ...(argv ? { argv } : {}), ...(name ? { name } : {}) });
  else run("terminal.open", { folder: w.cwd, place });
}
export function openFile(file, on = null, space = workspace().space) {
  const live = new Set(spaces().flatMap(s => s.tabs.map(t => t.id)));
  const tab = Object.entries(shared("files.documents") ?? {}).find(([id, d]) => live.has(id) && d.file === file && d.on === on && d.space === space && !d.removed)?.[0];
  if (tab) return run("tab.select", { id: tab });
  run("tab.new", { space, folder: workspace(space).cwd, name: basename(file), mod: "file-tab", props: { file, on, space } });
}
// File icons: Finch's line icons, or in agency profiles dot-matrix icons
// colored by kind like the page's dashboards. Paths are app-relative.
const KINDS = [
  ["code", /\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|sh|zsh|rb|swift|kt|java|c|h|cpp|css|scss|html|lua|sql)$/i],
  ["text", /\.(md|mdx|txt|rtf|org|canvas|base)$/i],
  ["data", /\.(json|jsonl|ya?ml|toml|csv|tsv|xml|ini|env|lock|plist)$/i],
  ["media", /\.(png|jpe?g|gif|webp|svg|ico|heic|mp4|mov|webm|mkv|mp3|wav|m4a|ogg|pdf)$/i],
];
const KIND_COLORS = { folder: ["#a6bbff", "#3b55c4"], code: ["#85dee7", "#16707c"], text: ["#cc9bfa", "#7a3fb8"], data: ["#ffad55", "#9a5300"], media: ["#ff8176", "#c4352b"] };
export function fileKind(name, dir) {
  if (dir) return "folder";
  return KINDS.find(([, re]) => re.test(name ?? ""))?.[0] ?? "file";
}
export function kindColor(t, kind) {
  const pick = KIND_COLORS[kind];
  return pick ? pick[settings()?.dark === false ? 1 : 0] : t.muted;
}
export function fileGlyph(t, name, dir) {
  if (!style("agency")) return { path: `mods/my-files/${dir ? "folder" : "file"}.svg`, color: t.muted, size: 14 };
  const kind = fileKind(name, dir);
  return { path: `mods/my-files/px-${kind}.svg`, color: kindColor(t, kind), size: 12 };
}
export function context(path, dir, on, space, action) {
  return { path, dir, on: on ?? null, space, action };
}
export function showMenu(target) {
  openOverlay({ mod: "my-files", kind: "popup", width: 268, height: 506, props: { role: "menu", target } });
}
export function showDialog(target, action) {
  openOverlay({ mod: "my-files", kind: "dialog", width: 500, height: 272, props: { role: "dialog", target: { ...target, action } } });
}
export async function localOperation(request) {
  const result = await python([`${appHome()}/mods/my-files/file-ops.py`, JSON.stringify(request)], { timeout: 600000 });
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || L("The operation failed", "Не удалось выполнить операцию")); }
  if (result.code || value.error) throw new Error(value.error || result.stderr);
  return value;
}
export function activeDocuments() {
  const live = new Set(panes().filter(p => p.mod === "file-tab").map(p => p.tab));
  return Object.fromEntries(Object.entries(shared("files.documents") ?? {}).filter(([id]) => live.has(id)));
}
export function assertClean(path, on = null) {
  const dirty = Object.values(activeDocuments()).find(d => d.on === on && within(d.file, path) && (d.dirty || d.saving));
  if (dirty) throw new Error(L(`Save the open file first: ${basename(dirty.file)}`, `Сначала сохраните открытый файл: ${basename(dirty.file)}`));
}
export function isLocked(file) {
  const l = shared("files.operation");
  return Boolean(l && Date.now() - l.at < 610000 && within(file, l.path));
}
export async function operation(target, name) {
  if (target.on) throw new Error(L("File changes work only on this computer for now", "Изменение файлов пока доступно только на этом компьютере"));
  if (!onMac() && !onWindows()) throw new Error(L("These operations are set up for macOS and Windows", "Эти операции настроены для macOS и Windows"));
  const action = target.action, destructive = ["rename", "move", "trash"].includes(action);
  const existing = shared("files.operation");
  if (existing && Date.now() - existing.at < 610000) throw new Error(L("Wait for the previous operation to finish", "Дождитесь завершения предыдущей операции"));
  if (destructive) assertClean(target.path);
  setShared("files.operation", { path: target.path, at: Date.now() });
  try {
    const result = await localOperation({ action, path: target.path, name, destination: target.destination });
    if (result.kind === "move" || result.kind === "trash") {
      const docs = activeDocuments();
      for (const [id, d] of Object.entries(docs)) {
        if (d.on || !within(d.file, result.old)) continue;
        docs[id] = result.kind === "trash" ? { ...d, removed: true } : { ...d, file: result.path + d.file.slice(result.old.length) };
        if (result.kind === "move") run("tab.rename", { id, name: basename(docs[id].file) });
      }
      setShared("files.documents", docs);
      // Keep current browser folders valid when their parent is moved or trashed.
      for (const key of ["files.browsed", "files.workspace-roots"]) {
        const map = { ...(shared(key) ?? {}) };
        for (const [id, p] of Object.entries(map)) {
          if (spaces().find(s => s.id === id)?.machine || !within(p, result.old)) continue;
          map[id] = result.kind === "trash" ? parent(result.old) : result.path + p.slice(result.old.length);
        }
        setShared(key, map);
      }
    }
    setShared("files.revision", (shared("files.revision") ?? 0) + 1);
    return result;
  } finally { setShared("files.operation", null); }
}
export function clipboard(target, cut) {
  setShared("files.clipboard", { path: target.path, on: target.on, cut });
}
export async function paste(target, name) {
  const source = shared("files.clipboard");
  if (!source) throw new Error(L("Copy or cut a file first", "Сначала скопируйте или вырежьте файл"));
  if (source.on !== target.on) throw new Error(L("Copying between machines is not supported yet", "Копирование между машинами пока не поддерживается"));
  const result = await operation({ ...source, action: source.cut ? "move" : "copy", destination: target.dir ? target.path : parent(target.path) }, name);
  if (source.cut) setShared("files.clipboard", null);
  return result;
}
export const copyPath = path => copyText(path);
export async function reveal(path) {
  if (onWindows()) return void await system({ action: "reveal", path });
  const r = await exec("open", ["-R", path]);
  if (r.code) throw new Error(r.stderr);
}
