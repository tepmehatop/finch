#!/usr/bin/env python3
"""Lists user-facing English strings in the shipped mods, for defaults/locales.

    scripts/finch-strings.py              # every candidate
    scripts/finch-strings.py --missing    # only those defaults/locales/ru.json lacks

Plain literals are printed as JSON strings. Template literals with ${...} are
printed as `T:` lines with each ${...} shown as {}: they need a regex entry
in "patterns" rather than an "exact" one.
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
files = sorted((root / "defaults").glob("frame/*/*.js")) + sorted(
    p for p in (root / "defaults").glob("mods/*/*.js") if "/win98/" not in p.as_posix()
)


def tokens(src: str):
    """Yields ("str", text) and ("tpl", parts) for string and template literals."""
    i, n = 0, len(src)
    stack = []  # brace depth for each open ${ inside a template
    prev = ""  # last significant char, to tell a regex from a division
    while i < n:
        c = src[i]
        if c == "/" and src.startswith("//", i):
            i = src.find("\n", i)
            i = n if i < 0 else i
            continue
        if c == "/" and src.startswith("/*", i):
            i = src.find("*/", i + 2)
            i = n if i < 0 else i + 2
            continue
        if c == "/" and prev in "(,=:[!&|?{};+-*%<>~^" + "\n":
            j = i + 1
            in_class = False
            while j < n and (src[j] != "/" or in_class):
                if src[j] == "\\":
                    j += 1
                elif src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "\n":
                    break
                j += 1
            i = j + 1
            prev = "a"
            continue
        if c in "\"'":
            j, out = i + 1, []
            while j < n and src[j] != c:
                if src[j] == "\\" and j + 1 < n:
                    out.append(src[j : j + 2])
                    j += 2
                    continue
                out.append(src[j])
                j += 1
            raw = "".join(out)
            try:
                text = json.loads('"' + raw.replace("\\'", "'").replace('"', '\\"').replace('\\\\"', '\\"') + '"')
            except Exception:
                text = raw
            yield ("str", text)
            i = j + 1
            prev = "a"
            continue
        if c == "`" or (c == "}" and stack and stack[-1] == 0):
            if c == "}":
                stack.pop()
                parts = TEMPLATE_PARTS.pop()
            else:
                parts = []
            j, buf = i + 1, []
            while j < n and src[j] != "`" and not src.startswith("${", j):
                if src[j] == "\\" and j + 1 < n:
                    buf.append(src[j + 1])
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            parts.append("".join(buf))
            if j < n and src[j] == "`":
                yield ("tpl", parts)
                i = j + 1
                prev = "a"
            else:
                TEMPLATE_PARTS.append(parts)
                stack.append(0)
                i = j + 2
                prev = "("
            continue
        if c == "{" and stack:
            stack[-1] += 1
        elif c == "}" and stack:
            stack[-1] -= 1
        if not c.isspace():
            prev = c
        elif c == "\n":
            prev = prev if prev not in ")]" else prev
        i += 1


TEMPLATE_PARTS: list = []
skip = re.compile(
    r"^(?:[\w.\-/:#%@*~?=+]+|#[0-9a-fA-F]{3,8}|https?://\S+|[\w.-]+\.(?:js|json|svg|png|md|mp3|webp|toml))$"
)


def wanted(s: str) -> bool:
    s = s.strip()
    if len(s) < 2 or not re.search(r"[A-Za-z]", s):
        return False
    if " " not in s and (skip.match(s) and not re.match(r"^[A-Z][a-z]+$", s)):
        return False
    return bool(re.search(r"[A-Z]", s) or " " in s)


exact: dict[str, str] = {}
templates: dict[str, str] = {}
for f in files:
    rel = f.relative_to(root).as_posix()
    for kind, value in tokens(f.read_text()):
        if kind == "str":
            if wanted(value):
                exact.setdefault(value, rel)
        else:
            shown = "{}".join(value)
            if len(value) == 1:
                if wanted(value[0]):
                    exact.setdefault(value[0], rel)
            elif wanted(re.sub(r"\{\}", "", shown)) and re.search(r"[A-Za-z]{3}", shown):
                templates.setdefault(shown, rel)

if "--missing" in sys.argv:
    ru = json.loads((root / "defaults/locales/ru.json").read_text())
    exact = {k: v for k, v in exact.items() if k not in ru["exact"]}
    pats = [re.compile(f"^(?:{p[0]})$") for p in ru.get("patterns", [])]
    templates = {k: v for k, v in templates.items() if not any(p.match(k.replace("{}", "1")) for p in pats)}
for s, where in exact.items():
    print(json.dumps(s, ensure_ascii=False) + "\t" + where)
for s, where in templates.items():
    print("T: " + json.dumps(s, ensure_ascii=False) + "\t" + where)
print(f"{len(exact)} strings, {len(templates)} templates", file=sys.stderr)
