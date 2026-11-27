// Finch review: the diff and the message, without the host (tested in scripts/review.test.ts).

// Unified diff → rows with the new file's line numbers.
export function parseDiff(text) {
  const rows = [];
  let oldNo = 0, newNo = 0;
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!rows.length || line === "" || line.startsWith("\\")) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), line: newNo++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), line: oldNo++, old: true });
    else rows.push({ kind: "ctx", text: line.slice(1), line: newNo++, oldLine: oldNo++ });
  }
  return rows;
}

// The message an agent gets.
export function message(notes) {
  const parts = ["Review notes on your changes. Please address each one:"];
  for (const n of notes) {
    const where = `${n.file}:${n.line}${n.old ? " (removed line)" : ""}`;
    parts.push(`\n${where}\n> ${n.code.trim()}\n${n.note.trim()}`);
  }
  return parts.join("\n");
}
