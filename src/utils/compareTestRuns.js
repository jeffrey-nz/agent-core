export function compareTestRuns(before, after) {
  const sameCount =
    before.failed === after.failed &&
    before.failedCases.sort().join("|") === after.failedCases.sort().join("|");

  return {
    regression: after.failed > before.failed || !sameCount,
    stableFailures: sameCount,
  };
}
