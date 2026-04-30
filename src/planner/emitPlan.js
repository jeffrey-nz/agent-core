import { PHASES } from "../session/phaseState.js";

export function emitPlan({ plan, subtasks, commit = false }, phaseState) {
  if (!plan || !Array.isArray(subtasks)) {
    throw new Error("Planner output missing required fields");
  }

  if (!commit) {
    return {
      plan,
      subtasks,
      note: "Plan generated. Execution will NOT start until commit=true is provided.",
    };
  }

  phaseState.commitPlan(subtasks);

  return {
    plan,
    subtasks,
    committed: true,
    message: "Plan committed. Execution may begin.",
  };
}
