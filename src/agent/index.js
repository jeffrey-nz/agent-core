import { buildAgentWorkflow } from "./graph/workflow.js";
import { resetCheckpointState, updateCheckpointState } from "./graph/checkpointBridge.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function runAgent(params) {
  const { provider, projectDir, projectId, ignore, task, sessionInfo, contextDirs, signal, resumeState, githubOptions } = params;
  const bootstrapMode = sessionInfo?.bootstrapMode ?? "crawl";

  // The scoping flow converts the user's full prompt into a concise scope document,
  // stripping content like issue lists or notes that appear in documentation tasks.
  // Preserve the original prompt so nodes that need the actual content can use it.
  const initialPrompt = sessionInfo?.initialPrompt || task;

  log(`\n${colors.magenta("🤖 Starting LangGraph Workflow...")}`);
  log(
    colors.dim(
      `  Mode: ${bootstrapMode === "upload" ? "Pre-load codebase" : "Standard (AI explores)"}`,
    ),
  );

  resetCheckpointState();

  const workflow = buildAgentWorkflow();

  // Prepend GitHub issue context notes as a second message so the researcher/coder
  // has background from prior sessions without overwriting the task message.
  const initialMessages = [{ role: "user", content: task }];
  if (sessionInfo?.issueContext) {
    initialMessages.push({
      role: "user",
      content:
        `[GITHUB PROJECT CONTEXT — notes and decisions from prior sessions on this issue]\n\n` +
        `${sessionInfo.issueContext}\n\n` +
        `[END PROJECT CONTEXT — use this for background; do not treat it as requirements]`,
    });
  }

  const initialState = {
    messages: initialMessages,
    projectId: projectId || "default",
    projectDir: projectDir || "",
    ignore: ignore || [],
    model: provider.model ?? null,
    bootstrapMode,
    provider,
    subtasks: resumeState?.subtasks || [],
    currentSubtaskIndex: resumeState?.currentSubtaskIndex || 0,
    contextDirs: contextDirs ?? [],
    initialPrompt,
    githubOptions: githubOptions ?? null,
    subtaskIssueMap: resumeState?.subtaskIssueMap || {},
    taskType: sessionInfo?.taskType || null,
    benchmarkScenarioId: sessionInfo?._benchmarkScenarioId || null,
  };

  const finalState = await workflow.invoke(initialState, {
    recursionLimit: 500,
    signal,
  });

  return {
    ok: true,
    state: finalState,
  };
}
