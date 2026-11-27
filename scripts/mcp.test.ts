import { expect, test } from "bun:test";
import { applyJson, applyToml, existing, splitCommand, parseEnv } from "../defaults/mods/mcp/config.js";

const fs = { name: "files", command: 'npx -y @modelcontextprotocol/server-filesystem "/my docs"', env: { A: "1" } };
const web = { name: "web", url: "http://localhost:8080/mcp" };

test("commands split with quotes; env lines parse", () => {
  expect(splitCommand('npx -y "a b" c')).toEqual(["npx", "-y", "a b", "c"]);
  expect(parseEnv("A=1\nB = two\nbad")).toEqual({ A: "1", B: "two" });
});

test("settings.json keeps the person's servers and replaces only Finch's", () => {
  const before = JSON.stringify({ ui: { theme: "x" }, mcpServers: { mine: { command: "x" }, old: { command: "gone" } } });
  const after = JSON.parse(applyJson(before, [fs, web], ["old"], "gemini"));
  expect(after.ui.theme).toBe("x");
  expect(after.mcpServers.mine).toEqual({ command: "x" });
  expect(after.mcpServers.old).toBeUndefined();
  expect(after.mcpServers.files).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/my docs"], env: { A: "1" } });
  expect(after.mcpServers.web).toEqual({ httpUrl: "http://localhost:8080/mcp" });
  const claude = JSON.parse(applyJson("", [web], [], "claude"));
  expect(claude.mcpServers.web).toEqual({ type: "http", url: "http://localhost:8080/mcp" });
});

test("config.toml gets one marked block, replaced in place and removed when empty", () => {
  const base = 'model = "o3"\n';
  const once = applyToml(base, [fs]);
  expect(once).toContain('[mcp_servers.files]\ncommand = "npx"');
  expect(once).toContain('[mcp_servers.files.env]\nA = "1"');
  const twice = applyToml(once, [web]);
  expect(twice.match(/finch:mcp start/g)?.length).toBe(1);
  expect(twice).toContain('url = "http://localhost:8080/mcp"');
  expect(applyToml(twice, [])).toBe(base);
  expect(existing(once, "toml").map((s) => s.name)).toEqual(["files"]);
  const last = existing('[mcp_servers.solo]\ncommand = "uvx"\nargs = ["srv"]\n', "toml");
  expect(last).toEqual([{ name: "solo", command: "uvx srv", url: "", env: {} }]);
});
