import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { updateCheckpointState } from "./checkpointBridge.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { orchestratorNode } from "./nodes/orchestratorNode.js";
import { researcherNode } from "./nodes/researcherNode.js";
import { directWriterNode } from "./nodes/directWriterNode.js";
import { scoperNode } from "./nodes/scoperNode.js";
import { projectManagerNode } from "./nodes/projectManagerNode.js";
import { coderNode } from "./nodes/coderNode.js";
import { verifierNode } from "./nodes/verifierNode.js";
import { debuggerNode } from "./nodes/debuggerNode.js";
import { stuckAnalyzerNode } from "./nodes/stuckAnalyzerNode.js";
import { subtaskProgressNode } from "./nodes/subtaskProgressNode.js";

import { securityNode } from "./nodes/reviewers/securityNode.js";
import { requirementsNode } from "./nodes/reviewers/requirementsNode.js";
import { aggregatorNode } from "./nodes/reviewers/aggregatorNode.js";
import { memoryUpdateNode } from "./nodes/memoryUpdateNode.js";
import { planReviewNode } from "./nodes/planReviewNode.js";
import { intentNode } from "./nodes/intentNode.js";
import { refinerNode } from "./nodes/refinerNode.js";
import { planValidatorNode } from "./nodes/planValidatorNode.js";
import { criticNode } from "./nodes/criticNode.js";
import { contextRetrieverNode } from "./nodes/contextRetrieverNode.js";
import { environmentNode } from "./nodes/environmentNode.js";
import { patchReviewerNode } from "./nodes/patchReviewerNode.js";
import { githubSyncNode } from "./nodes/githubSyncNode.js";
import {
  MAX_VERIFIER_RETRIES,
  DEBUGGER_TRIGGER_RETRIES,
  DEBUGGER2_TRIGGER_RETRIES,
} from "#config/pipeline.js";

/**
 * Route by task type after the refiner condenses the research.
 * (Previously named routeFromResearcher — renamed because the conditional edge
 * now fires from the "refiner" node, not directly from "researcher".)
 *
 *   documentation → directWriter  (researcher produced the doc content; writer saves it)
 *   investigation  → broadcastReviews  (report only; no code changes)
 *   quick_edit     → projectManager  (skip deep scoping; researcher already found the location)
 *   direct_fix     → projectManager  (intent skipped — orchestrator routes directly to PM)
 *   code_change    → scoper  (default; full deep-analysis pipeline)
 */
function routeByTaskType(state) {
  switch (state.taskType) {
    case "documentation": return "directWriter";
    case "investigation":  return "broadcastReviews";
    case "quick_edit":
    case "direct_fix":     return "projectManager";
    default:               return "scoper";
  }
}

/**
 * Route after intent node.
 * direct_fix: prompt already specifies the file and change — skip research entirely.
 * All other types: proceed to contextRetriever → researcher → refiner.
 */
function routeAfterIntent(state) {
  if (state.taskType === "direct_fix") return "projectManager";
  return "contextRetriever";
}

function routeFromVerifier(state) {
  // ENVIRONMENT_BLOCKED: the verifier confirmed execution errors are all
  // environment-level (DNS failure, file permissions) that code changes cannot
  // fix. Treat the same as PASS — the task is advanced and the user is notified
  // via eventBus rather than burning remaining retries on an unwinnable loop.
  if (
    state.verifierFeedback === "PASS" ||
    state.verifierFeedback === "ENVIRONMENT_BLOCKED"
  ) {
    if (
      state.subtasks &&
      (state.currentSubtaskIndex || 0) < state.subtasks.length - 1
    ) {
      return "nextSubtask";
    }
    return "broadcastReviews";
  }

  // Documentation pipeline: directWriter failed (fs error or empty content).
  // Route back to directWriter — never to coder, which has the wrong prompt
  // and will output prose instead of writing the file.
  // Cap at 3 retries to handle transient issues (race conditions, missing
  // parent directories) without looping forever on hard permission errors.
  if (state.taskType === "documentation") {
    const retries = state.coderRetryCount ?? 0;
    return retries < 3 ? "directWriter" : "broadcastReviews";
  }

  const retries = state.coderRetryCount ?? 0;

  // Break the infinite verifier→coder loop: if the coder has already failed
  // MAX_VERIFIER_RETRIES times on this subtask, force-advance rather than
  // looping forever. verifierNode increments coderRetryCount on every FAIL.
  if (retries >= MAX_VERIFIER_RETRIES) {
    const isLastSubtask =
      !state.subtasks ||
      (state.currentSubtaskIndex || 0) >= state.subtasks.length - 1;
    return isLastSubtask ? "broadcastReviews" : "nextSubtask";
  }

  // Benchmark scenarios skip the debugger entirely — check.js already provides
  // precise TAP failure output as retry feedback. Running a 5-10 minute
  // root-cause investigation loop wastes the timeout budget for no benefit.
  if (!state.benchmarkScenarioId) {
    // First debugger: after DEBUGGER_TRIGGER_RETRIES failures (default 3), run
    // targeted root-cause investigation.
    //
    // Guard: !state.debugAttempted ensures the first debugger fires at most once per subtask.
    // Note: coderFailed (stalled turn) is intentionally NOT excluded — the debugger is most
    // valuable exactly when the coder is stalling, so it can identify the root cause.
    if (retries >= DEBUGGER_TRIGGER_RETRIES && !state.debugAttempted) {
      return "debugger";
    }

    // Second debugger: fires at DEBUGGER2_TRIGGER_RETRIES if the first debug has
    // already run but the coder still hasn't succeeded. Provides a second round
    // of targeted investigation with fresh context from the additional failures.
    if (
      retries >= DEBUGGER2_TRIGGER_RETRIES &&
      state.debugAttempted &&
      !state.debug2Attempted
    ) {
      return "debugger";
    }
  }

  return "coder";
}

