import { eventBus } from "#web/eventBus.js";
import { waitForResponse, HUMAN_RESPONSE_TIMEOUT_MS } from "#web/ws/prompts.js";
import { randomUUID } from "node:crypto";
import { isLoopActive } from "#web/loopMode.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function handleScopeReview(scopeDoc) {
  if (isLoopActive()) return { approved: true, feedback: "" };

  const approvalRequestId = randomUUID();
  eventBus.emit("scoping_complete", {
    requestId: approvalRequestId,
    scopeDoc,
  });

  const approvalResponse = await waitForResponse(approvalRequestId, HUMAN_RESPONSE_TIMEOUT_MS);

  if (
    approvalResponse.action === "cancel" ||
    approvalResponse.value === "CANCELLED_BY_SYSTEM"
  ) {
    throw new Error("Aborted (User cancelled scoping)");
  }

  // No human response within the timeout — auto-approve and continue.
  if (approvalResponse.action === "timeout") {
    log(colors.yellow(`  [Scoping] No response to scope review in ${HUMAN_RESPONSE_TIMEOUT_MS / 60000} min — auto-approving and continuing.`));
    return { approved: true, feedback: "" };
  }

  return {
    approved: approvalResponse.type === "scoping_approved",
    feedback: approvalResponse.value || "",
  };
}

export async function promptUserForClarification(message, turn) {
  if (isLoopActive()) return { answer: "", action: "finalize" };

  const questionRequestId = randomUUID();
  eventBus.emit("prompt_scoping_message", {
    requestId: questionRequestId,
    message,
    turn,
  });

  const userResponse = await waitForResponse(questionRequestId, HUMAN_RESPONSE_TIMEOUT_MS);

  if (
    userResponse.action === "cancel" ||
    userResponse.value === "CANCELLED_BY_SYSTEM"
  ) {
    throw new Error("Aborted (User cancelled scoping)");
  }

  // No human response within the timeout — skip remaining questions and finalize.
  if (userResponse.action === "timeout") {
    log(colors.yellow(`  [Scoping] No response to clarifying question in ${HUMAN_RESPONSE_TIMEOUT_MS / 60000} min — auto-finalizing scope.`));
    return { answer: "", action: "finalize" };
  }

  return {
    answer: userResponse.value || "",
    action: userResponse.action || "continue",
  };
}
