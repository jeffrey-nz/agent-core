export function classifyFailure({ toolError, taskEvidence }) {
  if (toolError && taskEvidence) {
    return {
      classification: "ENVIRONMENT_LIMITATION",
      message: "Task logic completed, but tooling prevented full automation.",
    };
  }

  if (toolError && !taskEvidence) {
    return {
      classification: "BLOCKED",
      message: "Task could not be executed due to environment constraints.",
    };
  }

  return {
    classification: "TASK_FAILURE",
    message: "Task execution failed due to logic or correctness issues.",
  };
}
