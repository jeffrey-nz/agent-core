export function attributeFailure({
  toolFailures,
  environmentLimits,
  logicErrors,
}) {
  if (logicErrors.length > 0) return "CODER_ERROR";
  if (environmentLimits.length > 0) return "ENVIRONMENT_LIMIT";
  if (toolFailures.length > 0) return "TOOLING_ERROR";
  return "UNKNOWN";
}
