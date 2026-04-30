export function hardStopIfFinalized(subtask) {
  if (subtask?.finalized) {
    throw new Error(
      `Subtask ${subtask.subtaskId} is finalized. Further execution is not permitted.`,
    );
  }
}
