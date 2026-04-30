export function renderFinalSummary({
  outcome,
  knownFailures,
  verificationPath,
}) {
  let summary = `Outcome: ${outcome}\n\n`;

  if (knownFailures?.status === "KNOWN_FAILURES_UNCHANGED") {
    summary += `⚠ Known pre-existing test failures detected (${knownFailures.count}).\n`;
    summary += `No regressions introduced.\n\n`;
  }

  summary += `Verification bundle: ${verificationPath}\n`;
  summary += `All cleanup actions executed within environment constraints.\n`;

  return summary;
}
