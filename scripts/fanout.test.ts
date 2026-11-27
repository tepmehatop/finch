import { expect, test } from "bun:test";
import { launch, slug } from "../defaults/mods/fanout/plan.js";

test("each agent gets the task the way its CLI takes a first message", () => {
  expect(launch({ key: "gigacode", run: ["gigacode"] }, "fix it")).toEqual(["gigacode", "-i", "fix it"]);
  expect(launch({ key: "claude", run: ["claude"] }, "fix it")).toEqual(["claude", "fix it"]);
  expect(launch({ key: "goose", run: ["goose"] }, "fix it")).toEqual(["goose"]);
});

test("GigaCode QA gets the task too, and each copy its own model", () => {
  expect(launch({ key: "gigacode-qa", run: ["gigacode-qa"] }, "fix it")).toEqual(["gigacode-qa", "-i", "fix it"]);
  expect(launch({ key: "gigacode", run: ["gigacode"] }, "fix it", "GigaChat-2-Max")).toEqual(["gigacode", "-m", "GigaChat-2-Max", "-i", "fix it"]);
  expect(launch({ key: "claude", run: ["claude"] }, "fix it", "opus")).toEqual(["claude", "--model", "opus", "fix it"]);
});

test("branch names come from the task", () => {
  expect(slug("Почини тест логина!")).toBe("почини-тест-логина");
  expect(slug("!!!")).toBe("task");
});
