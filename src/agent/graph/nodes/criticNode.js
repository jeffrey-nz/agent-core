/**
 * criticNode.js  — Adversarial Plan Critic
 *
 * Runs after the plan validator and before the first coder turn.
 *
 * Purpose: adversarially challenge the execution plan using a "red team"
 * perspective before a single line of code is written. Identifies:
 *
 *   1. Hidden assumptions that will likely fail in practice
 *   2. Missing steps the plan doesn't account for
 *   3. Execution order issues that will cause dependency errors
 *   4. Technical risks that should trigger extra caution
 *   5. Success criteria gaps — things the plan doesn't verify
 *
 * This mirrors the adversarial self-review pattern used in:
 *   - Constitutional AI (Anthropic) — critique then revise
 *   - Tree of Thoughts (Yao et al. 2023) — explore and prune bad paths
 *   - Reflexion (Shinn et al. 2023) — verbal reinforcement before acting
 *   - AutoGen / CrewAI critic agents — dedicated challenger role
 *
 * The CRITIC REPORT is stored in state and injected into the coder's system
 * prompt for the FIRST turn of every subtask, so implementation happens with
 * full awareness of the identified risks.
 *
 * Only runs once per planning pass (criticCompleted flag). Skipped on subtask
 * advances, retries, and debugger re-entries — those have their own context.
 */

import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("critic");

const SYSTEM_PROMPT = `You are an adversarial engineering critic. Your job is to red-team a software execution plan and identify what is most likely to fail before implementation begins.

This is NOT a destructive review — you are helping the implementation succeed by surfacing hidden risks.

You will receive:
- A user intent document (goal, success criteria, constraints)
- A refined research summary
- A scope document
- An execution plan with subtasks

Your job: identify SPECIFIC, ACTIONABLE risks. Not generic advice.

Output a CRITIC REPORT with these sections:

## HIDDEN ASSUMPTIONS (things the plan assumes but hasn't verified)
- <Assumption: what the plan takes for granted, and what could invalidate it>
- ...

## LIKELY FAILURE POINTS (specific subtasks most likely to loop or fail)
- <Subtask N: why it will fail and what to watch for>
- ...

## MISSING STEPS (work the plan doesn't account for)
- <Missing: what needs to happen that isn't in the plan>
- ...

## TECHNICAL HAZARDS (specific technical risks requiring extra caution)
- <Hazard: concrete risk with mitigation>
- ...

## SUCCESS CRITERIA GAPS (intent criteria not covered by acceptance test)
- <Gap: criterion from intent that no subtask verifies>
- ...

Specific patterns to always check for:
- Template dual-rendering: if any subtask adds a conditional rendering block to a template, check whether the plan also explicitly DELETES the existing unconditional rendering line. If not, flag it: "Subtask N adds the new block but does not remove the old $Content line — both will render simultaneously."
- Acceptance test semantic weakness: if the acceptance test only checks HTTP 200 or "no errors", flag it: "Acceptance test verifies rendering is error-free but does NOT verify the feature-specific markup is present. Add a grep/search for the specific HTML class or element."
- Acceptance test URL format: if the plan mentions a local dev URL, check it uses the correct format (not http://localhost if the site runs on a named vhost).
- Game logic test coverage: if building any game (board game, card game, puzzle), check that the acceptance test covers ALL of: (a) every piece/unit type's legal AND illegal moves, (b) win/loss end conditions, (c) domain-specific edge cases (pawn promotion and en-passant for chess; multi-jump for checkers; etc.), (d) UI state machine transitions (select a piece → re-select a different piece → deselect → make invalid move → make valid move → turn switches). A test suite that only checks "pawn moves forward one square" while omitting promotion, capture, and turn-enforcement is a coverage gap that WILL produce a buggy game. Flag: "Acceptance test does not cover [specific missing case] — add a test for it."
- Python/Ruby/Go acceptance test methodology: if the plan includes an acceptance test for a Python, Ruby, or Go project that uses http_request OR starts a server (flask run, uvicorn, gunicorn, python manage.py runserver, rails server, bundle exec rails s, go run), flag it as: "Acceptance test for [language] project uses http_request or starts a server — these BLOCK forever and will time out. Replace with the correct test runner: Python→pytest, Ruby→bundle exec rspec, Go→go test ./...".

Rules:
- Be specific: name exact subtask IDs, file paths, class names
- Prioritise — put the most dangerous risks first
- If you cannot find any real risks, say "CRITIC: No significant risks identified" and stop
- Maximum 500 words
- Do NOT suggest wholesale re-planning — only flag specific risks`;

