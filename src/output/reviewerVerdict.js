export function renderReviewerVerdict({
  outcome,
  definitionOfDone,
  classification,
}) {
  return `
VERDICT: ${outcome}

Definition of Done: ${definitionOfDone}
Failure Classification: ${classification}

This verdict is final based on recorded execution evidence.
`.trim();
}
