import { expect, test } from "bun:test";
import { decodeLines, fold, summary } from "../defaults/mods/chat/decode.js";

// Finch chat: session logs become chat blocks, tool results fold into their calls.

const claude = [
  { type: "user", message: { role: "user", content: "Почини тест" } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "Смотрю тест" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cargo test\n--all" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "**Готово**" }] } },
  { type: "user", isMeta: true, message: { content: "hidden" } },
  { type: "user", message: { content: "<command-name>/clear</command-name>" } },
  { type: "data-flow-records", records: [] },
];

test("Claude Code logs become user, thinking, tool and answer blocks", () => {
  const lines = claude.map((r) => JSON.stringify(r));
  const blocks = fold([], decodeLines("claude", lines, 0));
  expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "tool", "assistant"]);
  expect(blocks[2].result).toBe("ok");
  expect(blocks[2].error).toBe(false);
  expect(summary(blocks[2])).toBe("cargo test");
  // Offsets are byte offsets of line starts, Cyrillic included.
  expect(blocks[0].off).toBe(0);
  expect(blocks[1].off).toBe(Buffer.byteLength(lines[0]) + 1);
  expect(new Set(blocks.map((b) => b.key)).size).toBe(blocks.length);
});

test("GigaCode (Qwen Code) logs: parts with thoughts, function calls and responses", () => {
  const giga = [
    { type: "user", message: { role: "user", parts: [{ text: "Напиши тест" }] } },
    { type: "assistant", message: { role: "model", parts: [{ text: "План", thought: true }, { functionCall: { id: "c1", name: "write_file", args: { file_path: "a.ts" } } }] } },
    { type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "c1", name: "write_file", response: { output: "written" } } }] } },
    { type: "assistant", message: { role: "model", parts: [{ functionCall: { name: "run_shell_command", args: { command: "npx playwright test" } } }] } },
    { type: "tool_result", message: { role: "user", parts: [{ functionResponse: { name: "run_shell_command", response: { error: "1 failed" } } }] } },
    { type: "system", subtype: "chat_compression" },
    { type: "assistant", message: { role: "model", parts: [{ text: "Тест падает, чиню" }] } },
  ];
  const blocks = fold([], decodeLines("gigacode", giga.map((r) => JSON.stringify(r)), 0));
  expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "tool", "tool", "note", "assistant"]);
  expect(blocks[2].result).toBe("written");
  // A response without an id goes to the last call still waiting.
  expect(blocks[3].result).toBe("1 failed");
  expect(blocks[3].error).toBe(true);
});

test("broken lines are skipped, not fatal", () => {
  const blocks = decodeLines("claude", ["{not json", JSON.stringify(claude[0])], 0);
  expect(blocks.length).toBe(1);
  expect(blocks[0].off).toBe(Buffer.byteLength("{not json") + 1);
});

import { decodeJson } from "../defaults/mods/chat/decode.js";

test("older forks' JSON sessions decode too, with the model", () => {
  const doc = { messages: [
    { type: "user", content: "Запусти тесты" },
    { type: "gemini", model: "GigaChat-2-Max", content: "Запускаю", thoughts: [{ subject: "План", description: "сначала npm test" }],
      toolCalls: [{ id: "1", name: "run_shell_command", args: { command: "npm test" }, status: "success", result: [{ functionResponse: { response: { output: "3 passed" } } }] }] },
  ] };
  const blocks = decodeJson(JSON.stringify(doc));
  expect(blocks.map((b) => b.kind)).toEqual(["user", "meta", "thinking", "assistant", "tool"]);
  expect(blocks[1].model).toBe("GigaChat-2-Max");
  expect(blocks[4].result).toBe("3 passed");
});

test("Qwen-format records carry the model as meta", () => {
  const blocks = decodeLines("gigacode", [JSON.stringify({ type: "assistant", model: "GigaChat-2", message: { parts: [{ text: "ok" }] } })], 0);
  expect(blocks.map((b) => b.kind)).toEqual(["meta", "assistant"]);
});
