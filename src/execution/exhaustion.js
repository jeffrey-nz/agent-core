export function isExecutionExhausted({
  attemptedActions,
  successfulActions,
  toolFailures,
  hardBlocker,
}) {
  if (hardBlocker) {
    return true;
  }

  if (successfulActions.length > 0) return false;

  if (toolFailures.length >= attemptedActions.length) {
    return true;
  }

  return false;
}
