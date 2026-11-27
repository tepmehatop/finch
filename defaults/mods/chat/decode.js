// Finch chat: turns an agent's own session log (JSONL) into chat blocks.
//
// A block is { kind, text?, name?, input?, result?, error?, id?, off }:
//   kind "user"      what the person typed
//   kind "assistant" the agent's answer (Markdown)
//   kind "thinking"  the agent's reasoning (shown folded)
//   kind "tool"      a tool call; `result` / `error` arrive with its result
//   kind "note"      something the session did (context compressed, …)
// `off` is the byte offset of the log line it came from, for paging back.

const MAX_TEXT = 20000; // a single message longer than this is cut on screen
const MAX_RESULT = 6000; // a tool result shows its start; the log keeps the rest

export function clip(text, max) {
  if (typeof text !== "string") text = text == null ? "" : String(text);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).filter(Boolean).join("\n");
  return "";
}

// Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl
function claude(rec, off) {
  const out = [];
  if (rec.isMeta || rec.isSidechain) return out;
  const m = rec.message;
  if (!m) return out;
  if (rec.type === "user") {
    if (typeof m.content === "string") {
      const t = m.content.trim();
      // Slash commands and their echoes are terminal noise.
      if (t && !t.startsWith("<command-") && !t.startsWith("<local-command") && !t.startsWith("Caveat:")) out.push({ kind: "user", text: clip(t, MAX_TEXT), off });
      return out;
    }
    for (const b of m.content ?? []) {
      if (b?.type === "text" && b.text?.trim() && !b.text.startsWith("<")) out.push({ kind: "user", text: clip(b.text.trim(), MAX_TEXT), off });
      else if (b?.type === "tool_result") out.push({ kind: "result", id: b.tool_use_id, result: clip(textOf(b.content), MAX_RESULT), error: Boolean(b.is_error), off });
    }
  } else if (rec.type === "assistant") {
    for (const b of m.content ?? []) {
      if (b?.type === "text" && b.text?.trim()) out.push({ kind: "assistant", text: clip(b.text, MAX_TEXT), off });
      else if (b?.type === "thinking" && b.thinking?.trim()) out.push({ kind: "thinking", text: clip(b.thinking, MAX_TEXT), off });
      else if (b?.type === "tool_use") out.push({ kind: "tool", id: b.id, name: b.name, input: b.input ?? {}, off });
    }
  }
  return out;
}

// GigaCode CLI (a Qwen Code fork) and Qwen Code: records with
// message.parts in the Gemini shape (text, thought, functionCall, functionResponse).
function qwen(rec, off) {
  const out = [];
  if (rec.type === "system") {
    if (rec.subtype === "chat_compression") out.push({ kind: "note", text: "Context compressed", off });
    return out;
  }
  const parts = rec.message?.parts ?? [];
  for (const p of parts) {
    if (p?.functionCall?.name) {
      out.push({ kind: "tool", id: p.functionCall.id ?? null, name: p.functionCall.name, input: p.functionCall.args ?? {}, off });
    } else if (p?.functionResponse) {
      const r = p.functionResponse.response ?? {};
      const error = r.error != null && r.error !== "";
      out.push({ kind: "result", id: p.functionResponse.id ?? null, result: clip(textOf(r.output ?? r.error ?? r.llmContent ?? ""), MAX_RESULT), error, off });
    } else if (typeof p?.text === "string" && p.text.trim()) {
      if (p.thought) out.push({ kind: "thinking", text: clip(p.text, MAX_TEXT), off });
      else if (rec.type === "user") out.push({ kind: "user", text: clip(p.text.trim(), MAX_TEXT), off });
      else if (rec.type === "assistant") out.push({ kind: "assistant", text: clip(p.text, MAX_TEXT), off });
    }
  }
  return out;
}

export const DECODERS = { claude, gigacode: qwen, qwen };

// Folds tool results into their calls: by id, else into the last call still
// waiting (some CLI versions leave the id out of the response).
export function fold(blocks, incoming) {
  for (const b of incoming) {
    if (b.kind !== "result") {
      blocks.push(b);
      continue;
    }
    let target = null;
    for (let i = blocks.length - 1; i >= 0 && i >= blocks.length - 200; i--) {
      const c = blocks[i];
      if (c.kind !== "tool" || c.result != null) continue;
      if (b.id && c.id === b.id) { target = c; break; }
      if (!b.id && !target) target = c;
    }
    if (target) {
      target.result = b.result;
      target.error = b.error;
    }
  }
  return blocks;
}

// The one line that says what a tool call is about.
export function summary(block) {
  const i = block.input ?? {};
  const pick = i.command ?? i.cmd ?? i.file_path ?? i.absolute_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt;
  if (typeof pick === "string") return pick.split("\n")[0].slice(0, 160);
  const keys = Object.keys(i);
  return keys.length ? keys.slice(0, 3).join(", ") : "";
}

export function decodeLines(kind, lines, start) {
  const decode = DECODERS[kind];
  const out = [];
  let off = start;
  for (const line of lines) {
    const here = off;
    off += utf8Length(line) + 1;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    let k = 0;
    for (const b of decode(rec, here)) {
      b.key = `${here}:${k++}`;
      out.push(b);
    }
  }
  return out;
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
