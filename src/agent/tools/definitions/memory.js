import { z } from "zod";

export const memoryTools = {
  memory_save: {
    description:
      "Save a durable memory the next session will see. Use for: user " +
      "preferences/profile, feedback rules ('don't do X'), enduring project facts, " +
      "or pointers to external systems. Do NOT use for ephemeral task state or for " +
      "facts that can be re-derived by reading code/git. Stores Claude-compatible " +
      "frontmatter files under ~/.agent-core/memory/ (global) or the project's " +
      "docs/memory-bank/.",
    parameters: z.object({
      name: z
        .string()
        .describe(
          "Short kebab-case slug, used as the filename (e.g. 'user-prefers-terse-output').",
        ),
      description: z
        .string()
        .describe(
          "One-line summary surfaced in MEMORY.md index. Keep under ~150 chars.",
        ),
      type: z
        .enum(["user", "feedback", "project", "reference"])
        .describe(
          "user = facts about the user; feedback = rules the user has given; project = enduring project facts; reference = pointers to external systems",
        ),
      body: z
        .string()
        .describe(
          "Markdown body of the memory. For feedback/project, structure as: rule/fact, then **Why:** and **How to apply:** lines.",
        ),
      scope: z
        .enum(["global", "project"])
        .optional()
        .describe(
          "global (default) = ~/.agent-core/memory/ (cross-project), project = docs/memory-bank/ in the current repo (committed to git).",
        ),
    }),
  },
  memory_list: {
    description:
      "List all memories currently stored. Returns one line per memory with name + description. " +
      "Useful to check what is already remembered before writing a new one.",
    parameters: z.object({}),
  },
  memory_delete: {
    description:
      "Remove a memory by name. Use when a stored fact is wrong or no longer applicable.",
    parameters: z.object({
      name: z.string().describe("Memory slug (without .md extension)"),
      scope: z
        .enum(["global", "project"])
        .optional()
        .describe("Which scope to delete from (default: global)."),
    }),
  },
};
