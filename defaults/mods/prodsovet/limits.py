#!/usr/bin/env python3
"""Claude Code, Codex, and Antigravity usage limits for the ProdAdvice status bar, as one JSON line.

Claude: the OAuth usage endpoint with Claude Code's own token from the macOS Keychain.
Codex: the latest `rate_limits` that Codex writes into its session logs.
Antigravity: the installed `agy` CLI (`agy -p /usage --output-format json`).
Each window: {"used": percent, "resets": unix seconds, "minutes": window length}.

The Claude source is macOS-only and is not ported to Windows: it would read
Claude Code's subscription token outside Claude Code, which Anthropic's
Claude Code terms do not allow for other tools. Codex reads local logs only,
and Antigravity invokes its own CLI directly.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import glob
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HOME = os.path.expanduser("~")


def parse_iso_timestamp(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text).timestamp()


def claude():
    if sys.platform != 'darwin':
        raise NotImplementedError('Claude limits are macOS-only')
    raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                         capture_output=True, text=True, timeout=10).stdout
    token = json.loads(raw)["claudeAiOauth"]["accessToken"]
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
        "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20"})
    data = json.load(urllib.request.urlopen(req, timeout=15))
    out = {}
    for key, name, minutes in (("five_hour", "5h", 300), ("seven_day", "7d", 10080)):
        w = data.get(key)
        if w and w.get("utilization") is not None:
            resets = w.get("resets_at")
            out[name] = {"used": w["utilization"], "minutes": minutes,
                         "resets": parse_iso_timestamp(resets)}
    return out


def codex():
    files = sorted(glob.glob(str(Path(os.environ.get("CODEX_HOME") or Path(HOME) / ".codex") / "sessions/*/*/*/*.jsonl")), key=os.path.getmtime, reverse=True)
    for path in files[:15]:
        last = None
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"rate_limits"' in line:
                    last = line
        if not last:
            continue
        rl = json.loads(last).get("payload", {}).get("rate_limits") or {}
        out = {}
        for key in ("primary", "secondary"):
            w = rl.get(key)
            if not w:
                continue
            minutes = w.get("window_minutes") or 0
            name = "5h" if minutes <= 300 else "7d" if minutes >= 10000 else f"{minutes // 60}h"
            used = w.get("used_percent", 0)
            if w.get("resets_at") and w["resets_at"] < time.time():
                used = 0  # the window has rolled over since Codex last reported
            out[name] = {"used": used, "minutes": minutes, "resets": w.get("resets_at")}
        if out:
            return out
    return {}


def agy_command():
    found = shutil.which("agy")
    if found:
        return found
    names = ("agy.exe", "agy.cmd", "agy") if sys.platform == "win32" else ("agy",)
    dirs = [
        Path(HOME) / ".gemini" / "antigravity-cli" / "bin",
        Path(HOME) / ".local" / "bin",
        Path(HOME) / ".antigravity" / "antigravity" / "bin",
    ]
    if sys.platform == "darwin":
        dirs.extend([Path("/opt/homebrew/bin"), Path("/usr/local/bin")])
    elif sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        dirs.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "antigravity-cli")
    for directory in dirs:
        for name in names:
            candidate = directory / name
            if candidate.is_file():
                return str(candidate)
    return "agy"


def parse_antigravity_usage(payload, now=None):
    if not isinstance(payload, dict):
        raise ValueError("Invalid Antigravity usage payload")
    if payload.get("status") not in (None, "SUCCESS"):
        raise ValueError(f"Antigravity status: {payload.get('status')}")
    command = payload.get("command")
    data = command.get("data") if isinstance(command, dict) else None
    groups = data.get("groups") if isinstance(data, dict) else None
    if not isinstance(groups, list):
        raise ValueError("Missing Antigravity quota groups")

    buckets = {}
    for group in groups:
        if not isinstance(group, dict):
            continue
        for bucket in group.get("buckets") or ():
            if isinstance(bucket, dict) and bucket.get("id"):
                buckets[bucket["id"]] = bucket

    picked = {}
    for bucket_id, name, minutes in (("gemini-5h", "5h", 300), ("gemini-weekly", "7d", 10080)):
        bucket = buckets.get(bucket_id)
        if bucket and not bucket.get("disabled") and bucket.get("remaining_fraction") is not None:
            picked[name] = (bucket, minutes)

    if not picked:
        primary = next(
            (
                group for group in groups
                if isinstance(group, dict)
                and "gemini" in (group.get("name") or "").lower()
                and "argon" not in (group.get("name") or "").lower()
            ),
            next((group for group in groups if isinstance(group, dict)), None),
        )
        for bucket in (primary or {}).get("buckets") or ():
            if not isinstance(bucket, dict) or bucket.get("disabled") or bucket.get("remaining_fraction") is None:
                continue
            window = (bucket.get("window") or "").lower()
            if window == "5h" and "5h" not in picked:
                picked["5h"] = (bucket, 300)
            elif window in ("weekly", "7d") and "7d" not in picked:
                picked["7d"] = (bucket, 10080)

    current = time.time() if now is None else now
    out = {}
    for name, (bucket, minutes) in picked.items():
        resets = parse_iso_timestamp(bucket.get("reset_time"))
        used = max(0.0, min(100.0, (1.0 - float(bucket["remaining_fraction"])) * 100.0))
        if resets is not None and resets < current:
            used = 0.0
        out[name] = {"used": used, "minutes": minutes, "resets": resets}
    if not out:
        raise ValueError("No Antigravity usage windows")
    return out


def antigravity():
    env = {k: v for k, v in os.environ.items() if not k.startswith(("FINCH_", "HC_"))}
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW") else {}
    with tempfile.TemporaryDirectory(prefix="finch-agy-limits-") as folder:
        res = subprocess.run(
            [agy_command(), "-p", "/usage", "--output-format", "json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=folder,
            env=env,
            timeout=25,
            **kwargs,
        )
    if res.returncode != 0:
        raise RuntimeError(f"agy exited with {res.returncode}")
    raw = res.stdout.strip()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
        for line in reversed(raw.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                payload = json.loads(line)
                break
        if payload is None:
            raise
    return parse_antigravity_usage(payload)


def main():
    config_path = Path(__file__).with_name("limits.local.json")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            config = {}
    except (OSError, ValueError):
        config = {}
    sources = (("claude", claude), ("codex", codex), ("antigravity", antigravity))
    enabled = [(name, fn) for name, fn in sources if config.get(name) is True]
    result = {"at": time.time()}
    if len(enabled) == 1:
        name, fn = enabled[0]
        try:
            result[name] = fn()
        except Exception as error:
            result[name] = {"error": type(error).__name__}
    elif len(enabled) > 1:
        def run_one(fn):
            try:
                return fn()
            except Exception as error:
                return {"error": type(error).__name__}

        with ThreadPoolExecutor(max_workers=len(enabled)) as pool:
            futures = [(name, pool.submit(run_one, fn)) for name, fn in enabled]
            for name, future in futures:
                result[name] = future.result()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
