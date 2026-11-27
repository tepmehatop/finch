import { expect, test } from "bun:test";
import { launch, slug } from "../defaults/mods/fanout/plan.js";

test("each agent gets the task the way its CLI takes a first message", () => {
  expect(launch({ key: "gigacode", run: ["gigacode"] }, "fix it")).toEqual(["gigacode", "-i", "fix it"]);
  expect(launch({ key: "claude", run: ["claude"] }, "fix it")).toEqual(["claude", "fix it"]);
  expect(launch({ key: "goose", run: ["goose"] }, "fix it")).toEqual(["goose"]);
});

test("branch names come from the task", () => {
  expect(slug("Почини тест логина!")).toBe("почини-тест-логина");
  expect(slug("!!!")).toBe("task");
});
