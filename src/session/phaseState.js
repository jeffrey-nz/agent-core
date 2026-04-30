export const PHASES = {
  RESEARCH: "RESEARCH",
  PLAN: "PLAN",
  EXECUTION: "EXECUTION",
};

export class PhaseState {
  constructor() {
    this.phase = PHASES.RESEARCH;
    this.planCommitted = false;
    this.currentSubtaskId = null;
  }

  enterPlan() {
    if (this.phase !== PHASES.RESEARCH) {
      throw new Error("Invalid phase transition to PLAN");
    }
    this.phase = PHASES.PLAN;
  }

  commitPlan(subtasks) {
    if (this.phase !== PHASES.PLAN) {
      throw new Error("Plan can only be committed from PLAN phase");
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      throw new Error("Cannot commit an empty plan");
    }
    this.planCommitted = true;
    this.currentSubtaskId = subtasks[0].id;
    this.phase = PHASES.EXECUTION;
  }

  assertExecutionAllowed(capabilities = {}) {
    if (this.phase !== PHASES.EXECUTION || !this.planCommitted) {
      throw new Error("Execution blocked: plan not committed.");
    }

    if (!capabilities.filesystem) {
      throw new Error(
        "Execution blocked: filesystem access is required but unavailable.",
      );
    }
  }
}
