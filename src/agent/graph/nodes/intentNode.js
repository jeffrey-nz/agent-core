/**
 * intentNode.js
 *
 * Runs immediately after the orchestrator, before the researcher.
 *
 * Purpose: analyse the user's raw task and produce a structured INTENT DOCUMENT
 * that gives every downstream node (researcher, PM, reviewers) a shared "north
 * star" — the exact outcome the user wants, what success looks like, what is
 * explicitly out of scope, and the technical constraints the solution must
 * respect.
 *
 * Without this node the researcher has to infer intent from a single raw
 * sentence; the PM has to guess what "done" means; reviewers have no objective
 * criterion to evaluate against. The intent document makes all of that explicit
 * upfront so every node can make better decisions throughout the pipeline.
 *
 * This node uses generateText only (no tools — it works entirely from the
 * user's message). It is fast (~1s) and low-cost.
 */

import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("intent");

const SYSTEM_PROMPT = `You are an expert requirements analyst. Your job is to read a software task description and extract a precise, structured INTENT DOCUMENT.

The intent document will be used by:
- A researcher to focus codebase exploration
- A project manager to create subtasks that actually satisfy the goal
- A coder to understand what "done" really means
- Reviewers to verify the solution against objective criteria

Output a JSON object with exactly these fields:

{
  "goal": "One precise sentence describing the end-state outcome — what will be true when the task is complete",
  "success_criteria": [
    "Specific, measurable criterion that can be verified with code/tools (not 'it works')",
    ...
  ],
  "out_of_scope": [
    "Something that MUST NOT be changed or broken by this task",
    ...
  ],
  "key_constraints": [
    "Technical constraint the solution must respect (framework conventions, APIs, patterns already in use)",
    ...
  ],
  "verification_approach": "How success can be confirmed without human interaction — e.g. 'http_request returns HTTP 200 with markup containing X'",
  "risk_areas": [
    "Area of high uncertainty or common failure point that deserves extra research attention",
    ...
  ]
}

Rules:
- Be concrete and specific — avoid vague words like "properly" or "correctly"
- success_criteria must be verifiable by code (http_request, grep, read_file, execute_bash)
- out_of_scope should name specific files, features, or behaviours that must not change
- risk_areas should name specific technical areas likely to cause problems (e.g. "SilverStripe manifest cache must be cleared after YAML changes")
- Output ONLY the JSON object — no preamble, no explanation`;

export async function intentNode(state, config) {
  const userTask = state.messages.find((m) => m.role === "user")?.content || "";

  if (!userTask.trim()) {
    log(colors.dim("  [Graph] -> Intent: no user task found — skipping"));
    return {};
  }

  log(colors.cyan("  [Graph] -> Running Intent Analyst..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: "Analysing user intent — defining goal, success criteria, constraints",
  });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Defining intent..." });

  const signal = config?.signal ?? null;
  let raw = "";

  try {
    if (state.model) {
      const { text } = await generateText({
        model: state.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `TASK:\n${userTask}` },
        ],
        maxTokens: 1000,
        abortSignal: signal,
      });
      raw = text;
    } else if (state.provider) {
      const result = await state.provider.sendTurn(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `TASK:\n${userTask}` },
        ],
        "intent",
        { rootDir: state.projectDir, interactionMode: "scoping", signal },
      );
      raw = result?.text ?? "";
    }
  } catch (err) {
    log(colors.yellow(`  [Graph] -> Intent: failed (${err.message?.slice(0, 80)}) — continuing without intent document`));
    return {};
  }

  if (!raw?.trim()) {
    log(colors.dim("  [Graph] -> Intent: empty response — continuing without intent document"));
    return {};
  }

  // Extract JSON if wrapped in prose
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  let intentDocument = raw.trim();
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      // Format as readable text block for injection into downstream prompts
      intentDocument = formatIntentDocument(parsed);
      log(colors.cyan(`  [Graph] -> Intent document created. Goal: ${parsed.goal?.slice(0, 80)}`));
    } catch {
      // Keep raw text if JSON parse fails
      log(colors.dim("  [Graph] -> Intent: could not parse JSON — using raw text"));
    }
  }

  eventBus.emit("system_message", {
    text: `◎ Intent defined: ${intentDocument.split("\n")[0]?.slice(0, 80)}`,
    type: "info",
  });

  return {
    intentDocument,
    currentPersona: PERSONA.id,
  };
}

/**
 * Formats the parsed intent JSON into a human-readable block suitable for
 * injection into system prompts. Each downstream node injects this block into
 * its context so AI personas understand the exact goal before they begin work.
 */
function formatIntentDocument(parsed) {
  const lines = [];
  if (parsed.goal) {
    lines.push(`GOAL: ${parsed.goal}`);
  }
  if (parsed.success_criteria?.length) {
    lines.push(`\nSUCCESS CRITERIA (all must be true for the task to be complete):`);
    parsed.success_criteria.forEach((c) => lines.push(`  ✓ ${c}`));
  }
  if (parsed.out_of_scope?.length) {
    lines.push(`\nOUT OF SCOPE (must not change):`);
    parsed.out_of_scope.forEach((o) => lines.push(`  ✗ ${o}`));
  }
  if (parsed.key_constraints?.length) {
    lines.push(`\nKEY CONSTRAINTS:`);
    parsed.key_constraints.forEach((k) => lines.push(`  • ${k}`));
  }
  if (parsed.verification_approach) {
    lines.push(`\nVERIFICATION: ${parsed.verification_approach}`);
  }
  if (parsed.risk_areas?.length) {
    lines.push(`\nRISK AREAS (investigate these carefully):`);
    parsed.risk_areas.forEach((r) => lines.push(`  ⚠ ${r}`));
  }
  return lines.join("\n");
}
