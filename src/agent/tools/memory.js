/**
 * memory_save tool — lets the agent persist a finding as a Claude-style
 * memory file that future sessions will see.
 *
 * Args:
 *   name        — short kebab-case slug (becomes the filename)
 *   description — one-line summary, surfaced in MEMORY.md index
 *   type        — "user" | "feedback" | "project" | "reference"
 *   body        — markdown body (the actual memory content)
 *   scope       — "global" (default, ~/.agent-core/memory/) or "project"
 */

import { writeMemory, deleteMemory, listMemories } from "#memory/bank.js";

export async function executeMemoryTool(name, args = {}, context = {}) {
  if (name === "memory_save") {
    const required = ["name", "description", "type", "body"];
    for (const k of required) {
      if (typeof args[k] !== "string" || !args[k].trim()) {
        return {
          ok: false,
          error: `memory_save: missing required field "${k}"`,
          text: `[ERROR] memory_save needs ${required.join(", ")} as non-empty strings.`,
        };
      }
    }
    const scope = args.scope === "project" ? "project" : "global";
    try {
      const filePath = await writeMemory({
        name: args.name.trim(),
        description: args.description.trim(),
        type: args.type.trim(),
        body: args.body,
        scope,
        projectDir: context?.rootDir || null,
      });
      const msg = `[memory_save] Wrote ${scope} memory "${args.name}" to ${filePath}`;
      return { ok: true, text: msg, path: filePath };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        text: `[ERROR] memory_save failed: ${err.message}`,
      };
    }
  }

  if (name === "memory_delete") {
    if (typeof args.name !== "string" || !args.name.trim()) {
      return {
        ok: false,
        error: "memory_delete: name is required",
        text: `[ERROR] memory_delete needs "name".`,
      };
    }
    const scope = args.scope === "project" ? "project" : "global";
    const removed = await deleteMemory(args.name.trim(), {
      scope,
      projectDir: context?.rootDir || null,
    });
    return {
      ok: removed,
      text: removed
        ? `[memory_delete] Removed ${scope} memory "${args.name}".`
        : `[memory_delete] No ${scope} memory named "${args.name}" found.`,
    };
  }

  if (name === "memory_list") {
    const all = await listMemories({ projectDir: context?.rootDir || null });
    if (all.length === 0) {
      return { ok: true, text: "[memory_list] No memories stored." };
    }
    const lines = all.map((m) => {
      const scopeTag = m.scope ? `[${m.scope}]` : "";
      return `- ${scopeTag} ${m.meta?.name || m.file}: ${m.meta?.description || "(no description)"}`;
    });
    return { ok: true, text: `[memory_list]\n${lines.join("\n")}` };
  }

  return { ok: false, error: `Unknown memory tool: ${name}`, text: `[ERROR] Unknown memory tool: ${name}` };
}
