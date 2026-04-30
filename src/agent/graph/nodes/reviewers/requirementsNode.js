import { createReviewer } from "./createReviewer.js";

// ---------------------------------------------------------------------------
// Task classification helpers
// ---------------------------------------------------------------------------

// Matches tasks whose primary action is running/verifying commands.
const EXECUTION_VERB_RE =
  /\b(run|execute|verify|check|confirm|baseline|validate|audit|inspect)\b/i;
const CODING_VERB_RE =
  /\b(implement|write|create|add|build|fix|refactor|modify|update|remove|delete|configure)\b/i;
// Named tool/command references — "run composer install" means execution, not implementation.
const NAMED_COMMAND_RE =
  /\b(composer|phpunit|phpstan|sake|dev\/build|db:build|artisan|npm run|yarn|pnpm|dotnet build|dotnet test|node )\b/i;

// Fix tasks require proof-of-fix (command output showing error is gone).
const FIX_TASK_RE =
  /\b(fix|fixing|fixes|fixed|resolve|resolving|resolves|repair|repairing|debug|debugging|correct|correcting)\b/i;
const ERROR_CONTEXT_RE =
  /\b(error|exception|fatal|crash|fail|failure|broken|bug|issue|problem|stack.?trace)\b/i;

// Acceptance test subtasks: verifier already confirmed HTTP evidence — auto-pass.
const ACCEPTANCE_TEST_RE = /^ACCEPTANCE TEST:/i;

const EXECUTION_TOOL_NAMES = new Set([
  "run_composer",
  "run_phpunit",
  "execute_bash",
  "run_sake",
  "run_npm",
]);

function isExecutionOnlySubtask(task) {
  if (!EXECUTION_VERB_RE.test(task)) return false;
  if (!CODING_VERB_RE.test(task)) return true;
  // Has both verbs — execution wins if a named command is present
  return NAMED_COMMAND_RE.test(task);
}

