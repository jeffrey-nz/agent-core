import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { detectProjectContext } from "#utils/detectProjectContext.js";

function buildResearchSystemPrompt(task, projectDir, projectType) {
  const typeHint = projectType && projectType !== "unknown"
    ? `Detected project type: ${projectType}.`
    : "";

  return `You are a Technical Research Assistant. Before clarification questions are asked, you will explore this codebase so the Q&A process can skip generic questions and focus only on genuinely ambiguous requirements.

Project directory: ${projectDir}
${typeHint}

YOUR GOAL: Produce a research report that answers - from the code itself - everything that would otherwise require a generic question ("what files are involved?", "what framework?", "where does X live?"). Only things that CANNOT be determined from the code alone should remain as open questions.

READ-ONLY MODE - use only these tools:
- read_file, list_dir, find_file, outline_file - navigate the codebase
- grep - search for patterns, class names, method names
- execute_bash - ONLY read-only commands: ls, find, cat, git log, grep, php -l

NEVER write, patch, delete, or move files. NEVER run build/install commands.

RESEARCH STEPS:
1. List the top-level project structure to orient yourself.
2. Read key configuration files (composer.json, package.json, .env.example, config/*.yml, etc.).
3. Search for files and classes most relevant to the user's task.
4. Read those files - understand the current implementation, class hierarchy, relevant methods.
5. Grep for any patterns, constants, or method names mentioned in the task.
6. Note any gaps: things the task implies that don't yet exist, or unclear requirements.

OUTPUT FORMAT - end your report with this exact section:
## RESEARCH SUMMARY
- **Project type**: [framework / language / version]
- **Task-relevant files**: [bullet list with full paths]
- **Current state**: [2-5 sentences on what already exists related to the task]
- **Clearly in scope**: [specific things the code confirms need to change]
- **Still needs clarification**: [only genuine unknowns - things not determinable from code]`;
}

/**
 * Runs an AI-driven research phase before the scoping Q&A via the browser provider.
 * Returns the research report as a string, or null if no provider available.
 */
export async function runScopingResearcher({
  provider,
  projectDir,
  allowedDirs = [],
  task,
  signal = null,
}) {
  if (!provider || !projectDir) return null;

  let projectType = "unknown";
  try {
    const ctx = detectProjectContext(projectDir);
    projectType = ctx.projectType;
  } catch { /* non-fatal */ }

  const systemPrompt = buildResearchSystemPrompt(task, projectDir, projectType);
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Task:\n${task}` },
  ];

  const context = {
    rootDir: projectDir,
    allowedDirs,
    readOnly: true,
    requireWriteFile: false,
    ignore: [],
    signal,
  };

  log(colors.dim("  [Scoping] AI researcher navigating project..."));

  const startTick = setInterval(() => {
    eventBus.emit("spinner_update", {
      status: "Scoping researcher - exploring codebase...",
    });
  }, 8000);

  try {
    const result = await provider.sendTurn(messages, "scoping-researcher", context);
    return result?.text || null;
  } finally {
    clearInterval(startTick);
  }
}
