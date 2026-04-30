export function declareKnownFailures(before, after) {
  if (
    before.failed === after.failed &&
    before.failedCases.join("|") === after.failedCases.join("|")
  ) {
    return {
      status: "KNOWN_FAILURES_UNCHANGED",
      count: before.failed,
      cases: before.failedCases,
    };
  }

  return {
    status: "CHANGED_FAILURES",
    before,
    after,
  };
}
