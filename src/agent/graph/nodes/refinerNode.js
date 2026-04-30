/**
 * refinerNode.js  — Research Refiner / Context Condenser
 *
 * Runs after the researcher and before the scoper/PM/routing decision.
 *
 * Problem: the researcher runs up to 24 tool steps and can produce a large,
 * noisy report. The scoper and PM receive this in full, but the important
 * signal gets diluted by tangential findings, intermediate tool outputs, and
 * exploratory dead-ends. This causes the scoper to re-explore already-known
 * paths and the PM to generate subtasks based on incomplete understanding.
 *
 * Solution: a fast generateText pass that reads the raw research output and
 * distils it into a focused REFINED RESEARCH block — the 10-15 most critical
 * facts, specifically formatted for implementation planning. This mirrors the
 * "chain-of-density" / context-compression pattern used by modern RAG systems
 * (Adams et al. 2023) and the pre-planning distillation pass in agent systems
 * like AutoGen and CrewAI.
 *
 * Output is stored in `state.refinedResearch` and injected into:
 *   - scoperNode (focus exploration on what matters)
 *   - projectManagerNode (ensure plan addresses the key findings)
 *
 * Skipped for documentation and investigation tasks (no implementation needed).
 */

import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("refiner");

const SYSTEM_PROMPT = `You are a research synthesis expert. You condense a raw AI codebase research report into a focused, implementation-ready summary.

Your output will be used by:
- A Scoper agent to find exact file/line locations
- A Project Manager to break work into concrete subtasks
- A Coder to implement the changes

Output a REFINED RESEARCH block with these sections:

## CRITICAL FACTS (top 10-15 implementation-relevant findings)
- <Verified fact with exact path/class/line where relevant>
- ...

## IMPLEMENTATION GAPS (components confirmed missing or needing creation)
- <Gap: what needs to be added/changed, where>
- ...

## CONFIRMED EXISTING (components already present that must NOT be re-created)
- <Component: file/class/config that already handles this requirement>
- ...

## RISK FACTORS (technical areas most likely to cause implementation failures)
- <Risk: specific technical hazard with mitigation hint>
- ...

## VERIFICATION COMMANDS (commands that will confirm the implementation worked)
- <Command: what to run and what output confirms success>
- ...

Rules:
- Include ONLY facts backed by the research (no speculation)
- Every file path must have been found/read in the research — no invented paths
- Omit exploratory dead-ends and failed tool calls
- Be concrete: class names, method signatures, YAML keys, exact error messages
- If the research found something critical missing, make it prominent
- Maximum 600 words total`;

export async function refinerNode(state, config) {
  // Refiner only applies to implementation tasks
  if (state.taskType === "documentation" || state.taskType === "investigation") {
    return {};
  }

  const researchContext = state.researchContext || "";
  if (researchContext.trim().length < 200) {
    log(colors.dim("  [Graph] -> Refiner: research too short to condense — skipping"));
    return {};
  }

  if (!state.model && !state.provider) return {};

  log(colors.cyan("  [Graph] -> Running Research Refiner..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: "Condensing research into focused implementation-ready findings",
  });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Refining research..." });

  const signal = config?.signal ?? null;
  const userTask = state.messages.find((m) => m.role === "user")?.content || "";

  const inputContent = [
    `TASK: ${userTask.slice(0, 300)}`,
    state.intentDocument ? `\nINTENT:\n${state.intentDocument}` : "",
    `\nRAW RESEARCH REPORT:\n${researchContext.slice(0, 12000)}`,
  ].join("\n");

  let raw = "";
  try {
    if (state.model) {
      const { text } = await generateText({
        model: state.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: inputContent },
        ],
        maxTokens: 1200,
        abortSignal: signal,
      });
      raw = text;
    } else {
      const result = await state.provider.sendTurn(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: inputContent },
        ],
        "refiner",
        { rootDir: state.projectDir, interactionMode: "scoping", signal },
      );
      raw = result?.text ?? "";
    }
  } catch (err) {
    log(colors.yellow(`  [Graph] -> Refiner: failed (${err.message?.slice(0, 80)}) — using raw research`));
    return {};
  }

  // Threshold: 400 chars is roughly 3-4 bullet points — anything less is a
  // failed or near-empty response that would leave PM/coder with no context.
  if (!raw?.trim() || raw.trim().length < 400) {
    log(colors.dim(`  [Graph] -> Refiner: response too short (${raw?.trim().length ?? 0} chars) — proceeding with raw research`));
    return {};
  }

  log(colors.dim(`  [Graph] -> Refiner: condensed research to ${raw.length} chars`));
  eventBus.emit("system_message", {
    text: `◈ Research condensed — ${raw.split("\n").filter((l) => l.trim().startsWith("-")).length} key findings extracted`,
    type: "info",
  });

  return {
    refinedResearch: raw,
    currentPersona: PERSONA.id,
  };
}
