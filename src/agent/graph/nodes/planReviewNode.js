/**
 * planReviewNode — Adaptive Plan Revision
 *
 * Runs after each verified subtask PASS (via nextSubtask → planReviewer → coder).
 * Uses a fast generateText call to check whether the remaining subtasks are still
 * accurate given what was actually done.  If the plan has drifted — e.g. an earlier
 * subtask found different file locations than expected — this node revises the
 * remaining items before the coder starts on them.
 *
 * Skipped when:
 *   - No model is available (automation-api path) — avoids latency
 *   - No remaining subtasks exist (already on the last one)
 */

import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("planReviewer");

export async function planReviewNode(state) {
  if (!state.model) return {};

  const nextIdx = state.currentSubtaskIndex ?? 0; // already advanced by nextSubtaskNode
  const remaining = (state.subtasks || []).slice(nextIdx);
  if (remaining.length === 0) return {};

  const completedTask = state.subtasks[nextIdx - 1]?.task || "";
  if (!completedTask) return {};

  log(colors.dim(`  [PlanReview] Checking plan after: ${completedTask.slice(0, 60)}`));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: `Reviewing ${remaining.length} remaining subtask${remaining.length !== 1 ? "s" : ""}`,
  });

  const modifiedSummary = (state.modifiedFiles || []).slice(-8).join(", ") || "none";

  // Build a short goal line from intent document or raw task for reviewer context.
  const goalLine = (() => {
    if (state.intentDocument) {
      const m = state.intentDocument.match(/^GOAL:\s*(.+)/m);
      if (m) return m[1].trim();
    }
    const userTask = state.messages?.find((m) => m.role === "user")?.content || "";
    return userTask.slice(0, 120);
  })();

  let text = "";
  try {
    const result = await generateText({
      model: state.model,
      prompt: `You are a software plan reviewer. A subtask just completed successfully.

Overall goal: ${goalLine || "(unknown)"}

Completed subtask:
${completedTask}

Files modified: ${modifiedSummary}

Remaining subtasks:
${remaining.map((s, i) => `${i + 1}. ${s.task}`).join("\n")}

Are the remaining subtasks still accurate and in the right order given what was just done?
IMPORTANT: Do not remove subtasks that are still needed to achieve the overall goal.

If YES (plan is still valid): respond with exactly: PLAN_OK
If NO (plan needs updating): respond with PLAN_REVISED on the first line, then list the corrected remaining subtasks as numbered items (same format, same count or fewer). Be minimal — only change what actually needs changing.`,
      maxTokens: 500,
    });
    text = result.text || "";
  } catch (err) {
    log(colors.dim(`  [PlanReview] Skipped (error: ${err?.message?.slice(0, 60)})`));
    return {};
  }

  if (/PLAN_OK/i.test(text)) {
    log(colors.dim("  [PlanReview] Plan is still valid — no changes."));
    return {};
  }

  if (!/PLAN_REVISED/i.test(text)) {
    // Unexpected response — leave plan unchanged rather than corrupting it.
    log(colors.dim("  [PlanReview] Unexpected response — leaving plan unchanged."));
    return {};
  }

  // Parse revised subtasks from numbered list
  const lines = text.split("\n").filter((l) => /^\s*\d+\.\s+\S/.test(l));
  if (lines.length === 0) {
    log(colors.dim("  [PlanReview] PLAN_REVISED but no numbered items found — leaving plan unchanged."));
    return {};
  }

  const revisedTasks = lines.map((l, i) => ({
    // Preserve files, implementationNote, etc. from the matching original subtask
    ...(remaining[i] || {}),
    task: l.replace(/^\s*\d+\.\s*/, "").trim(),
  }));

  const newSubtasks = [...(state.subtasks || []).slice(0, nextIdx), ...revisedTasks];

  const revision = {
    subtaskIndex: nextIdx - 1,
    oldRemaining: remaining.map((s) => s.task),
    newRemaining: revisedTasks.map((s) => s.task),
    reason: text.split("\n").slice(0, 2).join(" ").slice(0, 120),
    t: Date.now(),
  };

  log(colors.yellow(`  [PlanReview] Plan revised: ${remaining.length} → ${revisedTasks.length} remaining subtasks`));
  eventBus.emit("system_message", {
    text: `↻ Plan revised — ${revisedTasks.length} subtask${revisedTasks.length !== 1 ? "s" : ""} remaining`,
    type: "info",
  });
  eventBus.emit("plan_revision", { revision });
  eventBus.emit("plan_update", {
    steps: newSubtasks.map((s, i) => ({
      id: s.id ?? i,
      label: s.task,
      state: i < nextIdx ? "completed" : "pending",
    })),
  });

  // Reset criticCompleted so the adversarial critic re-evaluates the revised plan.
  // Reset planValidated so the plan validator re-checks the new subtasks before
  // the next coder turn — without this the validator only ever sees the original plan.
  return {
    subtasks: newSubtasks,
    planRevisions: [revision],
    criticCompleted: false,
    criticReport: "",
    planValidated: false,
  };
}
