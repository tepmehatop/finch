import { expect, test } from "bun:test";
import { diagnose, resetTime } from "../defaults/mods/retry/rules.js";

test("provider errors are retried; normal endings are not", () => {
  expect(diagnose("⎿ API Error: 529 {\"type\":\"overloaded_error\"}")).toEqual({ kind: "error" });
  expect(diagnose("[API Error: fetch failed]")).toEqual({ kind: "error" });
  expect(diagnose("Done. All 12 tests pass.\n> ")).toBeNull();
});

test("a usage limit waits for its reset time", () => {
  const now = new Date(2026, 10, 27, 10, 0).getTime();
  const r = diagnose("Claude usage limit reached. Your limit will reset at 3pm.", now);
  expect(r?.kind).toBe("limit");
  expect(new Date(r!.at!).getHours()).toBe(15);
  expect(new Date(resetTime("resets 09:30", now)!).getDate()).toBe(28); // already past today: tomorrow
  expect(resetTime("no time here", now)).toBeNull();
});
