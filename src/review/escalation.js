export function shouldEscalate({ verdictHistory, evidenceUnchanged }) {
  if (!verdictHistory || verdictHistory.length < 3) {
    return false;
  }

  const consecutiveFails = verdictHistory.slice(-3).every((v) => v === "FAIL");

  if (consecutiveFails && evidenceUnchanged) {
    return true;
  }

  return false;
}
