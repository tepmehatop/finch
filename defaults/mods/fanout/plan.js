// Finch fan-out: launch lines and names, without the host (tested in scripts/fanout.test.ts).

// How each agent takes a first message on its command line.
export function launch(agent, task) {
  const run = [...(agent.run ?? [agent.key])];
  if (agent.key === "gigacode" || agent.key === "qwen") return [...run, "-i", task];
  if (["claude", "codex", "opencode", "gemini"].includes(agent.key)) return [...run, task];
  return run;
}

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
}
