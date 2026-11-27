// Finch fan-out: launch lines and names, without the host (tested in scripts/fanout.test.ts).

// Agents built on Qwen Code take a first message with -i (and stay interactive).
const QWEN_FAMILY = new Set(["gigacode", "gigacode-qa", "qwen"]);
// The flag that picks the model.
export const MODEL_FLAG = { gigacode: "-m", "gigacode-qa": "-m", qwen: "-m", claude: "--model", codex: "-m" };

// How each agent starts with the task as its first message, on `model` if given.
export function launch(agent, task, model) {
  const run = [...(agent.run ?? [agent.key])];
  if (model && MODEL_FLAG[agent.key]) run.push(MODEL_FLAG[agent.key], model);
  if (QWEN_FAMILY.has(agent.key)) return [...run, "-i", task];
  if (["claude", "codex", "opencode", "gemini"].includes(agent.key)) return [...run, task];
  return run;
}

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
}