/**
 * Route from coder.
 * sessionBlocked → broadcastReviews (pipeline halted — target file not found)
 * otherwise      → patchReviewer
 */
function routeFromCoder(state) {
  return state.sessionBlocked ? "broadcastReviews" : "patchReviewer";
}

/**
 * Route after the patchReviewer.
 * FAIL → back to coder (with fix instructions injected into messages)
 * OK   → forward to verifier
 */
function routeFromPatchReviewer(state) {
  return state.patchReviewFeedback === "FAIL" ? "coder" : "verifier";
}

function routeFromAggregator(state) {
  // Coder was blocked (target file not found) — aggregator already returned
  // STUCK_TERMINAL, but guard here too so a stale sessionBlocked flag never
  // routes back to the coder for another futile attempt.
  if (state.sessionBlocked) return "knowledgeCapture";

  if (state.verificationFeedback === "APPROVED") return "knowledgeCapture";

  if (state.verificationFeedback === "STUCK_TERMINAL") return "knowledgeCapture";

  // Capture learning mid-cycle before handing back to coder, so failed
  // attempts are recorded in the episodic log even if the job eventually succeeds.
  if (state.verificationFeedback === "STUCK_ADVANCE") return "knowledgeCaptureAndContinue";

  // Deep re-analysis: all retries exhausted but no stuck-analysis done yet.
  // Route to the stuck analyzer which investigates the failure pattern and
  // resets the coder for a fresh round with a revised strategy.
  if (state.verificationFeedback === "NEEDS_REANALYSIS") return "stuckAnalyzer";

  return "coder";
}

const nextSubtaskNode = (state) => {
  const nextIndex = (state.currentSubtaskIndex || 0) + 1;
  // Keep the checkpoint bridge in sync so a crash mid-session resumes at the
  // correct subtask rather than replaying work that already completed.
  updateCheckpointState({ currentSubtaskIndex: nextIndex });
  return {
    currentSubtaskIndex: nextIndex,
    coderRetryCount: 0,
    consecutiveStallCount: 0,
    // Accumulate all files written so far before resetting the per-subtask list.
    // coderNode injects allModifiedFiles into the system prompt so each subtask
    // knows which files earlier subtasks already changed.
    allModifiedFiles: Array.from(new Set([
      ...(state.allModifiedFiles || []),
      ...(state.modifiedFiles || []),
    ])),
    // Reset so the verifier and reviewers only see files from the NEXT subtask,
    // not a union of everything written across all prior subtasks.
    modifiedFiles: [],
    // Clear debug state so the next subtask starts fresh with a new debugger slot.
    debugReport: null,
    debugAttempted: false,
    debug2Attempted: false,
    // Clear stuck-analysis state so the next subtask gets its own analyzer slot.
    stuckAnalysisAttempted: false,
    // Clear the active persona so the coder's persona_change event is always fresh.
    currentPersona: "",
    // Reset patchReviewer retry counter so the new subtask gets a fresh budget.
    patchReviewFeedback: "",
    patchReviewRetryCount: 0,
    // Clear refiner output — it was scoped to the original research pass and
    // should not bleed into per-subtask coder/verifier context on retries.
    refinedResearch: "",
    // NOTE: criticReport is intentionally NOT cleared here.
    // The critic analyzes the FULL plan once; its warnings about subtask N are
    // still valid when the coder actually runs subtask N. coderNode extracts only
    // the section relevant to the current subtask index via extractSubtaskCriticSection.
    // planReviewNode resets criticReport: "" alongside criticCompleted: false when
    // the plan is significantly revised (new plan = fresh critic analysis needed).
    // NOTE: planValidated is intentionally NOT reset here — the plan validator
    // also runs once per planning pass. planReviewNode handles mid-run revisions.
  };
};

function routeFromStart(state) {
  // Preloaded subtasks from GitHub resume — skip straight to coder
  if (Array.isArray(state.subtasks) && state.subtasks.length > 0) {
    return "coder";
  }
  return "orchestrator";
}