function isFixTask(task) {
  return FIX_TASK_RE.test(task) && ERROR_CONTEXT_RE.test(task);
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export const requirementsNode = createReviewer({
  persona: "Requirements",
  personaKey: "requirementsReviewer",
  icon: "📋",
  description: "Checking completeness against the original task",
  label: "Requirements Review",

  shouldAutoPass: (state) => {
    // Coder was blocked (target file not found) — nothing was written, nothing to review.
    if (state.sessionBlocked) {
      return { pass: true, reason: "task was blocked — nothing to requirements-review" };
    }

    // Benchmark scenarios (direct_fix): check.js is the ground truth evaluator.
    // AI review of correctness is redundant and causes timeout loops.
    if (state.taskType === "direct_fix") {
      return { pass: true, reason: "benchmark scenario — check.js is the ground truth evaluator" };
    }

    // No files modified and no execution tools ran — nothing was done, review is vacuous.
    if (!state.modifiedFiles?.length && !(state.lastToolsExecuted?.length > 0)) {
      return { pass: true, reason: "no files modified and no tools executed — nothing to requirements-review" };
    }

    const currentTask = state.subtasks?.[state.currentSubtaskIndex]?.task || "";
    const originalTask = state.messages[0]?.content || "";

    // Acceptance test subtasks: the deterministic verifier already confirmed HTTP evidence.
    if (ACCEPTANCE_TEST_RE.test(currentTask)) {
      if (/ACCEPTANCE TEST PASSED/i.test(state.lastCoderResponse || "")) {
        return { pass: true, reason: "acceptance test subtask — verifier confirmed HTTP evidence" };
      }
    }

    // Execution-only tasks: verifier already confirmed command tools ran.
    const isExecTask = isExecutionOnlySubtask(currentTask);
    const executionToolCalled = (state.lastToolsExecuted || []).some((t) =>
      EXECUTION_TOOL_NAMES.has(t),
    );
    const isAFixTask = isFixTask(currentTask) || isFixTask(originalTask);

    if (isExecTask && executionToolCalled && !(state.lastExecutionErrors?.length > 0) && !isAFixTask) {
      return {
        pass: true,
        reason: "execution task — verifier already confirmed command tools ran",
      };
    }

    return null;
  },

  buildPrompt: (state, fileBlocks) => {
    const currentTask = state.subtasks?.[state.currentSubtaskIndex]?.task || "Complete remaining requirements";
    const originalTask = state.messages[0]?.content || "";
    const noFilesModified = !state.modifiedFiles || state.modifiedFiles.length === 0;
    const isExecTask = isExecutionOnlySubtask(currentTask);
    const isAFixTask = isFixTask(currentTask) || isFixTask(originalTask);

    const executionContext =
      state.lastCoderResponse && (noFilesModified || isExecTask)
        ? `\nAGENT EXECUTION RESPONSE (last coder turn — check this for real tool output):\n\`\`\`\n${state.lastCoderResponse.slice(0, 6000)}\n\`\`\``
        : "";

    const executionErrorContext =
      state.lastExecutionErrors?.length > 0
        ? `\nDETECTED EXECUTION FAILURES (commands that returned non-zero exit codes or fatal errors):\n${state.lastExecutionErrors.map((e) => `[${e.tool}]\n${e.summary}`).join("\n\n")}\n`
        : "";

    const execTaskGuideline = isExecTask
      ? `5. EXECUTION TASK RULE: This subtask's PRIMARY goal is running commands and verifying outputs — NOT writing source code. Do NOT fail because no source files were written or because lock files changed. PASS if the execution output shows the required commands ran without fatal errors. FAIL only if the required commands were clearly not run at all, or if the output shows an unresolved fatal error.\n`
      : "";

    const fixTaskGuideline = isAFixTask
      ? `PROOF-OF-FIX RULE (CRITICAL): This task involves fixing a reported error. A code change is NOT sufficient on its own. PASS only if there is real command execution output in the agent's response that confirms the previously-failing command now runs without the error. Requirements for PASS:
  - The relevant command was actually run (run_sake, run_composer, run_phpunit, execute_bash, or similar)
  - The command output does NOT contain the original error, fatal exceptions, or non-zero exit codes
  - The agent shows the real output, not a paraphrase or claim of success
  FAIL if: the agent only changed files but did not run the command, or if the command output still shows errors.\n`
      : "";

    return `You are a strict Product Manager and QA Tester.
Review the work against the ORIGINAL TASK, the OVERALL EXECUTION PLAN, and specifically the CURRENT SUBTASK.

[CRITICAL EVALUATION GUIDELINES]
1. IMPLEMENTATION VS EXECUTION: If the current subtask is an execution or verification task (run commands, verify outputs), the Coder PASSES if they actually ran the required tools and the output shows success. Text claims without real tool output are NOT sufficient — that is a FAIL.
2. COMPLETENESS: Does the work actually satisfy the CURRENT SUBTASK? Do not fail for ignoring broader plan items outside the current subtask scope.
3. VERIFICATION: For command-execution subtasks (composer, db:build, phpunit, etc.), the Coder must have ACTUALLY RUN the command and shown the real output. A fabricated or paraphrased output is a FAIL.
4. DOCUMENTATION: For subtasks that produce a verification document, the document must accurately reflect what was actually executed — not aspirational claims.
${execTaskGuideline}${fixTaskGuideline}
Respond with EXACTLY one of these verdicts on its own line:
VERDICT: PASS
VERDICT: FAIL

If FAIL, list exactly what requirements or architectural pieces were missed for the current subtask.

ORIGINAL TASK:
${originalTask}

OVERALL EXECUTION PLAN:
${state.executionPlan}

CURRENT SUBTASK:
${currentTask}

MODIFIED FILES:
${fileBlocks}${executionContext}${executionErrorContext}`;
  },
});
