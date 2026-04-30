import { getDirectoryListing } from "../automation/dirTree.js";
import { buildAutomationPromptText } from "../automation/promptBuilder.js";

export async function buildAutomationPrompt({
  messages,
  rootDir,
  toolContext,
  scoping,
  interactionMode = null,
  providerName,
}) {
  const allowedDirs = toolContext?.allowedDirs ?? [];
  const allDirs = Array.from(new Set([rootDir, ...allowedDirs].filter(Boolean)));

  // Skip dirTree for scoping (conversational), debugging, and readOnly (researcher/scoper)
  // — these agents discover structure via list_dir themselves. A large embedded tree
  // bloats the prompt and doesn't prevent bash-loop failures.
  const skipDirTree = scoping || interactionMode === "debugging" || interactionMode === "readOnly";

  let dirTree = "";
  if (!skipDirTree) {
    if (allDirs.length > 1) {
      // List each area separately so the AI knows what's available in each dir.
      const parts = await Promise.all(
        allDirs.map(async (dir) => {
          const listing = await getDirectoryListing({ rootDir: dir, toolContext });
          return listing ? `[${dir}]\n${listing}` : "";
        }),
      );
      dirTree = parts.filter(Boolean).join("\n\n");
    } else {
      dirTree = await getDirectoryListing({ rootDir, toolContext });
    }
  }

  const resolvedMode = scoping ? "scoping" : (interactionMode ?? null);

  return buildAutomationPromptText({
    messages,
    rootDir,
    dirTree,
    interactionMode: resolvedMode,
    requireWriteFile: !scoping && interactionMode !== "debugging" && interactionMode !== "readOnly",
    providerName,
    allowedDirs,
  });
}
