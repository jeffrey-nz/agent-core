const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "patch_file",
  "apply_diff",
  "delete_file",
  "move_file",

  "write",
  "edit_file",
  "create_file",
]);

export function createLoopState({
  remoteSessionId,
  rootDir,
  toolContext,
  label,
  initialResponseText,
  send,
  requireWriteFile,
  requireTools = false,
  providerName = null,
}) {
  const state = {
    remoteSessionId,
    rootDir,
    toolContext,
    label,
    send,
    requireWriteFile,
    requireTools,
    providerName,
    maxSteps: 20,

    responseText: initialResponseText || "",
    toolCalls: [],
    executionErrors: [],   // { tool, summary } for execution tools that returned non-zero
    consecutiveNoActivity: 0,

    madeProgress: false,
    planningComplete: false,
    needsRotation: false,

    markProgress() {
      state.madeProgress = true;
      state.consecutiveNoActivity = 0;
    },

    result() {
      const modifiedFiles = state.toolCalls
        .filter((tc) => WRITE_TOOL_NAMES.has(tc.tool || tc.name))
        .map((tc) => {
          const nested = tc.parameters || tc.input || {};
          return nested.path || nested.destination || tc.path || tc.destination;
        })
        .filter((p) => Boolean(p) && p !== "/abs/path" && !/^\/abs\//.test(p) && p !== "/path/to/file");
      return {
        responseText: state.responseText,
        toolCalls: state.toolCalls,
        executionErrors: state.executionErrors,
        modifiedFiles,
        madeProgress: state.madeProgress,
        needsRotation: state.needsRotation,
      };
    },
  };

  return state;
}
