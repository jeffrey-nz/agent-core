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
6. FRAMEWORK OVERREACH: Plan introduces TypeScript, React, Vite, or a build toolchain when the user's original request specifies plain .js/.html files or uses CommonJS require(). If the user asked for game.js and test.js with require('./game.js'), the plan must NOT use React/Vite/TypeScript — plain HTML + vanilla JS is the correct deliverable. Fix by replacing the Vite scaffold subtask with direct file creation subtasks for the requested plain files.
7. WRONG ACCEPTANCE TEST METHODOLOGY (Python/Ruby/Go): If the project type is Python, Ruby, or Go, the acceptance test subtask MUST use execute_bash with the language test runner — NEVER http_request and NEVER a server-start command.
   - Python: execute_bash with pytest or manage.py check. NOT "flask run", "uvicorn", or http_request.
   - Ruby: execute_bash with bundle exec rspec or rake test. NOT "rails server" or http_request.
   - Go: execute_bash with go test ./... or go build ./.... NOT "go run" or http_request.
   If the last subtask uses http_request or starts a server for these languages, replace it with the correct execute_bash command.

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

  // Skip for chunked providers (e.g. Copilot) — the plan was either synthesized
  // from the task description (reliable) or produced by the minimal PM prompt.
  // Sending a planValidator turn wastes a Copilot quota slot with no benefit.
  const isChunkedProvider = (state.provider?.maxPromptChars ?? Infinity) <= 9500;
  if (isChunkedProvider) {
    log(colors.dim(`  [Graph] -> Plan Validator: skipping for chunked provider`));
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
        (() => {
          const f = Array.isArray(s.files) ? s.files : (typeof s.files === "string" && s.files ? [s.files] : []);
          return `${i + 1}. [${s.task}]\n   Files: ${f.length > 0 ? f.join(", ") : "(none)"}\n   Note: ${s.implementation_note || s.implementationNote || "(none)"}\n   Criteria: ${s.acceptanceCriteria || "(n/a)"}`;
        })(),
    )
    .join("\n\n");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        state.intentDocument ? `INTENT DOCUMENT:\n${state.intentDocument}` : "(no intent document)",
        `\nSCOPE DOCUMENT (summary):\n${(state.scopeDocument || "(none)").slice(0, 3000)}`,
        state.projectType ? `\nPROJECT TYPE: ${state.projectType}` : "",
        `\nEXECUTION PLAN (${state.subtasks.length} subtasks):\n${planSummary}`,
      ].filter(Boolean).join("\n\n"),
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

  // Normalize each subtask so downstream nodes can rely on the shape:
  //  - `files` must be a string[] — the AI variously emits a single string,
  //    an array of strings, OR an array of objects like {name:"x.py"} /
  //    {path:"x.py"}. path.join/path.isAbsolute throw "path must be a string"
  //    on object elements, which crashes coderNode before the first turn.
  //  - `task` must be a string.
  const toFileStrings = (files) => {
    const arr = typeof files === "string" ? [files] : (Array.isArray(files) ? files : []);
    return arr
      .map((f) => {
        if (typeof f === "string") return f;
        if (f && typeof f === "object") return f.path || f.file || f.filename || f.name || "";
        return "";
      })
      .filter((f) => typeof f === "string" && f.length > 0);
  };
  revisedSubtasks = revisedSubtasks.map((s, i) => ({
    ...s,
    task: typeof s.task === "string" ? s.task : String(s.task ?? ""),
    files: toFileStrings(s.files),
    id: s.id ?? i + 1,
  }));

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
