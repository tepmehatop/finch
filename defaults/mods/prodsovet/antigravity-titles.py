#!/usr/bin/env python3
"""Read titles for local agy processes from their open conversation locks."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from uuid import UUID


def titles(pids, directory):
    presence = directory / "presence"
    if not pids or not presence.is_dir():
        return {}
    files = subprocess.run(
        ["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(pids), "+d", str(presence), "-Fpn"],
        capture_output=True, text=True, timeout=3,
    )
    locks = {}
    pid = None
    for line in files.stdout.splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("n") and pid in pids:
            path = Path(line[1:])
            if path.parent != presence or path.suffix != ".lock":
                continue
            try:
                conversation = str(UUID(path.stem))
            except ValueError:
                continue
            locks.setdefault(pid, set()).add(conversation)

    result = {}
    db = directory / "conversation_summaries.db"
    if locks and db.is_file():
        with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=0.5) as conn:
            for pid, ids in locks.items():
                if len(ids) == 1:
                    row = conn.execute("SELECT title FROM conversation_summaries WHERE conversation_id = ?", tuple(ids)).fetchone()
                    if row and row[0]:
                        result[pid] = row[0]
    return result


if __name__ == "__main__":
    print(json.dumps(titles([p for p in sys.argv[1:] if p.isdecimal()], Path.home() / ".gemini/antigravity-cli")))
