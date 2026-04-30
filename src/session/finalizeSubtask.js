export function finalizeSubtask({ subtaskId, outcome, evidencePath }) {
  return {
    subtaskId,
    finalized: true,
    outcome,
    evidencePath,
    finalizedAt: new Date().toISOString(),
  };
}
