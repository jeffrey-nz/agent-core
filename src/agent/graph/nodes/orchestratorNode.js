/**
 * orchestratorNode.js
 *
 * The first node in every pipeline. Analyzes the incoming task and decides:
 *   1. What TYPE of task this is
 *   2. Which pipeline is appropriate
 *
 * TASK TYPES and their pipelines:
 *
 *   documentation - create or update documentation files (markdown, txt, etc.)
 *     Pipeline: researcher → directWriter → verifier → END
 *     Why: No deep code analysis needed. The researcher generates content;
 *          the directWriter saves it. Scoper/projectManager add nothing but overhead.
 *
 *   investigation - analyze and report only; no file changes expected
 *     Pipeline: researcher → reviews → END
 *     Why: The deliverable is a report, not code. Reviews still run to
 *          confirm the task is complete and nothing was accidentally changed.
 *
 *   quick_edit - simple, targeted change where scope is obvious from the task
 *     Pipeline: researcher → projectManager → coder → verifier → reviews
 *     Why: Scoper is expensive and adds little when the file + change is clear
 *          from a bug report or single-line fix request.
 *
 *   code_change - complex multi-file change requiring deep analysis (default)
 *     Pipeline: researcher → scoper → projectManager → coder → verifier → reviews
 *     Why: Full pipeline produces verified, grounded scope before implementation.
 *
 * Classification uses an AI call (no tools) so it's fast (< 5s). The rationale
 * is stored in state for debugging.
 */

import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("orchestrator");

const CLASSIFICATION_PROMPT = `You are a task router for an AI coding assistant.

Classify the user's task into EXACTLY ONE of these types:

documentation
  The task is to CREATE or UPDATE a documentation file (markdown, txt, README, etc.)
  The output is purely informational - no code, templates, or config changes.
  Examples:
    - "Create a markdown file documenting all known issues before launch"
    - "Add a CHANGELOG entry"
    - "Write a README for this module"

investigation
  The task is to ANALYSE and REPORT only - the user wants findings, not file changes.
  No files should be created or modified as part of completing this task.
  Examples:
    - "Tell me why the OrderService is slow"
    - "Investigate why events are not showing in the news feed"
    - "What is the architecture of this module?"

quick_edit
  A simple, TARGETED change where the scope is clear from the task description.
  Typically: fix a specific named bug/error, change a value, rename something,
  add a small feature to one file. The researcher will find the exact location;
  deep scoping is not needed.
  Examples:
    - "Fix the 500 error on the /events page"
    - "The blog RSS feed is broken - fix it"
    - "Change the page title from 'Home' to 'Welcome'"
  Anti-examples (use code_change instead):
    - "Fix all the authentication bugs" — vague scope, multiple unknown files
    - "Fix the performance issues in the app" — no specific location
    - "Fix the N+1 queries throughout the codebase" — systemic, multi-file
  When the location or number of affected files is unclear, default to code_change.

new_project
  Build a BRAND NEW application, game, tool, or component from scratch in an empty or scaffolded workspace.
  No existing codebase to analyse — the user wants a complete working product created from nothing.
  Examples:
    - "Build a chess game in React"
    - "Create a todo app with TypeScript and Vite"
    - "Make a calculator web app"
    - "Build a weather dashboard using React"
    - "Create a Snake game in vanilla JS"
  Anti-examples (use code_change instead):
    - "Add a dark mode to the existing app" — modifying existing code
    - "Build a new settings page for the dashboard" — extending an existing project

code_change
  A COMPLEX change requiring deep codebase analysis across multiple files.
  New features, refactors, integration work, multi-step logic changes.
  Examples:
    - "Add a membership tier system with billing integration"
    - "Refactor the authentication module to use OAuth2"
    - "Implement a custom search page with faceted filters"

OUTPUT FORMAT - respond with ONLY valid JSON, no prose, no markdown:
{
  "taskType": "documentation" | "investigation" | "quick_edit" | "new_project" | "code_change",
  "rationale": "one sentence explaining the classification"
}`;

/**
 * Keyword-based classification fallback.
 * Used when the AI returns an empty or unparseable response.
 * Returns null if no confident classification can be made.
 */
