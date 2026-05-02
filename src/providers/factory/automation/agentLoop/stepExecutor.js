import { buildJsonToolsFollowUp } from "../actions/jsonTools.js";

export async function executeStep(state, parsed, step) {
  const { jsonToolCalls } = parsed;

  if (jsonToolCalls.length) {
    state.markProgress();

    state.responseText = await state.send(
      state.remoteSessionId,
      await buildJsonToolsFollowUp({
        jsonToolCalls,
        toolContext: state.toolContext,
        toolCalls: state.toolCalls,
        executionErrors: state.executionErrors,
      }),
      `${state.label} [tools ${step + 1}]`,
    );
    return;
  }

  // No tool calls in this parsed step — ask the AI to either write remaining
  // files or signal TASK_DONE. Include the planned file count if available so
  // the AI knows how many files it still needs to write.
  const remaining = state.toolContext?.plannedFileCount
    ? ` You planned ${state.toolContext.plannedFileCount} file(s) — write any remaining ones now.`
    : "";

  state.responseText = await state.send(
    state.remoteSessionId,
    `[TOOLS EXECUTED] Results above.${remaining} If all files for this task are written, output: TASK_DONE. Otherwise output the next batch of tool calls as a JSON array.`,
    `${state.label} [continue ${step + 1}]`,
  );
}
