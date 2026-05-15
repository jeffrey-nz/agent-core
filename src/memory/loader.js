/**
 * Memory loader — builds a single text block ready to inject into a system
 * prompt. Mirrors how Claude Code surfaces its memory bank to the model:
 * the MEMORY.md index always loads, then individual files are listed with
 * their bodies (truncated to fit a soft budget).
 */

import { listMemories } from "./bank.js";

/**
 * Renders all available memories (project ∪ global) as a markdown block
 * suitable for prepending to a system prompt.
 *
 * @param {object} opts
 * @param {string|null} opts.projectDir - if provided, project-scope memories
 *   are merged in (and override global entries with the same name)
 * @param {number} opts.maxChars - soft cap for the rendered block
 * @returns {Promise<string>} block ready to inject, or "" if no memories exist
 */
export async function renderMemorySnapshot({
  projectDir = null,
  maxChars = 8000,
} = {}) {
  const all = await listMemories({ projectDir });
  if (all.length === 0) return "";

  // Group by type so the agent reads them in a predictable order.
  const order = ["user", "feedback", "project", "reference"];
  const groups = new Map(order.map((t) => [t, []]));
  for (const m of all) {
    const t = m.meta?.metadata?.type || m.meta?.type || "reference";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(m);
  }

  const lines = [
    "## Memory bank",
    "",
    "The following are durable memories from prior sessions. Treat them as",
    "context that informs your work. Order: user profile → feedback rules →",
    "project facts → references.",
    "",
  ];

  let budget = maxChars - lines.join("\n").length;

  for (const type of order) {
    const items = groups.get(type) || [];
    if (items.length === 0) continue;
    const header = `### ${type.charAt(0).toUpperCase() + type.slice(1)}`;
    lines.push(header, "");
    budget -= header.length + 2;

    for (const m of items) {
      const name = m.meta?.name || m.file;
      const desc = m.meta?.description || "";
      const scope = m.scope ? ` (${m.scope})` : "";
      const heading = `**${name}**${scope}${desc ? ` — ${desc}` : ""}`;
      const body = m.body || "";
      const entry = `${heading}\n\n${body}\n`;

      if (entry.length > budget) {
        // Truncate body to fit remaining budget
        const headerLen = heading.length + 4;
        const room = Math.max(0, budget - headerLen - 50);
        if (room < 100) {
          lines.push(`${heading} _(truncated — out of budget)_`);
          budget = 0;
          break;
        }
        lines.push(`${heading}\n\n${body.slice(0, room)}…\n`);
        budget = 0;
      } else {
        lines.push(entry);
        budget -= entry.length;
      }
      if (budget <= 0) break;
    }
    if (budget <= 0) break;
  }

  return lines.join("\n").trim() + "\n";
}

/**
 * Lightweight summary used when only a hint of memories is needed (e.g. as
 * part of the planning context). Lists names + descriptions, no bodies.
 */
export async function renderMemoryIndex({ projectDir = null } = {}) {
  const all = await listMemories({ projectDir });
  if (all.length === 0) return "";
  const lines = ["## Memory index", ""];
  for (const m of all) {
    const name = m.meta?.name || m.file;
    const desc = m.meta?.description || "";
    const scope = m.scope ? ` (${m.scope})` : "";
    lines.push(`- **${name}**${scope}${desc ? ` — ${desc}` : ""}`);
  }
  return lines.join("\n") + "\n";
}
