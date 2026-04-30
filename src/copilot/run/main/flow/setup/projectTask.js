export async function resolveProjectTask(options) {
  const { project, sessionInfo, targetRepoDir, projectTitle } = options;

  options.projectGoalTitle = projectTitle || "Upgrade Project";

  let rawTask =
    sessionInfo.scopeDoc ||
    sessionInfo.initialPrompt ||
    sessionInfo.state?.scopeDoc ||
    sessionInfo.state?.task ||
    "Continue the previous session.";

  rawTask = rawTask
    .replace(/(?:\[MILESTONE PLANNER MODE\]\nOVERALL GOAL:\s*)+/g, "")
    .trim();

  rawTask = rawTask
    .replace(/\[MICRO-WORKER\][\s\S]*?\[OVERALL CONTEXT\]\n?/g, "")
    .trim();

  rawTask = rawTask
    .replace(/\[SYSTEM MESSAGE: MULTI-PART CONTEXT[^\]]*\]\n*/g, "")
    .trim();
  rawTask = rawTask.replace(/\[CONTEXT TRUNCATED\]/g, "").trim();
  rawTask = rawTask.replace(/\[END OF CONTEXT\..*?\]/g, "").trim();
  rawTask = rawTask.replace(/CRITICAL REQUIRED ACTION:[\s\S]*/g, "").trim();

  const task =
    project?.getPrompt && sessionInfo.isNew
      ? await project.getPrompt({ promptText: rawTask, targetRepoDir })
      : rawTask;

  return task;
}
