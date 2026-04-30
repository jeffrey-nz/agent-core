export function guardVerdict({ reviewerVerdict, artifact }) {
  if (
    reviewerVerdict === "PASS" &&
    (!artifact?.modifiedFiles || artifact.modifiedFiles.length === 0)
  ) {
    throw new Error("Invalid verdict: PASS issued with no modified files.");
  }

  if (
    reviewerVerdict === "FAIL" &&
    typeof artifact?.outcome === "string" &&
    artifact.outcome.startsWith("PASS")
  ) {
    throw new Error("Invalid verdict: FAIL contradicts verified PASS outcome.");
  }
}
