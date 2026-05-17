import { buildJsonToolsFollowUp } from "../actions/jsonTools.js";

export async function executeStep(state, parsed, step) {
  const { jsonToolCalls } = parsed;
  const isCopilot = state.providerName?.includes('copilot') ?? false;

  if (jsonToolCalls.length) {
    state.markProgress();

    // For Copilot, skip the verbose tool-result follow-up (which can exceed
    // the 9500-char limit). Send a compact acknowledgement instead.
    if (isCopilot) {
      const fileCount = jsonToolCalls.filter(tc => (tc.tool || tc.name || "").includes("write_file")).length;
      const remaining = state.toolContext?.plannedFileCount
        ? ` You planned ${state.toolContext.plannedFileCount} file(s) total.`
        : "";
      const copilotFollowUp =
        `[FILES WRITTEN] ${fileCount} file(s) saved to disk.${remaining} ` +
        `If all files for this subtask are complete, output: TASK_DONE. ` +
        `Otherwise output more files using the <<<FILE: path>>> format.`;

      await buildJsonToolsFollowUp({
        jsonToolCalls,
        toolContext: state.toolContext,
        toolCalls: state.toolCalls,
        executionErrors: state.executionErrors,
      });

      state.responseText = await state.send(
        state.remoteSessionId,
        copilotFollowUp,
        `${state.label} [tools ${step + 1}]`,
      );
      return;
    }

    // DeepSeek: skip tool-result follow-up entirely after any write_file.
    // DeepSeek is a single-shot limited-output provider — after generating a large
    // file response the UI can't accept a second submission (HTTP 500 "input did
    // not clear"). Execute tools to write the files but return [] instead of
    // sending the tool result back.  This also handles the empty-content case.
    const isDeepSeek = state.providerName === "deepseek";
    if (isDeepSeek && jsonToolCalls.length > 0) {
      const hasWriteFile = jsonToolCalls.some(tc => {
        const name = (tc.tool || tc.name || "");
        return name === "write_file" || name === "patch_file";
      });
      if (hasWriteFile) {
        await buildJsonToolsFollowUp({
          jsonToolCalls,
          toolContext: state.toolContext,
          toolCalls: state.toolCalls,
          executionErrors: state.executionErrors,
        });
        state.responseText = "[]"; // signal done — don't send result back to DeepSeek
        return;
      }
    }

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

  const continueMsg = isCopilot
    ? `[FILES WRITTEN] The files above have been saved to disk.${remaining} If all files for this task are written, output: TASK_DONE. Otherwise output more files using the <<<FILE: path>>> format.`
    : `[TOOLS EXECUTED] Results above.${remaining} If all files for this task are written, output: TASK_DONE. Otherwise output the next batch of tool calls as a JSON array.`;

  state.responseText = await state.send(
    state.remoteSessionId,
    continueMsg,
    `${state.label} [continue ${step + 1}]`,
  );
}
