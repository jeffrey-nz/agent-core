import { randomUUID } from "node:crypto";
import { PhaseState } from "../session/phaseState.js";
import { enforceToolsOnly } from "../execution/toolsOnlyGuard.js";
import { requireActiveSubtask } from "../execution/subtaskCursor.js";
import { hardStop } from "../execution/hardStop.js";

export async function agentLoop({ planner, executor, requestId = randomUUID() }) {
  const phaseState = new PhaseState();
  let subtasks = [];
  const config = { configurable: { requestId } };

  try {
    await planner.runResearch(config);
    phaseState.enterPlan();

    const planOutput = await planner.runPlanning(config);
    subtasks = planOutput.subtasks;

    if (!planOutput.committed) {
      return hardStop(
        "Plan was generated but not committed. Execution intentionally stopped.",
      );
    }

    while (true) {
      const currentSubtask = requireActiveSubtask(phaseState, subtasks);
      const output = await executor.runSubtask(currentSubtask, config);

      enforceToolsOnly({ phaseState, output });

      if (!phaseState.currentSubtaskId) break;
    }
  } catch (err) {
    return hardStop(err.message);
  }
}
