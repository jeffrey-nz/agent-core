import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  projectId: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "default",
  }),
  projectDir: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  ignore: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  model: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  bootstrapMode: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "crawl",
  }),
  provider: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  researchContext: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Condensed bullet-list summary extracted from the researcher's report.
  // Injected into the coder's static system prompt so it survives message windowing.
  researchSummary: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Detected project type string ("unity", "csharp", "php", "node", "unknown").
  projectType: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "unknown",
  }),
  // Ready-to-paste project-specific constraint block for AI system prompts.
  projectConstraints: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  executionPlan: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  subtasks: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  currentSubtaskIndex: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  // Each coder turn fully owns its own modifiedFiles - replace, don't union.
  // The verifier should only validate the files written in the CURRENT turn,
  // not all files accumulated across prior subtasks. nextSubtaskNode resets
  // this to [] on subtask advance; coderFailed path returns [] explicitly.
  modifiedFiles: Annotation({
    reducer: (x, y) => (Array.isArray(y) ? y : x),
    default: () => [],
  }),

  // Cumulative list of all files modified across ALL subtasks in the session.
  // Never reset between subtasks — coderNode injects this so each subtask's AI
  // knows which files were already touched by earlier subtasks.
  allModifiedFiles: Annotation({
    reducer: (x, y) => (Array.isArray(y) ? y : x),
    default: () => [],
  }),
  verifierFeedback: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  reviews: Annotation({
    reducer: (current, update) => {
      if (Array.isArray(update)) return update;
      return current.concat(update);
    },
    default: () => [],
  }),
  verificationFeedback: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  coderRetryCount: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),

  // Tracks how many consecutive TURN_SKIPPED (provider stall) events have occurred
  // for the current subtask. Reset to 0 on a successful coder turn or subtask advance.
  // Used to trigger the nuclear stall override after 2+ consecutive stalls.
  consecutiveStallCount: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),

  lastCoderResponse: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  lastToolsExecuted: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),

  // Execution tool failures from the last coder turn.
  // Each entry: { tool: string, summary: string }
  // Set by coderNode from loopRes.executionErrors; reset to [] on each new turn.
  lastExecutionErrors: Annotation({
    reducer: (x, y) => (Array.isArray(y) ? y : x),
    default: () => [],
  }),

  // Set to true by coderNode when a turn fails (e.g. SESSION_BUSY, TURN_SKIPPED).
  // Checked by verifierNode so stale accumulated modifiedFiles don't cause a
  // false PASS after a failed coder turn.
  coderFailed: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // Structured debug report produced by debuggerNode after repeated coder failures.
  // Contains ROOT CAUSE, EVIDENCE, FIX TARGET, RECOMMENDED CHANGE, CONFIDENCE.
  // Injected into the coder system prompt on the retry following debugging.
  // Cleared when a subtask advances (nextSubtaskNode resets it to null).
  debugReport: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  // Scope document produced by the scoping phase, containing Goal, What to build/change,
  // Out of scope, and Definition of done. Used by verifierNode to validate against.
  scopeDoc: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  // True once debuggerNode has run for the current subtask (even if it produced
  // no report - e.g. because the session stalled). Prevents the debugger from
  // firing again on the same subtask and creating an infinite loop.
  // Cleared when a subtask advances.
  debugAttempted: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // True once stuckAnalyzerNode has run for the current subtask. The stuck
  // analyzer fires when all coder retries are exhausted (instead of force-
  // advancing). It does deep failure-pattern research and resets the coder for
  // a completely fresh round with a revised strategy. This flag prevents the
  // analyzer from firing a second time - if the coder exhausts retries AGAIN
  // after reanalysis, the subtask is force-advanced.
  // Cleared when a subtask advances.
  stuckAnalysisAttempted: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // The original error captured at research time (from researcherNode).
  // Preserved across retries so the debugger and coder always have the
  // unmodified error text, not just whatever the last verifier mentioned.
  originalError: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Additional directories the agent should be aware of (self-upgrade / multi-dir mode).
  // When non-empty, the researcher merges constraints from each dir.
  contextDirs: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),

  // Currently active persona id (e.g. "researcher", "scoper", "projectManager", "coder").
  // Set at the start of each node so the UI persona roster can highlight the active agent.
  currentPersona: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Concrete scope document produced by the Scoper node.
  // Contains verified file paths, line numbers, method signatures, and dependency chains.
  // Injected into the Project Manager and Coder system prompts so they operate on
  // confirmed facts rather than researcher-level assumptions.
  scopeDocument: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // The user's original unscoped prompt, preserved before the scoping flow converts
  // it into a concise scope document. For documentation tasks the actual content
  // (issue lists, notes, etc.) lives here - the scoped task typically strips it.
  // researcherNode and directWriterNode use this as the content source so that
  // user-supplied content is never lost to the scoping transformation.
  initialPrompt: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Task type determined by the orchestratorNode.
  // Controls which pipeline is used:
  //   "documentation" → researcher → directWriter → verifier
  //   "investigation"  → researcher → broadcastReviews
  //   "quick_edit"     → researcher → projectManager → coder → verifier → reviews
  //   "code_change"    → researcher → scoper → projectManager → coder → verifier → reviews (default)
  taskType: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "code_change",
  }),

  // Reflexion memory: verbal lessons accumulated within a session from coder failures.
  // Append-only. Each entry: { subtaskIndex, lesson, t }.
  // Injected into the coder system prompt so past failure patterns are not repeated.
  reflexionMemory: Annotation({
    reducer: (x, y) => Array.isArray(y) ? [...x, ...y] : x,
    default: () => [],
  }),

  // Per-subtask confidence scores emitted after each verifier run.
  // Each entry: { subtaskIndex, score, retries, t }.
  confidenceHistory: Annotation({
    reducer: (x, y) => Array.isArray(y) ? [...x, ...y] : x,
    default: () => [],
  }),

  // Structured tool plan output by the coder before executing tools.
  // Null until the coder produces one. Cleared on subtask advance.
  toolPlan: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  // Productivity-scored tool call log for the current coder turn.
  // Each entry: { tool, score, t } — score 1=productive write, 0.5=prep read, 0=repeated read.
  toolRewardLog: Annotation({
    reducer: (x, y) => Array.isArray(y) ? [...x, ...y] : x,
    default: () => [],
  }),

  // Last smoke-test screenshot available for vision-augmented verification.
  // Set when a smoke_screenshot event is received during a session.
  // Shape: { screenshotBase64: string, url: string, t: number } | null
  lastSmokeScreenshot: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  // Plan revision history — records each adaptive plan update from planReviewNode.
  // Each entry: { subtaskIndex, oldRemaining: string[], newRemaining: string[], reason, t }
  planRevisions: Annotation({
    reducer: (x, y) => Array.isArray(y) ? [...x, ...y] : x,
    default: () => [],
  }),

  // Structured intent document produced by intentNode before research begins.
  // Contains: goal, success_criteria, out_of_scope, key_constraints, verification_approach, risk_areas.
  // Injected into researcher, PM, and reviewer system prompts to align the whole pipeline.
  intentDocument: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Set to true after planValidatorNode runs (first planning pass only).
  // Prevents the validator from re-running on subsequent subtask advances —
  // planReviewNode handles those.
  planValidated: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // True once the debugger has run a SECOND time for the current subtask.
  // The debugger can fire at most twice: once at retry 3, once at retry 6.
  // Cleared when a subtask advances (nextSubtaskNode resets to false).
  debug2Attempted: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // Condensed, implementation-focused distillation of the researcher's output,
  // produced by refinerNode. Contains: critical facts, implementation gaps,
  // confirmed-existing components, risk factors, and verification commands.
  // Injected into the scoper and PM to reduce noise from the raw research report.
  refinedResearch: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Adversarial critique of the execution plan produced by criticNode.
  // Contains: hidden assumptions, likely failure points, missing steps,
  // technical hazards, and success criteria gaps.
  // Injected into the coder's first turn system prompt for risk awareness.
  criticReport: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Set to true after criticNode runs (first planning pass only).
  // Prevents the critic from re-running on subtask advances/retries.
  criticCompleted: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // Memory bank context retrieved from docs/memory/ by contextRetrieverNode.
  // Contains patterns, technical context, and active focus from prior sessions.
  // Injected into the researcher and coder system prompts.
  retrievedContext: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Human-readable environment baseline report produced by environmentNode.
  // Contains HTTP status, git state, composer state, SS cache state.
  // Injected into the coder system prompt so it knows about pre-existing issues.
  environmentReport: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // True once environmentNode has run for this session. Prevents re-running
  // on every subtask advance — the baseline is established once at the start.
  environmentChecked: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // True if the site was already broken (HTTP 500 etc.) before any writes.
  // Used by the coder to understand that smoke test failures may be pre-existing.
  environmentHealthy: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => true,
  }),

  // Array of pre-existing error strings detected by environmentNode.
  // e.g. ["⚠️ SITE IS ALREADY AT HTTP 500 BEFORE ANY CHANGES: ..."]
  preExistingErrors: Annotation({
    reducer: (x, y) => (Array.isArray(y) ? y : x),
    default: () => [],
  }),

  // "OK" | "FAIL" — set by patchReviewerNode after reviewing the coder's diff.
  // Drives the patchReviewer → coder | verifier conditional edge.
  patchReviewFeedback: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Counts how many times patchReviewerNode has rejected the current subtask.
  // Capped at MAX_PATCH_REVIEW_RETRIES — then passes to verifier regardless.
  // Reset to 0 on subtask advance.
  patchReviewRetryCount: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),

  // Set to true when the pipeline is blocked because a required target file
  // could not be found during research. Causes the workflow to route directly
  // to broadcastReviews (session end) instead of continuing to the verifier.
  sessionBlocked: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),

  // GitHub integration options threaded from runAgent into graph nodes.
  // Shape: { client, owner, repo, issueNumber: number } | null
  // null when GitHub integration is disabled or not configured.
  githubOptions: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),

  // Maps subtask id (string) → GitHub sub-issue number (number).
  // Populated by githubSyncNode after planning completes.
  // e.g. { "1": 456, "2": 457 }
  subtaskIssueMap: Annotation({
    reducer: (x, y) => (y && typeof y === "object") ? { ...x, ...y } : x,
    default: () => ({}),
  }),

  // Cross-session reflexion lessons loaded from docs/memory/reflexion.md by contextRetrieverNode.
  // Written there by memoryUpdateNode at session end. Injected into coder on first attempt.
  reflexionContext: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // Set for benchmark sessions only. Enables check.js as the verifier (instead of AI)
  // and injects the test contract into the coder's system prompt on the first attempt.
  benchmarkScenarioId: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
});
