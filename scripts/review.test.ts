import { expect, test } from "bun:test";
import { parseDiff, message } from "../defaults/mods/review/diff.js";

test("diff rows carry the new file's line numbers; removed lines their old ones", () => {
  const rows = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@ fn\n keep\n-old\n+new\n same\n");
  expect(rows.map((r) => [r.kind, r.line ?? null])).toEqual([["hunk", null], ["ctx", 10], ["del", 11], ["add", 11], ["ctx", 12]]);
  expect(rows[2].old).toBe(true);
});

test("the message names file, line and code for every note", () => {
  const text = message([{ file: "src/a.rs", line: 11, old: false, code: "  let x = 1;", note: "Use a constant" }]);
  expect(text).toContain("src/a.rs:11");
  expect(text).toContain("> let x = 1;");
  expect(text).toContain("Use a constant");
});
