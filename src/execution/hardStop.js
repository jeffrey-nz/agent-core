export function hardStop(reason) {
  return {
    status: "HALTED",
    reason,
    nextSteps:
      "Fix the issue above and restart the session. No automatic retries were performed.",
  };
}
