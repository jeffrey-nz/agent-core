import { createRemoteSession, deleteRemoteSession } from "../../api/session.js";

export async function ensureAutomationSession({
  state,
  providerName,
  pendingMode,
}) {
  if (state.remoteSessionId) return;

  const sessionData = await createRemoteSession(providerName, pendingMode);
  state.remoteSessionId = sessionData.sessionId;

  if (sessionData.maxPromptChars) {
    state.maxPromptChars = sessionData.maxPromptChars;
  }
}

export async function closeAutomationSession(state) {
  if (!state?.remoteSessionId) return;

  await deleteRemoteSession(state.remoteSessionId);
  state.remoteSessionId = null;
}
