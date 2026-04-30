export function requireActiveSubtask(phaseState, subtasks) {
  phaseState.assertExecutionAllowed();

  const current = subtasks.find((s) => s.id === phaseState.currentSubtaskId);

  if (!current) {
    throw new Error(
      "Execution blocked: no active subtask selected. Planner must set currentSubtaskId.",
    );
  }

  return current;
}
