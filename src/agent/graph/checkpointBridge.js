/**
 * checkpointBridge.js
 *
 * Module-level store that tracks the agent state fields needed for a self-heal
 * resume checkpoint. Updated by agent nodes as they run so that if the process
 * crashes mid-execution, webModeLoop can read the latest known-good state and
 * save it to the SQLite checkpoint table before restarting.
 *
 * This avoids polluting dashboardState (which is UI-facing) with agent internals,
 * and avoids the brittleness of trying to reconstruct agent state from the
 * LangGraph final state (which is unavailable on a crash).
 *
 * Updated by:
 *   researcherNode  → projectType, projectConstraints
 *   scoperNode      → scopeDocument
 *   projectManagerNode → subtasks, executionPlan (resets currentSubtaskIndex to 0)
 *   nextSubtaskNode → currentSubtaskIndex (incremented)
 *
 * Read by:
 *   webModeLoop (catch block) → dashSnap passed to saveResumeCheckpoint
 */

const _state = {
  subtasks: [],
  executionPlan: "",
  currentSubtaskIndex: 0,
  projectType: "unknown",
  projectConstraints: "",
  scopeDocument: "",
};

/**
 * Merges fields into the bridge state.
 * Called from agent nodes as they produce resume-relevant output.
 *
 * @param {Partial<typeof _state>} fields
 */
export function updateCheckpointState(fields) {
  Object.assign(_state, fields);
}

/**
 * Returns a snapshot of the current bridge state for use in a checkpoint.
 * Shallow-copies to prevent external mutation.
 *
 * @returns {typeof _state}
 */
export function getCheckpointState() {
  return {
    subtasks: _state.subtasks,
    executionPlan: _state.executionPlan,
    currentSubtaskIndex: _state.currentSubtaskIndex,
    projectType: _state.projectType,
    projectConstraints: _state.projectConstraints,
    scopeDocument: _state.scopeDocument,
  };
}

/**
 * Resets all bridge state back to defaults.
 * Called at the start of each new session so stale state from a prior run
 * cannot contaminate a fresh session's checkpoint.
 */
export function resetCheckpointState() {
  _state.subtasks = [];
  _state.executionPlan = "";
  _state.currentSubtaskIndex = 0;
  _state.projectType = "unknown";
  _state.projectConstraints = "";
  _state.scopeDocument = "";
}
