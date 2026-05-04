import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { configureWorkspace } from "./workspace.js";
import { createProvider } from "#providers/factory.js";
import { indexProject } from "#lib/rag/indexer.js";
import { getGitChangedFiles } from "#copilot/run/main/report/gitStats.js";
import { getReasoningMode } from "#config/reasoningConfig.js";

export async function initializeFlow(options, gitDir) {
  const { providerName, providerMode, project, projectId, sessionInfo } =
    options;

  await configureWorkspace(options, gitDir);

  if (sessionInfo?.bootstrapMode === "upload") {
    await indexProject(projectId, gitDir, project?.ignore || []);
  }

  // Read reasoningMode from task config if available, otherwise use global
  const reasoningMode = options.reasoningMode || getReasoningMode() || "none";

  const providerOpts = {
    reasoningMode,
    ...(gitDir ? { getProgressSummary: () => getGitChangedFiles(gitDir) } : {}),
  };

  const provider = await createProvider(providerName, providerOpts);

  const mode = providerMode ?? project?.mode ?? null;
  if (mode) {
    await provider.setMode(mode);
  }

  log(
    colors.dim(
      `\n  [Flow] Initializing fresh AI session for ${providerName}${mode ? ` [${mode} mode]` : ""} using native prompt caching...`,
    ),
  );
  await provider.startNewChat();

  return provider;
}