export function buildAgentWorkflow() {
  return new StateGraph(AgentState)
    .addNode("orchestrator", orchestratorNode)
    .addNode("intent", intentNode)
    // Loads memory bank from docs/memory/ before research begins.
    // Closes the learning loop: memoryUpdate (end) → contextRetriever (start) → coder (use).
    .addNode("contextRetriever", contextRetrieverNode)
    .addNode("researcher", researcherNode)
    .addNode("refiner", refinerNode)
    .addNode("directWriter", directWriterNode)
    .addNode("scoper", scoperNode)
    .addNode("projectManager", projectManagerNode)
    .addNode("githubSync", githubSyncNode)
    .addNode("planValidator", planValidatorNode)
    .addNode("critic", criticNode)
    // Pre-flight environment check: HTTP baseline, git state, composer, cache.
    // Runs once per session before the first coder turn.
    .addNode("environment", environmentNode)
    .addNode("coder", coderNode)
    // Post-coder diff review: dual-rendering, YAML quoting, stubs, missing deletions.
    // Sits between coder and verifier — catches semantic bugs HTTP 200 smoke tests miss.
    .addNode("patchReviewer", patchReviewerNode)
    .addNode("verifier", verifierNode)
    .addNode("debugger", debuggerNode)
    .addNode("stuckAnalyzer", stuckAnalyzerNode)
    .addNode("nextSubtask", nextSubtaskNode)
    .addNode("subtaskProgress", subtaskProgressNode)
    .addNode("planReviewer", planReviewNode)
    .addNode("broadcastReviews", () => ({ reviews: [] }))
    .addNode("securityReview", securityNode)
    .addNode("requirementsReview", requirementsNode)
    .addNode("reviewAggregator", aggregatorNode)
    .addNode("knowledgeCapture", memoryUpdateNode)
    // Updates memory mid-cycle (STUCK_ADVANCE) without breaking the retry loop.
    .addNode("knowledgeCaptureAndContinue", async (state) => {
      await memoryUpdateNode(state);
      return {};
    })

    .addConditionalEdges(START, routeFromStart, {
      orchestrator: "orchestrator",
      coder: "coder",
    })
    // direct_fix: prompt already names the file and change — skip intent entirely.
    // Intent node running for direct_fix tasks is wasteful and causes PM failures
    // when the provider echoes the format-requirement template as the intent text.
    .addConditionalEdges("orchestrator", (state) =>
      state.taskType === "direct_fix" ? "projectManager" : "intent"
    )
    // contextRetriever runs after intent (has task text + intentDocument available)
    // and before researcher so retrieved knowledge informs the research direction.
    .addConditionalEdges("intent", routeAfterIntent)
    .addEdge("contextRetriever", "researcher")
    // refiner condenses research before routing — skips automatically for docs/investigation
    .addEdge("researcher", "refiner")
    .addConditionalEdges("refiner", routeByTaskType)
    // documentation path
    .addEdge("directWriter", "verifier")
    // code_change path: scoper → PM → planValidator → critic → environment → coder
    .addEdge("scoper", "projectManager")
    .addEdge("projectManager", "githubSync")
    // direct_fix: plan is always 1 obvious subtask — skip validation and critique
    .addConditionalEdges("githubSync", (state) =>
      state.taskType === "direct_fix" ? "environment" : "planValidator"
    )
    // critic adversarially challenges the validated plan before any code is written
    .addEdge("planValidator", "critic")
    // environment inspector runs once before the first coder turn
    .addEdge("critic", "environment")
    .addEdge("environment", "coder")
    // patchReviewer sits between coder and verifier — catches diff-level bugs
    .addConditionalEdges("coder", routeFromCoder, {
      patchReviewer: "patchReviewer",
      broadcastReviews: "broadcastReviews",
    })
    .addConditionalEdges("patchReviewer", routeFromPatchReviewer, {
      coder: "coder",
      verifier: "verifier",
    })

    .addConditionalEdges("verifier", routeFromVerifier)
    .addEdge("debugger", "coder")
    .addEdge("stuckAnalyzer", "coder")
    .addEdge("nextSubtask", "subtaskProgress")
    .addEdge("subtaskProgress", "planReviewer")
    // planReviewer → environment: re-run env check on subtask advance so new
    // baseline reflects any permissions/cache fixes from the completed subtask.
    // environmentNode skips if environmentChecked=true so it's a no-op unless
    // something changed (e.g. permissions were fixed by the previous subtask).
    // NOTE: we route planReviewer → coder directly (env runs once at session start).
    .addEdge("planReviewer", "coder")

    .addEdge("broadcastReviews", "securityReview")
    .addEdge("broadcastReviews", "requirementsReview")

    .addEdge("securityReview", "reviewAggregator")
    .addEdge("requirementsReview", "reviewAggregator")

    .addConditionalEdges("reviewAggregator", routeFromAggregator)
    .addEdge("knowledgeCapture", END)
    .addEdge("knowledgeCaptureAndContinue", "coder")
    .compile();
}
