import {
  saveSessionState,
  loadSessionState,
} from "#copilot/run/main/sessionState/io.js";

export async function saveScopingState(
  projectId,
  sessionId,
  initialPrompt,
  qaHistory,
  scopeDoc,
) {
  const existing = (await loadSessionState(projectId, sessionId)) || {};
  await saveSessionState(projectId, sessionId, {
    ...existing,
    status: scopeDoc ? "approved" : "scoping",
    initialPrompt,
    qaHistory,
    scopeDoc,
    task: scopeDoc || initialPrompt,
  });
}