function classifyByKeywords(taskText) {
  const lower = taskText.toLowerCase();

  // Documentation: explicit request to create/write a doc-format file
  if (
    /\b(create|write|add|make|generate|produce|draft)\b.{0,80}\b(markdown|\.md\b|readme|documentation file|doc file|changelog|\.txt\b|\.rst\b)\b/i.test(taskText) ||
    /\b(single|new)\s+(markdown|md)\s+(file|document)\b/i.test(taskText) ||
    /\bmarkdown\s+(document|file)\b.{0,60}\b(record|list|document|describe)\b/i.test(lower)
  ) {
    return { taskType: "documentation", rationale: "Keyword match: explicit request to create a documentation file" };
  }

  // Investigation: analysis-only, no changes expected
  if (
    /\b(investigate|why (is|are|does|did)|analyze|analyse|what is the (architecture|structure|reason)|tell me (why|how|about)|explain (why|how)|describe)\b/i.test(taskText) &&
    !/\bfix\b|\bimplement\b|\bcreate\b|\badd\b|\bchange\b/i.test(taskText)
  ) {
    return { taskType: "investigation", rationale: "Keyword match: analysis-only task with no expected file changes" };
  }

  // New project: build a brand-new app/game/tool from scratch.
  if (
    /\b(build|create|make|develop|implement|scaffold|generate)\b.{0,60}\b(app|application|game|tool|project|dashboard|website|site|calculator|chess|todo|weather|snake|tetris|widget)\b/i.test(taskText) &&
    !/\b(existing|current|already|add to|extend|update|fix|change)\b/i.test(taskText)
  ) {
    return { taskType: "new_project", rationale: "Keyword match: building a new application from scratch" };
  }

  // Quick edit: fix a specific named error/bug/value in one place.
  // Require no scope-expanding language ("all", "throughout", etc.) that implies many files.
  // Also exclude tasks that ask to FIND/LOOK FOR issues — those require full research, not a quick patch.
  const hasWideScope = /\b(all|every|throughout|across|entire|whole|multiple|various|several|general|codebase|find|look for|search for|identify|discover|audit)\b/i.test(taskText);
  if (
    (
      /\b(fix|repair|correct|resolve)\b.{0,60}\b(error|bug|issue|crash|exception|500|404|broken)\b/i.test(taskText) &&
      !hasWideScope
    ) ||
    (
      /\b(change|rename|update)\b.{0,40}\b(from|to)\b.{0,40}\b["'`]/i.test(taskText) &&
      !hasWideScope
    ) ||
    (
      /\b(fix|repair|correct|resolve)\b.{0,80}\b(typescript|ts)\b.{0,80}\b(error|compilation|type|syntax)/i.test(taskText) &&
      !hasWideScope
    ) ||
    (
      /\b(syntax|corruption|corrupt)\b.{0,60}\b(error|issue|fix)\b/i.test(taskText) &&
      !hasWideScope
    ) ||
    (
      /\bnpm run build\b.{0,60}\b(fail|error|fix)/i.test(taskText) &&
      !hasWideScope
    )
  ) {
    return { taskType: "quick_edit", rationale: "Keyword match: targeted fix of a specific named error or value" };
  }

  return null;
}

export async function orchestratorNode(state, config) {
  log(colors.cyan("  [Graph] -> 🎯 Orchestrator: classifying task and selecting pipeline..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Selecting the right agents for this task" });
  eventBus.emit("phase_change", { phase: "ORCHESTRATING", label: "Selecting pipeline..." });

  // Honour pre-set task types from the runner (e.g. direct_fix benchmark tasks).
  // Skip classification entirely — the caller already knows what pipeline to use.
  if (state.taskType === "direct_fix") {
    log(colors.dim("  [Graph] -> 🎯 Pre-set taskType=direct_fix — skipping classification"));
    const directFixPersonas = ["orchestrator", "projectManager", "coder", "verifier", "debugger", "securityReviewer", "requirementsReviewer"];
    eventBus.emit("pipeline_selected", {
      taskType: "direct_fix",
      pipelineLabel: "Direct Fix",
      pipelineSteps: "projectManager → coder → verifier → reviews",
      personas: directFixPersonas,
      rationale: "Pre-set by caller — targeted fix with full file+change description, no research needed",
    });
    return { taskType: "direct_fix", currentPersona: PERSONA.id };
  }

  const userTask = state.messages.find((m) => m.role === "user")?.content || "";

  let taskType = "code_change";
  let rationale = "Default pipeline selected (classification unavailable).";
  let classifiedBy = "default";

  /** @type {import('ai').ModelMessage[]} */
  const classifyMessages = [
    { role: "system", content: CLASSIFICATION_PROMPT },
    { role: "user", content: userTask.slice(0, 2000) },
  ];

  try {
    let classifyText = "";

    if (state.model) {
      // SDK path - use generateText for a fast single-shot response.
      // No shared browser context, so AI classification is safe here.
      const { generateText } = await import("ai");
      const { text } = await generateText({
        model: state.model,
        messages: classifyMessages,
        abortSignal: config?.signal ?? null,
      });
      classifyText = text;

      // Extract JSON from response (model may wrap it in markdown fences)
      const jsonMatch = classifyText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (["documentation", "investigation", "quick_edit", "new_project", "code_change"].includes(parsed.taskType)) {
          taskType = parsed.taskType;
          rationale = parsed.rationale || rationale;
          classifiedBy = "ai";
        }
      }
    }
    // Automation-API path: do NOT call provider.sendTurn for classification.
    // The orchestrator's AI call runs in a shared Copilot365 browser session.
    // The pool session created for replenishment navigates to the same M365
    // account conversation and inherits the orchestrator's exchange as prior
    // context - causing the researcher to output prose instead of tool calls.
    // Keywords + the code_change default are sufficient; avoiding the AI call
    // here keeps the researcher's session clean.

    // Keyword fallback for all paths
    if (classifiedBy !== "ai") {
      const kwResult = classifyByKeywords(userTask);
      if (kwResult) {
        taskType = kwResult.taskType;
        rationale = kwResult.rationale;
        classifiedBy = "keywords";
      }
    }
  } catch (err) {
    log(colors.yellow(`  [Graph] -> 🎯 Orchestrator classification failed (non-fatal): ${err.message}`));
    // Still try keyword fallback on hard error
    const kwResult = classifyByKeywords(userTask);
    if (kwResult) {
      taskType = kwResult.taskType;
      rationale = kwResult.rationale;
      classifiedBy = "keywords";
    }
  }

  log(colors.dim(`  [Graph] -> 🎯 Classified by: ${classifiedBy}`));

  // Pipeline labels for logging
  const PIPELINES = {
    documentation: "researcher → directWriter → verifier",
    investigation: "researcher → reviews",
    quick_edit:    "researcher → projectManager → coder → verifier → reviews",
    new_project:   "intent → projectManager → coder → verifier → reviews",
    code_change:   "researcher → scoper → projectManager → coder → verifier → reviews",
    direct_fix:    "projectManager → coder → verifier → reviews",
  };

  // Personas involved in each pipeline - used by the UI to dim/hide irrelevant personas
  const PIPELINE_PERSONAS = {
    documentation: ["orchestrator", "researcher", "directWriter", "verifier"],
    investigation: ["orchestrator", "researcher", "securityReviewer", "requirementsReviewer"],
    quick_edit:    ["orchestrator", "researcher", "projectManager", "coder", "verifier", "debugger", "securityReviewer", "requirementsReviewer"],
    new_project:   ["orchestrator", "projectManager", "coder", "verifier", "debugger", "securityReviewer", "requirementsReviewer"],
    code_change:   ["orchestrator", "researcher", "scoper", "projectManager", "coder", "verifier", "debugger", "stuckAnalyzer", "securityReviewer", "requirementsReviewer"],
    direct_fix:    ["orchestrator", "projectManager", "coder", "verifier", "debugger", "securityReviewer", "requirementsReviewer"],
  };

  const PIPELINE_LABELS = {
    documentation: "Documentation",
    investigation: "Investigation",
    quick_edit:    "Quick Edit",
    new_project:   "New Project",
    code_change:   "Code Change",
    direct_fix:    "Direct Fix",
  };

  log(colors.cyan(
    `  [Graph] -> 🎯 Task type: ${taskType} - ${rationale}\n` +
    `  [Graph] ->    Pipeline: ${PIPELINES[taskType]}`,
  ));

  // Emit structured pipeline info for the UI - lets the frontend filter the
  // persona roster to only show agents that will actually run for this task.
  eventBus.emit("pipeline_selected", {
    taskType,
    pipelineLabel: PIPELINE_LABELS[taskType],
    pipelineSteps: PIPELINES[taskType],
    personas: PIPELINE_PERSONAS[taskType],
    rationale,
  });

  return {
    taskType,
    currentPersona: PERSONA.id,
  };
}
