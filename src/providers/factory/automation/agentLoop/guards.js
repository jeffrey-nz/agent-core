export function enforceWriteRequirement({
  requireWriteFile,
  wroteAnyFile,
  hardBlocker,
}) {
  if (hardBlocker) {
    throw new Error(
      "Execution halted due to unmet hard dependency. Resolve and retry.",
    );
  }

  if (requireWriteFile && !wroteAnyFile) {
    throw new Error(
      "AI failed to complete task: no valid WRITE_FILE blocks were produced.",
    );
  }
}
