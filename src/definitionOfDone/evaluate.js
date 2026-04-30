export function evaluateDefinitionOfDone({
  formatting,
  linting,
  deadCodeRemoved,
  assetsCleaned,
  tests,
  knownFailures,
}) {
  if (!assetsCleaned) return "FAIL";

  if (!formatting || !linting || !deadCodeRemoved) {
    return "INCOMPLETE";
  }

  if (
    tests.failed > 0 &&
    knownFailures?.status === "KNOWN_FAILURES_UNCHANGED"
  ) {
    return "PASS_WITH_KNOWN_FAILURES";
  }

  if (tests.failed === 0) {
    return "PASS";
  }

  return "FAIL";
}
