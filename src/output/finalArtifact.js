export function buildFinalArtifact({
  outcome,
  fileChanges,
  testComparison,
  verificationBundle,
  ledger,
}) {
  return {
    outcome,
    filesChanged: fileChanges,
    tests: testComparison,
    verification: verificationBundle,
    executionLedger: ledger,
    generatedAt: new Date().toISOString(),
  };
}
