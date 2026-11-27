"""Resolve the exact focused conversation. Read-only; never pick 'latest'."""
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys

UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
WINDOWS = sys.platform == "win32"
# The fork shortcut from keys.json / keys.windows.json.
SHORTCUT = "Ctrl+Shift+Y" if WINDOWS else "⌘⇧F"
# npm installs of Claude Code and Codex run as node.exe on Windows.
CLAUDE_PROGRAMS = {"claude", "claude.exe"} | ({"node", "node.exe"} if WINDOWS else set())
CODEX_PROGRAMS = {"codex"} | ({"codex.exe", "node", "node.exe"} if WINDOWS else set())


def hc_command():
    if not WINDOWS:
        return shutil.which("hc") or str(Path.home() / ".local/bin/hc")
    # Finch's Windows core ships finch-core.exe; `hc` is the same program.
    found = shutil.which("hc") or shutil.which("finch-core")
    if found:
        return found
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    for candidate in (local / "Programs/finch-core/hc.exe", local / "Programs/finch-core/finch-core.exe",
                      Path.home() / ".cargo/bin/hc.exe", Path.home() / ".cargo/bin/finch-core.exe"):
        if candidate.is_file():
            return str(candidate)
    raise ValueError("Не найден finch-core (hc). Откройте Finch: он установит его сам.")


def same_folder(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def windows_parents():
    """pid -> parent pid of every running process (Toolhelp snapshot)."""
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, wintypes.HANDLE(-1).value):
        return {}
    parents, entry = {}, PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return parents


def claude_session(root, pid, parents=None):
    """Claude Code's metadata for the process in the pane: sessions/<pid>.json.

    On Windows the pane's process can be a launcher whose child is the real
    Claude Code, which writes the file under its own pid. Then the session of
    the one process descended from the pane's process is taken; never a session
    chosen by age, and never one of another app (they descend from elsewhere)."""
    folder = Path(root) / "sessions"
    path = folder / (str(pid) + ".json")
    if path.exists() or not WINDOWS:
        return json.loads(path.read_text(encoding="utf-8"))
    parents = windows_parents() if parents is None else parents

    def descends(child):
        for _ in range(8):
            child = parents.get(child)
            if not child:
                return False
            if child == pid:
                return True
        return False

    found = []
    for file in folder.glob("*.json"):
        try:
            session = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        child = session.get("pid")
        if isinstance(child, int) and file.stem == str(child) and descends(child):
            found.append(session)
    if len(found) != 1:
        raise OSError("No unique Claude Code session below process %s" % pid)
    return {**found[0], "pid": pid, "childPid": found[0]["pid"]}


def get_terminal(address):
    result = subprocess.run([hc_command(), "get", address], capture_output=True, text=True, encoding="utf-8", timeout=8)
    if result.returncode:
        raise ValueError("Не удалось прочитать текущий терминал Finch.")
    return json.loads(result.stdout)


def codex_id(title):
    first = title.split(" | ", 1)[0].strip()
    first = re.sub(r"^Thread(?: ID)?[: ]+", "", first, flags=re.I)
    if re.fullmatch(UUID, first):
        return first
    # Codex shortens each title item. Resolve only a long UUID prefix, uniquely.
    match = re.fullmatch(r"([0-9a-fA-F-]{20,35})(?:\.\.\.|…)", first)
    if not match:
        raise ValueError(f"В этой сессии Codex один раз выполните:\n/title thread-id thread-name project-name\nЗатем снова нажмите {SHORTCUT}. Настройка заголовка нужна и для новых запусков.")
    prefix = match.group(1).lower()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]+", prefix):
        raise ValueError("Заголовок Codex не содержит корректный ID диалога.")
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    databases = [p for p in root.glob("state_*.sqlite") if re.fullmatch(r"state_\d+\.sqlite", p.name)]
    if not databases:
        raise ValueError("Не найдена локальная база сессий Codex.")
    db = max(databases, key=lambda p: int(p.stem.split("_")[-1]))
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=3) as connection:
        rows = connection.execute("SELECT id FROM threads WHERE id LIKE ? LIMIT 2", (prefix + "%",)).fetchall()
    if len(rows) != 1:
        raise ValueError("ID в заголовке не определяет единственный диалог Codex. Форк не создан.")
    return rows[0][0]


def resolve(terminal, claude_home=None):
    if terminal.get("state") != "live":
        raise ValueError("Исходный терминал уже закрыт.")
    fg = terminal.get("foreground") or {}
    status = terminal.get("status") or {}
    app = status.get("app", "") if isinstance(status, dict) else ""
    executable = Path(fg.get("name", "")).name.lower()
    cwd = fg.get("cwd")
    if not cwd or not fg.get("pid"):
        raise ValueError("Сначала выберите терминал с Codex или Claude Code.")

    if app == "codex" and executable in CODEX_PROGRAMS:
        # thread-id must be the FIRST title item. No history/title matching.
        sid = codex_id(terminal.get("title", ""))
        argv = ["codex", "fork", "--no-daemon", "-c", 'tui.terminal_title=["thread-id","thread-name","project-name"]', sid]
        agent = "Codex"
    elif app in ("claude-code", "claude") and executable in CLAUDE_PROGRAMS:
        root = Path(claude_home or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
        try:
            session = claude_session(root, fg["pid"])
        except (OSError, ValueError):
            raise ValueError("Claude Code не предоставил ID текущей сессии. Обновите Claude Code и откройте сессию заново.")
        sid = session.get("sessionId", "")
        if session.get("pid") != fg["pid"] or not re.fullmatch(UUID, sid):
            raise ValueError("Не удалось подтвердить ID сессии Claude Code.")
        if session.get("cwd") and not same_folder(session["cwd"], cwd):
            raise ValueError("Папка Claude Code изменилась. Повторите после завершения текущего действия.")
        argv = ["claude", "--resume", sid, "--fork-session"]
        agent = "Claude"
    else:
        raise ValueError("Выберите панель, в которой сейчас открыт Codex или Claude Code.")
    return {"agent": agent, "session": sid, "argv": argv, "cwd": cwd, "pid": fg["pid"]}


def main():
    # Russian messages; Finch reads the answer as UTF-8 on every system.
    sys.stdout.reconfigure(encoding="utf-8")
    address = sys.argv[1]
    before = get_terminal(address)
    plan = resolve(before)
    after = get_terminal(address)
    again = resolve(after)
    if (again["pid"], again["session"], again["cwd"]) != (plan["pid"], plan["session"], plan["cwd"]):
        raise ValueError("Сессия переключилась во время проверки. Нажмите хоткей ещё раз.")
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
