import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadMemoryContext } from "#docs/memory.js";

function resolveRepoPath(project) {
  return (
    project?.repoPath ||
    project?.legacy?.project?.targetRepoDir ||
    project?.dirAbs
  );
}

/**
 * Context retriever node — loads the project memory bank from docs/memory/.
 * Runs early in the pipeline (after intent, before researcher) so the agent
 * has architectural context, known gotchas, and current focus before it starts.
 * Also loads cross-session reflexion lessons from docs/memory/reflexion.md.
 */
export async function contextRetrieverNode({ project }) {
  if (!project) return { retrievedContext: "", reflexionContext: "" };

  const repoPath = resolveRepoPath(project);
  if (!repoPath) return { retrievedContext: "", reflexionContext: "" };

  const [retrievedContext, reflexionContext] = await Promise.all([
    loadMemoryContext(repoPath).catch(() => null),
    (async () => {
      try {
        const raw = await readFile(path.join(repoPath, "docs", "memory", "reflexion.md"), "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().startsWith("- ["));
        const recent = lines.slice(-10);
        return recent.length > 0
          ? `## Lessons Learned From Past Sessions\n${recent.join("\n")}`
          : "";
      } catch {
        return "";
      }
    })(),
  ]);

  return { retrievedContext: retrievedContext || "", reflexionContext: reflexionContext || "" };
}
