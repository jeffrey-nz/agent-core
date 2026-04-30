/**
 * planValidatorNode.js
 *
 * Runs after the Project Manager and before the first coder turn.
 *
 * Purpose: validate the PM's execution plan against the intent document and
 * the scope document BEFORE any coding begins. Common plan failures caught here:
 *
 *   1. Invented file paths — paths not confirmed in the scope document
 *   2. Acceptance tests that require human CMS interaction (unverifiable)
 *   3. Missing coverage of success criteria from the intent document
 *   4. Subtasks in wrong order (e.g. acceptance test not last)
 *   5. Implementation notes too vague to implement without opening files
 *
 * If the plan is already sound: returns PLAN_VALID and does not modify state.
 * If issues are found: produces a corrected subtask list and injects it into
 * state so the coder works from an improved plan from the start.
 *
 * Only runs on the first pass (planValidated flag prevents re-running on
 * subtask advances — planReviewNode handles those).
 *
 * Uses generateText only (no tools).
 */

import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";
import { updateCheckpointState } from "../checkpointBridge.js";

const PERSONA = personaMeta("planValidator");

const SYSTEM_PROMPT = `You are a plan quality reviewer for an AI software pipeline. You validate execution plans before a coder starts implementing.

Review the plan against the intent document and scope document. Check for:

1. INVENTED PATHS: File paths in subtasks that don't appear in the scope document (high risk — coder will waste all retries on phantom files)
2. HUMAN-REQUIRED ACCEPTANCE TESTS: Tests that need CMS UI interaction, clicking buttons, or creating pages manually (the coder has no browser — these are unwinnable)
3. MISSING COVERAGE: Success criteria from the intent that have no corresponding implementation subtask
4. WRONG ORDER: Acceptance test subtask is not last; db:build/sake commands before all file writes; wrong dependency order
5. VAGUE NOTES: implementation_note fields that say "modify as needed" or similar — must be specific enough to implement without reading any file

If the plan is acceptable (≤1 minor issues): respond with exactly the text: PLAN_VALID

If there are significant issues, respond with: PLAN_REVISED
Then provide the complete corrected subtasks as a JSON array immediately after — same format as the original, with issues fixed.

IMPORTANT: Only fix real problems. Do not add subtasks, do not remove tasks that are correct, do not change approaches just because you have a preference. Be conservative.`;

export async function planValidatorNode(state, config) {
  // Only run on the first planning pass; subtask advances use planReviewNode instead
  if (state.planValidated) {
    return {};
  }

  if (!state.subtasks?.length) {
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  // If we have neither a model nor provider, skip gracefully
  if (!state.model && !state.provider) {
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  log(colors.cyan("  [Graph] -> Running Plan Validator..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: "Validating execution plan against intent and scope before coding begins",
  });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Validating plan..." });

  const signal = config?.signal ?? null;

  const planSummary = state.subtasks
    .map(
      (s, i) =>
        `${i + 1}. [${s.task}]\n   Files: ${s.files?.join(", ") || "(none)"}\n   Note: ${s.implementation_note || s.implementationNote || "(none)"}\n   Criteria: ${s.acceptanceCriteria || "(n/a)"}`,
    )
    .join("\n\n");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        state.intentDocument ? `INTENT DOCUMENT:\n${state.intentDocument}` : "(no intent document)",
        `\nSCOPE DOCUMENT (summary):\n${(state.scopeDocument || "(none)").slice(0, 3000)}`,
        `\nEXECUTION PLAN (${state.subtasks.length} subtasks):\n${planSummary}`,
      ].join("\n\n"),
    },
  ];

  let raw = "";
  try {
    if (state.model) {
      const { text } = await generateText({
        model: state.model,
        messages,
        maxTokens: 1200,
        abortSignal: signal,
      });
      raw = text;
    } else {
      const result = await state.provider.sendTurn(messages, "planValidator", {
        rootDir: state.projectDir,
        interactionMode: "scoping",
        signal,
      });
      raw = result?.text ?? "";
    }
  } catch (err) {
    log(colors.yellow(`  [Graph] -> Plan Validator: failed (${err.message?.slice(0, 80)}) — proceeding with original plan`));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  // Accept both literal token and semantic equivalents — automation API providers
  // (e.g. Copilot365) wrap the response in prose that doesn't include the exact token.
  const semanticallyValid =
    /\bplan\b.{0,60}\bvalid\b|\bno\s+(significant\s+)?issues?\b|\blooks?\s+good\b|\bacceptable\b|\bsound\b/i.test(raw) &&
    !/PLAN_REVISED|\bissues?\s+found\b|\binvalid\b|\bproblems?\s+found\b/i.test(raw);

  if (!raw?.trim() || raw.includes("PLAN_VALID") || semanticallyValid) {
    log(colors.dim(`  [Graph] -> Plan Validator: plan is valid (${state.subtasks.length} subtasks confirmed)`));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  if (!raw.includes("PLAN_REVISED")) {
    log(colors.dim("  [Graph] -> Plan Validator: unexpected response — proceeding with original plan"));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  // Parse corrected subtasks
  const afterRevised = raw.slice(raw.indexOf("PLAN_REVISED") + "PLAN_REVISED".length);
  const firstBracket = afterRevised.indexOf("[");
  const lastBracket = afterRevised.lastIndexOf("]");

  if (firstBracket === -1 || lastBracket <= firstBracket) {
    log(colors.yellow("  [Graph] -> Plan Validator: PLAN_REVISED but no JSON array found — keeping original plan"));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  let revisedSubtasks;
  try {
    revisedSubtasks = JSON.parse(afterRevised.slice(firstBracket, lastBracket + 1));
  } catch (e) {
    log(colors.yellow(`  [Graph] -> Plan Validator: JSON parse failed (${e.message}) — keeping original plan`));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  if (!Array.isArray(revisedSubtasks) || revisedSubtasks.length === 0) {
    log(colors.yellow("  [Graph] -> Plan Validator: empty revised subtask list — keeping original plan"));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  // Sanity check: don't accept a revised plan with far fewer subtasks (likely truncated)
  if (revisedSubtasks.length < Math.ceil(state.subtasks.length * 0.6)) {
    log(colors.yellow(
      `  [Graph] -> Plan Validator: revised plan has ${revisedSubtasks.length} subtasks vs original ${state.subtasks.length} — too many removed, keeping original`,
    ));
    return { planValidated: true, currentPersona: PERSONA.id };
  }

  log(colors.cyan(
    `  [Graph] -> Plan Validator: plan revised (${state.subtasks.length} → ${revisedSubtasks.length} subtasks)`,
  ));
  eventBus.emit("system_message", {
    text: `⊘ Plan validated and revised: ${revisedSubtasks.length} subtasks`,
    type: "info",
  });

  // Persist revised plan to checkpoint so self-heal resume uses the corrected plan
  updateCheckpointState({ subtasks: revisedSubtasks });

  return {
    subtasks: revisedSubtasks,
    planValidated: true,
    currentPersona: PERSONA.id,
  };
}