export async function criticNode(state, config) {
  // Only run once per planning pass
  if (state.criticCompleted) {
    return {};
  }

  if (!state.subtasks?.length) {
    return { criticCompleted: true, currentPersona: PERSONA.id };
  }

  if (!state.model && !state.provider) {
    return { criticCompleted: true, currentPersona: PERSONA.id };
  }

  // Skip for chunked providers — saves a Copilot quota call with minimal benefit.
  const isChunkedProvider = (state.provider?.maxPromptChars ?? Infinity) <= 9500;
  if (isChunkedProvider) {
    log(colors.dim(`  [Graph] -> Adversarial Critic: skipping for chunked provider`));
    return { criticCompleted: true, currentPersona: PERSONA.id };
  }

  log(colors.cyan("  [Graph] -> Running Adversarial Critic..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: "Red-teaming the execution plan to surface hidden risks before coding",
  });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Critiquing plan..." });
  eventBus.emit("session_role_update", {
    role: "primary", status: "active",
    provider: state.provider?.providerName || "unknown",
    task: "critique",
  });

  const signal = config?.signal ?? null;

  const planText = state.subtasks
    .map(
      (s, i) =>
        `Subtask ${i + 1}: [${s.task}]\n  Files: ${s.files?.join(", ") || "(none)"}\n  Note: ${s.implementation_note || s.implementationNote || "(none)"}`,
    )
    .join("\n\n");

  const inputContent = [
    state.intentDocument ? `INTENT:\n${state.intentDocument}\n` : "",
    state.refinedResearch ? `REFINED RESEARCH:\n${state.refinedResearch.slice(0, 2000)}\n` : "",
    state.scopeDocument ? `SCOPE (summary):\n${state.scopeDocument.slice(0, 1500)}\n` : "",
    state.reflexionContext
      ? `[LESSONS FROM PRIOR SESSIONS ON THIS PROJECT — use these to spot recurring failure patterns in the plan below]\n${state.reflexionContext}\n`
      : "",
    `EXECUTION PLAN (${state.subtasks.length} subtasks):\n${planText}`,
  ]
    .filter(Boolean)
    .join("\n");

  let raw = "";
  try {
    if (state.model) {
      const { text } = await generateText({
        model: state.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: inputContent },
        ],
        maxTokens: 900,
        abortSignal: signal,
      });
      raw = text;
    } else {
      const result = await state.provider.sendTurn(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: inputContent },
        ],
        "critic",
        { rootDir: state.projectDir, interactionMode: "scoping", signal },
      );
      raw = result?.text ?? "";
    }
  } catch (err) {
    log(colors.yellow(`  [Graph] -> Critic: failed (${err.message?.slice(0, 80)}) — proceeding without critique`));
    return { criticCompleted: true, currentPersona: PERSONA.id };
  }

  if (!raw?.trim() || /no significant risks|no real risks|no major risks|plan looks sound|CRITIC: No/i.test(raw)) {
    log(colors.dim("  [Graph] -> Critic: no significant risks identified — plan looks sound"));
    return { criticCompleted: true, currentPersona: PERSONA.id };
  }

  // Count bullet-pointed or numbered risk items — support -, •, *, and numbered lists.
  const riskCount = (raw.match(/^[-•*]|^\d+\./gm) || []).length;
  log(colors.yellow(`  [Graph] -> Critic: ${riskCount} risks identified`));
  eventBus.emit("system_message", {
    text: `⚡ Critic review: ${riskCount} risk${riskCount !== 1 ? "s" : ""} flagged for coder awareness`,
    type: "warning",
  });

  return {
    criticReport: raw,
    criticCompleted: true,
    currentPersona: PERSONA.id,
  };
}
