export const SESSION_PHASES = {
  EXPLORE: "EXPLORE",
  PLAN: "PLAN",
  EXECUTE: "EXECUTE",
  VERIFY: "VERIFY",
  COMPLETE: "COMPLETE",
};

export function isWritePhase(phase) {
  return phase === SESSION_PHASES.EXECUTE;
}

export function allowsPlanningOnly(phase) {
  return phase === SESSION_PHASES.EXPLORE || phase === SESSION_PHASES.PLAN;
}
