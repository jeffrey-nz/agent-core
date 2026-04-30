import {
  buildScopingInitialMessage,
  buildScopingResumeMessage,
} from "./buildScopingPrompt.js";

export function buildInitialScopingPrompt({
  project,
  projectId,
  initialPrompt,
  qaHistory,
  research,
  projectType = null,
}) {
  const projectTitle = project?.title || projectId || "Project";
  const targetRepoDir = project?.targetRepoDir || null;
  const resolvedProjectType = projectType || project?.projectType || null;

  return qaHistory.length > 0
    ? buildScopingResumeMessage({
        projectTitle,
        targetRepoDir,
        initialPrompt,
        qaHistory,
      })
    : buildScopingInitialMessage({
        projectTitle,
        targetRepoDir,
        initialPrompt,
        research,
        projectType: resolvedProjectType,
      });
}
