export function executionGuarantee() {
  return `
Copilot-helper guarantees:
- No task is retried after execution exhaustion
- No reviewer verdict may contradict recorded artifacts
- No environment failure is misclassified as coder failure
- No known, stable test failures block task completion
`.trim();
}
