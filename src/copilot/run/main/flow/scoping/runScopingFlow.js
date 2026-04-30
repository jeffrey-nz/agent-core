import { logPhase } from "#app/ui/phases.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { runScopingLoop } from "./scopingLoop.js";
import { finalizeScoping } from "./scopingFinalize.js";
import { buildScopingResearch } from "./scopingResearch.js";
import { runScopingResearcher } from "./runScopingResearcher.js";
import { throwIfAborted } from "#utils/abort.js";

export async function runScopingFlow({
  provider,
  project,
  initialPrompt,
  sessionId,
  projectId,
  qaHistory = [],
  contextDirs = [],
  signal = null,
  githubIssueNumber = null,
}) {
  logPhase("PHASE 0.5", "SCOPING", "Defining requirements");

  const projectDir = project?.targetRepoDir || null;

  // Run a full AI-driven research phase before any clarification questions.
  // The AI navigates the codebase with tools (read_file, grep, list_dir, etc.)
  // so the scoping Q&A is grounded in actual code, not assumptions.
  let research = null;
  if (projectId && projectDir) {
    try {
      log(colors.cyan("  [Scoping] Researching project before asking questions..."));
      const report = await runScopingResearcher({
        provider,
        projectId,
        projectDir,
        allowedDirs: contextDirs,
        task: initialPrompt,
        signal,
      });

      // Propagate abort even if the researcher returned null (null is the normal
      // fall-through on a failed/timed-out turn, so we'd otherwise silently
      // continue and waste a startNewChat + new session before aborting).
      throwIfAborted(signal);

      if (report) {
        // Build the static snapshot too (file tree, cheatsheet, constraints) and
        // merge it with the AI report so the scoping prompt has both.
        const staticResearch = await buildScopingResearch(projectId, projectDir, initialPrompt).catch(() => null);
        research = { ...staticResearch, report };
        log(colors.green("  [Scoping] Research complete — scoping will be informed."));
      } else {
        // AI returned nothing; use the static snapshot as fallback.
        research = await buildScopingResearch(projectId, projectDir, initialPrompt).catch(() => null);
        log(colors.dim("  [Scoping] Using static research snapshot."));
      }
    } catch (err) {
      // Re-throw abort errors — don't fall back to static research when aborting.
      if (err?.message?.includes("Aborted") || signal?.aborted) throw err;
      log(colors.yellow(`  [Scoping] Research failed (${err.message}), proceeding without it.`));
      research = await buildScopingResearch(projectId, projectDir, initialPrompt).catch(() => null);
    }
  }

  throwIfAborted(signal);
  await provider.startNewChat();

  const { scopeDoc, finalHistory } = await runScopingLoop({
    provider,
    project,
    initialPrompt,
    sessionId,
    projectId,
    qaHistory,
    research,
    projectDir,
  });

  return await finalizeScoping({
    provider,
    project,
    projectId,
    sessionId,
    initialPrompt,
    qaHistory: finalHistory,
    scopeDoc,
    research,
    githubIssueNumber,
  });
}
