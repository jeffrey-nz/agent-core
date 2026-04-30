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

  state.responseText = await state.send(
    state.remoteSessionId,
    "[SYSTEM] Tools executed. Continue with the next step or state completion.",
    `${state.label} [continue ${step + 1}]`,
  );
}
