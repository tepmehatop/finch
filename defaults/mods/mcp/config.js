// Finch MCP: how each agent keeps its MCP servers, without the host (tested in
// scripts/mcp.test.ts). Finch writes only the servers it manages and remembers
// their names, so servers the person added by hand stay as they are.

export const AGENTS = [
  { id: "gigacode", name: "GigaCode", dir: ".gigacode", file: ".gigacode/settings.json", kind: "gemini" },
  { id: "qwen", name: "Qwen Code", dir: ".qwen", file: ".qwen/settings.json", kind: "gemini" },
  { id: "claude", name: "Claude Code", dir: ".claude", file: ".claude.json", kind: "claude" },
  { id: "codex", name: "Codex", dir: ".codex", file: ".codex/config.toml", kind: "toml" },
];

// "npx -y @x/server --port 3" → ["npx", "-y", "@x/server", "--port", "3"] (quotes keep spaces).
export function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseEnv(text) {
  const env = {};
  for (const line of (text ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

function entry(server, kind) {
  const env = server.env && Object.keys(server.env).length ? { env: server.env } : {};
  if (server.url) {
    if (kind === "claude") return { type: "http", url: server.url };
    return { httpUrl: server.url };
  }
  const [command, ...args] = splitCommand(server.command ?? "");
  if (kind === "claude") return { type: "stdio", command, args, ...env };
  return { command, args, ...env };
}

/** settings.json (Gemini-style: GigaCode, Qwen) or ~/.claude.json: the new text. */
export function applyJson(text, servers, managed, kind) {
  const root = text && text.trim() ? JSON.parse(text) : {};
  const block = { ...(root.mcpServers ?? {}) };
  for (const name of managed) delete block[name];
  for (const s of servers) block[s.name] = entry(s, kind);
  root.mcpServers = block;
  return JSON.stringify(root, null, 2) + "\n";
}

const START = "# finch:mcp start";
const END = "# finch:mcp end";
const tomlString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** ~/.codex/config.toml: Finch's servers between its markers. */
export function applyToml(text, servers) {
  const lines = [START];
  for (const s of servers) {
    lines.push(`[mcp_servers.${s.name}]`);
    if (s.url) lines.push(`url = ${tomlString(s.url)}`);
    else {
      const [command, ...args] = splitCommand(s.command ?? "");
      lines.push(`command = ${tomlString(command)}`);
      lines.push(`args = [${args.map(tomlString).join(", ")}]`);
    }
    if (s.env && Object.keys(s.env).length) {
      lines.push(`[mcp_servers.${s.name}.env]`);
      for (const [k, v] of Object.entries(s.env)) lines.push(`${k} = ${tomlString(v)}`);
    }
  }
  lines.push(END);
  const block = servers.length ? lines.join("\n") : "";
  const a = (text ?? "").indexOf(START), b = (text ?? "").indexOf(END);
  if (a !== -1 && b > a) {
    const out = text.slice(0, a) + block + text.slice(b + END.length);
    return out.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  }
  if (!block) return text ?? "";
  return (text ? `${text.replace(/\s*$/, "")}\n\n` : "") + block + "\n";
}

/** Servers an agent already has (to import): [{name, command, url, env}]. */
export function existing(text, kind) {
  if (!text?.trim()) return [];
  if (kind === "toml") {
    const out = [];
    const re = /^\[mcp_servers\.([^\].]+)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
    let m;
    while ((m = re.exec(text))) {
      const body = m[2];
      const command = /^command\s*=\s*"([^"]*)"/m.exec(body)?.[1];
      const args = /^args\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1];
      const url = /^url\s*=\s*"([^"]*)"/m.exec(body)?.[1];
      const argList = args ? [...args.matchAll(/"([^"]*)"/g)].map((a) => a[1]) : [];
      out.push({ name: m[1], command: command ? [command, ...argList].join(" ") : "", url: url ?? "", env: {} });
    }
    return out;
  }
  try {
    const block = JSON.parse(text).mcpServers ?? {};
    return Object.entries(block).map(([name, e]) => ({
      name,
      command: e.command ? [e.command, ...(e.args ?? [])].join(" ") : "",
      url: e.url ?? e.httpUrl ?? "",
      env: e.env ?? {},
    }));
  } catch {
    return [];
  }
}
