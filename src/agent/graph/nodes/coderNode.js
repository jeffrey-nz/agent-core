import { streamText } from "ai";
import { getMcpBoundTools } from "../../tools/sdkRegistry.js";
import { eventBus } from "#web/eventBus.js";
import { dashboardState } from "#app/ui/dashboard.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { gitResetHard } from "#utils/gitReset.js";
import { personaMeta } from "../personas.js";
import { loadProceduralKnowledge } from "#utils/contextLoader.js";
import { classifyEnvironmentError } from "#agent/utils/executionOutputAnalysis.js";
import { MAX_STEPS_CODER, MAX_STEPS_CODER_UNITY } from "#config/pipeline.js";
import { buildCoderDirective, getCoderMaxSteps, buildAcceptanceTestDirective } from "#utils/projectDirectives.js";
import { resolveProjectUrl } from "#copilot/run/main/applyFilesPhase/validators/resolveProjectUrl.js";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const PERSONA = personaMeta("coder");

// ── Constitutional AI: Subtask Hazard Analysis ────────────────────────────────
// Proactively detect known failure patterns in the subtask description before the
// coder runs and inject targeted guardrails (Bai et al. 2022 — Constitutional AI).
// Prevents entering multi-retry failure loops for well-understood antipatterns.
function buildSubtaskHazards(currentTask, currentSubtask, projectType) {
  const hazards = [];
  const taskAndNote = `${currentTask} ${currentSubtask?.implementationNote || ""} ${currentSubtask?.constraints || ""}`;

  if (projectType === "swift") {
    // Hazard: @Observable migration — must be atomic across ALL consuming views
    if (/@[Oo]bservable|[Oo]bservable[Oo]bject|@[Ss]tate[Oo]bject|@[Oo]bserved[Oo]bject|@[Bb]indable/i.test(taskAndNote)) {
      hazards.push(
        `⚠️ SWIFT HAZARD — @Observable MIGRATION MUST BE ATOMIC\n` +
        `The patch validator runs swiftc -typecheck after EVERY individual tool call.\n` +
        `If you migrate the ViewModel (add @Observable, remove ObservableObject) in one write_file\n` +
        `and plan to update consuming views in a later call, the validator REJECTS the first write\n` +
        `and rolls it back — you can never reach the second step.\n` +
        `ALL files must change in a SINGLE JSON tool call array:\n` +
        `  • ViewModel: add @Observable, remove : ObservableObject, remove @Published\n` +
        `  • Owner views: @StateObject var vm = VM()  →  @State var vm = VM()\n` +
        `  • Receiver views: @ObservedObject var vm: VM  →  @Bindable var vm: VM\n` +
        `Write all of them in one [write_file, write_file, write_file, ...] array.`,
      );
    }

    // Hazard: UIKit removal — must replace ALL UIKit-dependent APIs in the same write_file
    if (/remove.*import UIKit|import UIKit.*remov|UIKit.*atomic|color\(\.system|systemBackground/i.test(taskAndNote)) {
      hazards.push(
        `⚠️ SWIFT HAZARD — UIKit REMOVAL MUST BE ATOMIC\n` +
        `patch_file to remove "import UIKit" alone immediately reveals Color(.systemBackground)\n` +
        `and other UIKit-dependent API errors. The patch validator catches these and rolls back.\n` +
        `Fix: use write_file to rewrite the ENTIRE file with BOTH the import removed AND all\n` +
        `UIKit-dependent calls replaced:\n` +
        `  Color(.systemBackground)  →  Color(red: 0.97, green: 0.97, blue: 0.97)\n` +
        `  UINotificationFeedbackGenerator  →  SensoryFeedback (iOS 17+) or remove\n` +
        `  UIPasteboard  →  ShareLink or remove`,
      );
    }

    // Hazard: preferredColorScheme — well-known Scene vs View type error
    if (/preferredColorScheme|color\s*scheme/i.test(taskAndNote)) {
      hazards.push(
        `⚠️ SWIFT HAZARD — preferredColorScheme MUST BE INSIDE WindowGroup CONTENT\n` +
        `  WRONG (current — type error, always masked by swiftc cascade):\n` +
        `    WindowGroup { ContentView() }.preferredColorScheme(.dark)\n` +
        `  RIGHT (View modifier applied to the View inside the Scene):\n` +
        `    WindowGroup { Group { ContentView() }.preferredColorScheme(.dark) }\n` +
        `The verifier detects this via static brace-depth analysis INDEPENDENT of swiftc output.`,
      );
    }

    // Hazard: deprecated onChange — two-param form required
    if (/\.onChange\s*\(of:/i.test(taskAndNote)) {
      hazards.push(
        `⚠️ SWIFT HAZARD — onChange(of:) MUST USE TWO-PARAMETER CLOSURE\n` +
        `  WRONG (deprecated iOS 17): .onChange(of: x) { newVal in ... }\n` +
        `  RIGHT (iOS 17+):           .onChange(of: x) { oldVal, newVal in ... }\n` +
        `  OR (zero-param):           .onChange(of: x) { /* read x directly */ }\n` +
        `The verifier static-analysis check REJECTS acceptance if single-param form is present.`,
      );
    }
  }

  // Hazard: TypeScript verbatimModuleSyntax — type-only imports required
  // Modern Vite/React tsconfigs have "verbatimModuleSyntax": true which requires
  // types to be imported with `import type { ... }`, not regular `import { ... }`.
  // This is a very common error in AI-generated TypeScript code.
  if (projectType !== "swift" && /\.(ts|tsx)$/i.test(taskAndNote)) {
    hazards.push(
      `⚠️ TYPESCRIPT HAZARD — USE import type FOR TYPE-ONLY IMPORTS\n` +
      `This project uses "verbatimModuleSyntax": true in tsconfig which REQUIRES:\n` +
      `  WRONG: import { Board, Position, Move } from './types';\n` +
      `  RIGHT: import type { Board, Position, Move } from './types';\n` +
      `Rule: if you import ONLY type aliases, interfaces, or type parameters — use import type.\n` +
      `If a module exports both values AND types, split into separate import statements:\n` +
      `  import { GameState } from './GameState';     // class — value import\n` +
      `  import type { Move, Position } from './types'; // types — type import\n` +
      `Failing to use import type causes TS1484 errors that will be caught by the verifier.`,
    );
  }

  // Hazard: React useEffect + setState + setTimeout — the timer-cancellation trap.
  // This is the #1 cause of broken AI opponents and async game state in React games.
  // Fires whenever the task involves React (.tsx/.jsx) and game/AI/opponent patterns.
  const taskAndFiles = `${taskAndNote} ${(currentSubtask?.files || []).join(" ")}`;
  const isGameTask = /game|chess|board|ai|opponent|player|turn|move/i.test(taskAndFiles);
  const isReactFileTask = /\.(jsx|tsx)$|react|vite/i.test(taskAndFiles);
  if (isReactFileTask && isGameTask) {
    hazards.push(
      `⚠️ REACT GAME HAZARD — useEffect + setState + setTimeout TIMER-CANCELLATION TRAP\n` +
      `The MOST common cause of AI opponents not responding:\n\n` +
      `BROKEN PATTERN (AI never moves):\n` +
      `  useEffect(() => {\n` +
      `    if (isAIPlaying) return;\n` +
      `    setIsAIPlaying(true);          // ← setState TRIGGERS CLEANUP!\n` +
      `    const t = setTimeout(() => {   // ← this timer gets CANCELLED by cleanup\n` +
      `      applyAIMove(); setIsAIPlaying(false);\n` +
      `    }, 300);\n` +
      `    return () => clearTimeout(t);  // ← cleanup cancels t when setIsAIPlaying re-renders\n` +
      `  }, [gameState, isAIPlaying]);\n\n` +
      `WHY IT BREAKS: setIsAIPlaying(true) causes a re-render → React runs cleanup\n` +
      `(clearTimeout) → re-runs effect → isAIPlaying is now true → early return.\n` +
      `Timer is cancelled before it fires. AI never moves.\n\n` +
      `CORRECT PATTERN — use useRef for the semaphore (refs don't trigger cleanup):\n` +
      `  const aiTriggerRef = useRef(false);\n` +
      `  useEffect(() => {\n` +
      `    if (currentTurn !== 'black' || aiTriggerRef.current) return;\n` +
      `    aiTriggerRef.current = true;\n` +
      `    const t = setTimeout(() => {\n` +
      `      setGameState(s => { const move = getAIMove(s); return move ? applyMove(s, move) : s; });\n` +
      `      aiTriggerRef.current = false;\n` +
      `    }, 300);\n` +
      `    return () => clearTimeout(t);\n` +
      `  }, [currentTurn]);\n\n` +
      `ALSO: Use functional setState (s => ...) inside setTimeout to avoid stale closures.`,
    );
  }

  // General hazard: test/REVIEW subtasks must NOT write files
  if (/^(REVIEW|LOCATE|FIND|IDENTIFY|INVESTIGATE|ACCEPTANCE TEST):/i.test(currentTask.trim())) {
    hazards.push(
      `⚠️ TASK PROTOCOL — THIS IS A READ-ONLY OR VERIFICATION TASK\n` +
      `Do NOT write, create, or modify any files.\n` +
      `REVIEW/LOCATE/FIND tasks: use read_file and quote the specific line(s) that confirm/deny.\n` +
      `ACCEPTANCE TEST tasks: use execute_bash (Swift) or http_request (web) to verify.`,
    );
  }

  if (hazards.length === 0) return "";
  return `\n[PROACTIVE HAZARD ANALYSIS — KNOWN FAILURE PATTERNS FOR THIS SUBTASK]\n` +
    hazards.join("\n\n") + "\n";
}

/**
 * Extract the portion of the critic report relevant to the current subtask.
 *
 * The critic produces sections like:
 *   ## LIKELY FAILURE POINTS
 *   - Subtask 3: why it will fail
 *   ## TECHNICAL HAZARDS
 *   - Hazard: concrete risk
 *
 * Strategy:
 * - Always include TECHNICAL HAZARDS and MISSING STEPS (apply to all subtasks).
 * - From LIKELY FAILURE POINTS, extract only lines mentioning the current subtask
 *   index (1-based) or any of the subtask's target files.
 * - If nothing subtask-specific is found, return the TECHNICAL HAZARDS only.
 * - Returns empty string if the critic found no real risks.
 */
function extractSubtaskCriticSection(criticReport, subtaskIndex, subtask) {
  if (!criticReport?.trim() || criticReport.includes("No significant risks identified")) {
    return "";
  }

  const lines = criticReport.split("\n");
  const subtaskNum = subtaskIndex + 1; // critic uses 1-based "Subtask N" references
  const subtaskFiles = subtask?.files || [];
  const subtaskTask = (subtask?.task || "").toLowerCase();

  // Extract section lines by heading
  const sections = {};
  let currentSection = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      currentSection = heading[1].trim().toUpperCase();
      sections[currentSection] = [];
    } else if (currentSection) {
      sections[currentSection].push(line);
    }
  }

  const parts = [];

  // Always include TECHNICAL HAZARDS — they apply to any subtask in the plan
  const hazards = sections["TECHNICAL HAZARDS"]?.join("\n").trim();
  if (hazards) parts.push(`## TECHNICAL HAZARDS\n${hazards}`);

  // Include MISSING STEPS — structural gaps affect all coders
  const missing = sections["MISSING STEPS"]?.join("\n").trim();
  if (missing) parts.push(`## MISSING STEPS\n${missing}`);

  // From LIKELY FAILURE POINTS, extract entries mentioning this subtask index or files
  const failureLines = sections["LIKELY FAILURE POINTS"] || [];
  const relevantFailures = failureLines.filter((line) => {
    if (!line.trim()) return false;
    const lower = line.toLowerCase();
    if (new RegExp(`subtask\\s+${subtaskNum}\\b`, "i").test(line)) return true;
    if (subtaskFiles.some((f) => lower.includes(f.toLowerCase().split("/").pop()))) return true;
    if (subtaskTask && subtaskTask.split(" ").some((w) => w.length > 5 && lower.includes(w))) return true;
    return false;
  });
  if (relevantFailures.length > 0) {
    parts.unshift(`## LIKELY FAILURE POINTS (for this subtask)\n${relevantFailures.join("\n")}`);
  }

  return parts.join("\n\n").trim();
}

export async function coderNode(state, config) {
  log(
    colors.cyan(
      `  [Graph] -> Running Coder Agent (Subtask ${(state.currentSubtaskIndex || 0) + 1}/${state.subtasks?.length || 1})...`,
    ),
  );
  const currentSubtask = state.subtasks?.[state.currentSubtaskIndex];
  const _coderAttempt = state.coderRetryCount ?? 0;
  const _taskLabel = currentSubtask?.task || "";
  const _subtaskIdx = state.currentSubtaskIndex || 0;
  const _totalSubtasks = state.subtasks?.length || 1;

  eventBus.emit("persona_change", {
    ...PERSONA,
    subtitle: _coderAttempt > 0 ? `Attempt ${_coderAttempt + 1}` : null,
    description: _taskLabel ? _taskLabel.slice(0, 70) + (_taskLabel.length > 70 ? "…" : "") : "Implementing changes",
  });

  // Emit a structured kickoff event on the first attempt of each subtask.
  // Distinct from persona_change — carries subtask-level metadata so the UI
  // can show "Subtask 3/8: Add null checks to CombatSystem.cs" clearly.
  if (_coderAttempt === 0) {
    eventBus.emit("subtask_kickoff", {
      index: _subtaskIdx,
      total: _totalSubtasks,
      label: _taskLabel,
      files: currentSubtask?.files || [],
      id: currentSubtask?.id ?? _subtaskIdx,
    });
  }
  // If the PM generated a BLOCKED placeholder (researcher couldn't find the target file),
  // emit the error message and mark session failed rather than burning AI turns on a phantom task.
  if (/⛔\s*BLOCKED/i.test(currentSubtask?.task || "")) {
    const blockedMsg = currentSubtask?.implementationNote || currentSubtask?.task || "Target file not found.";
    log(colors.red(`  [Graph] -> Coder: BLOCKED subtask detected — halting session`));
    eventBus.emit("session_error", { message: blockedMsg });
    return {
      modifiedFiles: [],
      lastCoderResponse: blockedMsg,
      lastToolsExecuted: [],
      lastExecutionErrors: [],
      coderFailed: true,
      verifierFeedback: "FAIL",
      sessionBlocked: true,
    };
  }

  const currentTask =
    currentSubtask?.task || "Complete the remaining requirements";

  const taskId = currentSubtask?.id;
  if (taskId != null) {
    dashboardState.activeTaskId = taskId;
    eventBus.emit("task_state_change", { taskId, state: "in_progress" });
  }

  const diagnosticsInstruction = state.model
    ? `- CRITICAL VERIFICATION: Before you finish this subtask, you MUST run the 'get_workspace_diagnostics' tool to verify you have not introduced syntax or compilation errors.\n`
    : "";

  // Constitutional AI: React scaffold hazard — detect when writing React/JSX/TSX files
  // into a project with no package.json, which makes the app unable to run or test.
  // The verifier skips test validation when package.json is absent → false PASS.
  const taskAndFiles = `${currentTask} ${(currentSubtask?.files || []).join(" ")} ${currentSubtask?.implementationNote || ""}`;
  const isReactTask = /\.(jsx|tsx)$|react|vite/i.test(taskAndFiles);
  const scaffoldHazard = isReactTask
    ? await access(path.join(state.projectDir, "package.json")).then(() => false).catch(() => true)
    : false;
  const reactScaffoldWarning = scaffoldHazard
    ? `\n⚠️ REACT SCAFFOLD HAZARD — package.json IS MISSING\n` +
      `Writing .jsx files without package.json means the app cannot run and Vitest cannot execute, ` +
      `causing a false PASS from the verifier (test validation is skipped when package.json is absent).\n` +
      `You MUST create package.json, vite.config.js, index.html, and src/main.jsx IN THIS RESPONSE ` +
      `alongside any other files for this subtask. Include all of them in a single write_file array.\n`
    : "";

  // Build the subtask block - includes planned file list, line range, implementation
  // note, and constraints from the enriched planner output so the coder knows
  // exactly what to touch and what to write without re-reading every file.
  const subtaskFilesNote =
    currentSubtask?.files?.length > 0
      ? `\nExpected files to create/modify:\n${currentSubtask.files.map((f) => `  - ${f}`).join("\n")}`
      : "";
  const subtaskLineRangeNote = currentSubtask?.lineRange
    ? `\nTarget line range: ${currentSubtask.lineRange}`
    : "";
  const subtaskImplNote = currentSubtask?.implementationNote
    ? `\nImplementation guidance (from Scope Document):\n${currentSubtask.implementationNote}`
    : "";
  const subtaskConstraintsNote = currentSubtask?.constraints
    ? `\nSubtask-specific constraints: ${currentSubtask.constraints}`
    : "";
  // Acceptance test subtasks carry structured criteria so the coder knows exactly
  // what HTML to look for — surface them explicitly rather than burying in impl note.
  const subtaskAcceptanceCriteria = currentSubtask?.acceptanceCriteria
    ? `\nSuccess evidence (what to find in HTTP response): ${currentSubtask.acceptanceCriteria}`
    : "";
  const subtaskFailureCriteria = currentSubtask?.failureCriteria
    ? `\nFailure indicators: ${currentSubtask.failureCriteria}`
    : "";

  // Carry-forward progress note: a compact list of what prior subtasks wrote.
  // Lives in the static system prompt so it survives message windowing.
  const completedSubtasks = (state.subtasks || []).slice(
    0,
    state.currentSubtaskIndex || 0,
  );
  const progressNote =
    completedSubtasks.length > 0
      ? `\n[PRIOR SUBTASKS COMPLETED - do not re-create these files]\n${completedSubtasks
          .map((s) => {
            const filesStr =
              s.files?.length > 0 ? ` → wrote: ${s.files.join(", ")}` : "";
            return `  ✓ Subtask ${s.id}: ${s.task}${filesStr}`;
          })
          .join("\n")}\n`
      : "";

  // Actual files modified by prior subtasks — more reliable than planned file lists
  // since they reflect what the coder actually wrote, not what was projected.
  // Only shown when we're past the first subtask and something was actually written.
  const allModifiedFilesNote = (state.allModifiedFiles?.length > 0 && (state.currentSubtaskIndex || 0) > 0)
    ? `\n[ACTUALLY MODIFIED FILES — written by prior subtasks]\n${state.allModifiedFiles.map((f) => `  - ${f}`).join("\n")}\nDo not recreate these from scratch unless the subtask explicitly requires replacing them.\n`
    : "";

  // Project constraints and research summary go in the static system prompt
  // so they survive the tail-window truncation of the message history.
  const constraintsSection = state.projectConstraints
    ? `\n${state.projectConstraints}\n`
    : "";

  // For new_project tasks: reinforce that all files must be CREATED, not found.
  // Also inject a concrete first-write target so the coder doesn't spend turns
  // reading existing project files (package.json etc.) before writing.
  let newProjectSection = "";
  if (state.taskType === "new_project") {
    const firstPlannedFile = currentSubtask?.files?.[0];
    const firstWriteTarget = firstPlannedFile
      ? (path.isAbsolute(firstPlannedFile) ? firstPlannedFile : path.join(state.projectDir, firstPlannedFile))
      : null;
    const firstWriteHint = firstWriteTarget
      ? `\n⚡ FIRST ACTION: Your very first tool call MUST be:\n` +
        `[{ "tool": "write_file", "path": "${firstWriteTarget}", "content": "...full file content..." }]\n` +
        `Do NOT call list_dir, read_file, or any other tool before this write_file.\n`
      : "";

    // Inject key project config files so the coder doesn't need to read them
    let injectedConfigs = "";
    if (state.projectDir) {
      const configFiles = ["package.json", "tsconfig.app.json", "tsconfig.json", "vite.config.ts", "vite.config.js"];
      const snippets = [];
      for (const cf of configFiles) {
        try {
          const cfPath = path.join(state.projectDir, cf);
          const content = await readFile(cfPath, "utf8");
          // Only inject small config files (< 2000 chars) to avoid bloating the prompt
          if (content.length < 2000) {
            snippets.push(`// ${cf}\n${content.slice(0, 1500)}`);
          }
        } catch { /* file doesn't exist — skip */ }
        if (snippets.length >= 2) break; // max 2 config files
      }
      if (snippets.length > 0) {
        injectedConfigs = `\n[PROJECT CONFIG — already on disk, do NOT read_file these]\n${snippets.join("\n\n")}\n`;
      }
    }

    newProjectSection =
      `\n⚠️ NEW PROJECT MODE — You are building a brand-new application from scratch.\n` +
      `- Every file in this subtask must be CREATED with write_file — there is no existing code to patch.\n` +
      `- If a file already exists (e.g. App.tsx with Vite defaults), REPLACE it entirely with write_file.\n` +
      `- Do NOT output prose descriptions of what you would write — use actual write_file tool calls.\n` +
      `- After creating files, run npm run build (or equivalent) to verify there are no compile errors.\n` +
      firstWriteHint + injectedConfigs;
  }

  const coderDirective = buildCoderDirective(state.projectType);

  const researchSection = state.researchSummary
    ? `\n[KEY RESEARCH FINDINGS - read before implementing]\n${state.researchSummary}\n`
    : "";

  // Prefer the Scoper's verified Scope Document over the raw research summary.
  // Strip any paths the scoper flagged as unverified - the coder must never
  // receive phantom paths that it will try to edit and fail to find.
  const _strippedScope = state.scopeDocument
    ? state.scopeDocument
        .split("\n")
        .filter((l) => !/⚠️\s*(NOT YET VERIFIED|NOT FOUND)/i.test(l))
        .join("\n")
    : "";
  const scopeSection = _strippedScope
    ? `\n[SCOPE DOCUMENT - verified file paths and line numbers from Scoper]\n${
        _strippedScope.length > 8000
          ? _strippedScope.slice(0, 8000) +
            "\n...[scope truncated - use read_file to get more detail if needed]"
          : _strippedScope
      }\n`
    : "";
  // On stall retries the model has already seen the full scope and the extra
  // 6 000+ chars of context may push it toward prose mode.  Cut to 2 000 chars
  // and tell it to use read_file if more detail is needed.
  // isStallRetry is computed below from coderRetryCount + lastCoderResponse.

  // Inject procedural knowledge from prior sessions so the coder sees known
  // fix recipes and commands without having to rediscover them.
  let proceduralSection = "";
  if (state.projectDir) {
    try {
      const procedural = await loadProceduralKnowledge(state.projectDir);
      if (procedural) {
        proceduralSection = `\n[PROJECT PROCEDURAL KNOWLEDGE - fix recipes and commands from prior sessions]\n${procedural.slice(0, 3000)}\n`;
      }
    } catch { /* non-fatal */ }
  }

  // Pre-resolve the local dev URL for web projects so the AI has a concrete URL
  // to use for http_request calls — not instructions to "discover it yourself".
  // Without this, models sometimes fall back to the live production URL instead.
  let localDevUrlSection = "";
  if (state.projectDir && (state.projectType === "silverstripe" || state.projectType === "php")) {
    try {
      const resolved = await resolveProjectUrl(state.projectDir);
      if (resolved.verified) {
        localDevUrlSection = `\n[LOCAL DEV URL — USE THIS FOR ALL http_request CALLS]\nThe verified local development URL for this project is: ${resolved.url}\nDiscovered via: ${resolved.source}\n⚠️ CRITICAL: Use ONLY this URL for ALL http_request verification calls. NEVER use the live production URL (e.g. https://thescopes.org or any https:// domain that is not .local or localhost). The production site has authentication and does NOT reflect local code changes.\nCorrect: http_request(url="${resolved.url}/?flush=1")\n`;
      }
    } catch { /* non-fatal */ }
  }

  const ragSection = "";

  // Environment report from environmentNode — pre-flight baseline check.
  // Injected always (not just first attempt) so the coder knows if pre-existing
  // errors exist and can distinguish them from errors caused by their own writes.
  const environmentSection = state.environmentReport
    ? `\n[ENVIRONMENT BASELINE — checked before first implementation turn]\n${state.environmentReport}${
        state.preExistingErrors?.length > 0
          ? `\n\n⚠️ PRE-EXISTING ERRORS: The following issues existed BEFORE any code was written.\nSmoke test failures may be caused by these pre-existing issues, NOT by your changes.\n${state.preExistingErrors.map((e) => `  ${e}`).join("\n")}`
          : "\n✓ Environment was healthy before implementation began."
      }\n`
    : "";

  // Retrieved context from past sessions (contextRetrieverNode).
  // Inject only on the first attempt — on retries, the coder already has this context
  // and it would just add noise alongside retry-specific feedback.
  const retrievedContextSection = (state.retrievedContext && (state.coderRetryCount ?? 0) === 0)
    ? `\n[RETRIEVED KNOWLEDGE — lessons from past sessions on this project]\n${state.retrievedContext}\n`
    : "";

  // Cross-session reflexion lessons (Shinn et al. 2023) — loaded from docs/memory/reflexion.md
  // by contextRetrieverNode and persisted there by memoryUpdateNode at session end.
  // Distinct from per-subtask reflexionMemory: these are project-level failure patterns
  // accumulated across all past sessions, not just the current one.
  const crossSessionReflexionSection = (state.reflexionContext && (state.coderRetryCount ?? 0) === 0)
    ? `\n[CROSS-SESSION LESSONS — failure patterns from prior sessions on this project]\n${state.reflexionContext}\nApply these lessons — do not repeat the same mistakes.\n`
    : "";

  // Benchmark: inject check.js content on the first attempt so the coder sees exactly
  // which names to export and what behaviour each test asserts. On retries, TAP failure
  // output is already in the conversation via lastCoderResponse — no need to re-inject.
  let testContractBlock = "";
  if (state.benchmarkScenarioId && (state.coderRetryCount ?? 0) === 0) {
    try {
      const checkPath = path.join(
        process.cwd(), "projects/benchmark", state.benchmarkScenarioId, "check.js"
      );
      const src = await readFile(checkPath, "utf8");
      testContractBlock = `\n\n## ACCEPTANCE TESTS (check.js — your implementation must pass ALL of these)\n\`\`\`js\n${src.slice(0, 3000)}\n\`\`\`\nStudy the imports: they tell you exactly what names and types to export. Study each assertion: they define the exact behaviour required. Ensure your module uses ESM export syntax matching the import.\n`;
    } catch { /* non-fatal — check.js not found */ }
  }

  // Declared here so it's available to both criticSection and reflexionSection below.
  const currentSubtaskIdx = state.currentSubtaskIndex || 0;

  // Critic report from criticNode — adversarial pre-flight risk analysis produced
  // once per planning pass. Extract only the sections relevant to the current subtask
  // so each subtask sees its own warnings rather than the full plan-level report.
  // Injected on the first attempt of EACH subtask (not only subtask 0) since the
  // critic analyzes the whole plan and its per-subtask warnings are valid throughout.
  const criticSection = (state.criticReport && (state.coderRetryCount ?? 0) === 0)
    ? (() => {
        const relevantWarnings = extractSubtaskCriticSection(
          state.criticReport,
          currentSubtaskIdx,
          currentSubtask,
        );
        return relevantWarnings
          ? `\n[CRITIC REVIEW — risks specific to this subtask]\n${relevantWarnings}\n`
          : "";
      })()
    : "";

  // Debug report from debuggerNode - injected when the coder is retrying after
  // targeted root-cause investigation. Contains ROOT CAUSE, EVIDENCE, FIX TARGET.
  const debugSection = state.debugReport
    ? `\n[DEBUG REPORT - root cause identified by Debugger Agent]\n${state.debugReport}\n\nACTION REQUIRED: Address the root cause above. Do not re-attempt the same fix that already failed.\n`
    : "";

  // Reflexion memory: verbal lessons from prior failed attempts at THIS subtask.
  // Shinn et al. (2023) — verbal reinforcement helps the coder avoid repeating failures.
  // Scoped strictly to the current subtask: cross-subtask lessons belong in docs/memory/
  // (written by memoryUpdateNode and loaded by contextRetrieverNode next session).
  // Leaking lessons from other subtasks adds noise and can cause the coder to apply
  // fixes from unrelated failures to a different problem.
  const reflexionSection = state.reflexionMemory?.length > 0
    ? (() => {
        const subtaskLessons = state.reflexionMemory
          .filter((m) => (m.subtaskIndex ?? 0) === currentSubtaskIdx)
          .slice(-4)
          .map((m) => `• ${m.lesson}`)
          .join("\n");
        return subtaskLessons
          ? `\n[REFLEXION — LESSONS FROM PRIOR ATTEMPTS AT THIS SUBTASK]\n${subtaskLessons}\n`
          : "";
      })()
    : "";

  // ── Constitutional AI hazard section ────────────────────────────────────────
  // Generated per-subtask from known failure patterns; injected into system prompt
  // BEFORE the scope section so the coder sees it at maximum attention weight.
  const hazardSection = buildSubtaskHazards(currentTask, currentSubtask, state.projectType);

  // ── Process Reward Model (PRM) signal ─────────────────────────────────────
  // Lightman et al. 2023 — surface a productivity signal when the prior turn
  // made NO file writes. Repeated read-only turns without writes indicate the
  // coder is stuck in a planning/reading loop. Alert early to break it.
  const lastTools = state.lastToolsExecuted || [];
  const hadWriteLastTurn = lastTools.some((t) => /write_file|patch_file|apply_diff|delete_file/i.test(t));
  const processRewardNote = (state.coderRetryCount ?? 0) >= 1 && !hadWriteLastTurn && lastTools.length > 0
    ? `\n[PROCESS REWARD SIGNAL — ZERO WRITE PRODUCTIVITY DETECTED]\n` +
      `Your previous attempt called ${lastTools.length} tool(s) but wrote ZERO files.\n` +
      `Tools executed: ${lastTools.join(", ")}\n` +
      `Reading files repeatedly is non-productive (score 0.5/read vs 1.0/write).\n` +
      `This turn MUST include at least one write_file or patch_file call or it will be rejected.\n`
    : "";

  // ── Tool Reward Feedback (PRM — Lightman et al. 2023) ────────────────────
  // Aggregate per-tool reward scores accumulated across this session's turns.
  // On retry, surface tools that consistently yielded low reward so the coder
  // can switch strategy. Only injected on retry turns (retryCount >= 1).
  const toolEfficiencyNote = (() => {
    if ((state.coderRetryCount ?? 0) < 1 || !state.toolRewardLog?.length) return "";
    const byTool = {};
    for (const { tool, score } of state.toolRewardLog) {
      if (!byTool[tool]) byTool[tool] = { total: 0, count: 0 };
      byTool[tool].total += (score ?? 0);
      byTool[tool].count += 1;
    }
    const lowValue = Object.entries(byTool)
      .filter(([, v]) => v.count >= 2 && v.total / v.count < 0.3)
      .map(([tool]) => tool);
    const highValue = Object.entries(byTool)
      .filter(([, v]) => v.total / v.count >= 0.8)
      .map(([tool]) => tool);
    if (!lowValue.length && !highValue.length) return "";
    const parts = [];
    if (lowValue.length) parts.push(`Low-productivity tools this session (≥2 calls, avg score < 0.3): ${lowValue.join(", ")} — try a different approach for these.`);
    if (highValue.length) parts.push(`High-productivity tools: ${highValue.join(", ")} — prefer these.`);
    return `\n[TOOL REWARD FEEDBACK — switch strategy for low-productivity tools]\n${parts.join("\n")}\n`;
  })();

  // Retry context: when the coder is on a retry, surface the classified failure
  // reason so the coder knows what kind of problem to address (code error vs
  // environment issue) rather than guessing a "different strategy" blindly.
  const retryCount = state.coderRetryCount ?? 0;
  // Detect stall retries (TURN_SKIPPED) so the reflexion message can explain
  // that the previous turn produced prose instead of tool calls (Shinn et al. 2023).
  const isStallRetry = retryCount > 0 && (state.lastCoderResponse?.includes("TURN_SKIPPED") ?? false);
  let retrySection = "";
  if (retryCount > 0 && state.lastCoderResponse) {
    const prevSummary = state.lastCoderResponse.slice(0, 400);

    // Classify execution errors from the last turn.
    const lastErrors = state.lastExecutionErrors || [];
    const envErrors = lastErrors.filter((e) => classifyEnvironmentError(e.summary) !== null);
    const codeErrors = lastErrors.filter((e) => classifyEnvironmentError(e.summary) === null);

    let failureClassification = "";
    if (envErrors.length > 0 && codeErrors.length === 0) {
      // All errors are environment-level - code changes won't help.
      const envTypes = [...new Set(envErrors.map((e) => classifyEnvironmentError(e.summary).description))];
      failureClassification = `FAILURE TYPE: ENVIRONMENT ISSUE (not fixable by code changes)
${envTypes.map((d) => `  • ${d}`).join("\n")}
→ Do NOT try to fix these errors with code. Note the limitation in your summary and focus on confirming the code change itself is correct.`;
    } else if (codeErrors.length > 0) {
      failureClassification = `FAILURE TYPE: CODE ERROR - fix the following:
${codeErrors.map((e) => `  [${e.tool}] ${e.summary.slice(0, 200)}`).join("\n")}`;
    } else if (isStallRetry) {
      // Stall reflexion: the model output prose instead of tool calls.
      // Explicitly name the failure and show the correct output format so the
      // model does not repeat the same pattern (Shinn et al. 2023 Reflexion).
      failureClassification =
        `FAILURE TYPE: STALL — your previous turn output PROSE instead of tool calls.\n` +
        `The pipeline discarded your text response. No files were written. The task has not progressed.\n\n` +
        `ROOT CAUSE: You wrote code or explanatory text as markdown/plain text in your response.\n` +
        `Prose output is INVISIBLE to the file system — it is discarded immediately after your turn ends.\n\n` +
        `REQUIRED ACTION: Your FIRST token must begin a JSON tool call array:\n` +
        `[\n  { "tool": "write_file", "path": "/abs/path/file.ts", "content": "export function..." }\n]\n` +
        `Do NOT output any text before "[". Start the JSON array immediately.`;
    } else {
      failureClassification = "FAILURE TYPE: No files written or execution tool not called - execute the required change immediately.";
    }

    // After the first retry, remind the model that the <tool-plan> tag must be
    // followed IMMEDIATELY by the JSON tool call array. The original wording
    // ("ONLY JSON") contradicted the <tool-plan> protocol and caused models to
    // output the plan tag alone, treating it as the entire required output.
    const jsonOnlyReminder = retryCount >= 1
      ? `\n⚠️ MANDATORY ON RETRY: After your <tool-plan> block, you MUST IMMEDIATELY output the JSON tool call array. Example:\n<tool-plan>\nGoal: patch the file\nSteps: read_file, patch_file\n</tool-plan>\n[{"tool":"patch_file","path":"/abs/path","search_block":"...","replace_block":"..."}]\nDo NOT output the <tool-plan> tag alone — it does nothing without the following JSON array. The file is NOT written until a JSON tool call executes it.\n`
      : "";

    // ── Strategy Diversification ─────────────────────────────────────────────
    // AlphaCode diversity sampling + Tree-of-Thought (Yao et al. 2023):
    // each retry level uses a fundamentally different approach to escape failure
    // loops. Repeatedly applying the same strategy after it has already failed
    // is suboptimal — varying the approach surfaces different solution paths.
    let strategyHint = "";
    if (retryCount === 1) {
      strategyHint =
        `\n[STRATEGY SHIFT — RETRY ${retryCount + 1} — TOOL SWITCH]\n` +
        `Your previous approach failed. Switch tools:\n` +
        `• If you used patch_file → switch to write_file (complete file replacement).\n` +
        `• If you used write_file → re-read the file with read_file first, then patch_file the specific target section.\n` +
        `Re-read ALL files this subtask touches — do NOT rely on your memory of their contents.\n`;
    } else if (retryCount === 2) {
      strategyHint =
        `\n[STRATEGY SHIFT — RETRY ${retryCount + 1} — FRESH DERIVATION]\n` +
        `Two prior attempts failed. ABANDON your current approach entirely.\n` +
        `Use read_file on EVERY file in this subtask — even ones you have read before.\n` +
        `Derive the solution ONLY from what you read now, not from memory or prior attempts.\n` +
        `Use write_file for complete file replacements to avoid stale patch_file search_block mismatches.\n`;
    } else if (retryCount >= 3 && !state.debugReport) {
      strategyHint =
        `\n[STRATEGY SHIFT — RETRY ${retryCount + 1} — MINIMAL CHANGE MODE]\n` +
        `Multiple attempts have failed. Apply MINIMAL CHANGE:\n` +
        `1. Target ONLY the exact error reported in [VERIFIER AUTOMATED FEEDBACK].\n` +
        `2. Make the SMALLEST patch that fixes that single error. Do NOT refactor or add anything else.\n` +
        `3. Use patch_file with the smallest search_block that uniquely identifies the target.\n` +
        `4. After writing, verify with swiftc -typecheck or equivalent before declaring done.\n`;
    }

    retrySection = `\n[RETRY CONTEXT - attempt ${retryCount + 1}]
Previous attempt summary: ${prevSummary}
${failureClassification}${jsonOnlyReminder}${strategyHint}
Do NOT repeat an approach that has already failed - choose a different strategy based on the failure type above.\n`;
  }

  // On stall retries truncate the scope doc aggressively — the model has already
  // seen the full version and the extra context may contribute to prose overflow.
  const effectiveScopeSection = isStallRetry && _strippedScope
    ? `\n[SCOPE DOCUMENT — truncated for stall retry; use read_file for full details]\n${_strippedScope.slice(0, 2000)}\n...[scope truncated — use read_file if more detail is needed]\n`
    : scopeSection;

  const systemPrompt = `You are an expert Software Engineer.
Your job is ONLY to implement the current assigned SUBTASK.
${constraintsSection}${newProjectSection}
[OVERALL EXECUTION PLAN]
${state.executionPlan}
${progressNote}${allModifiedFilesNote}
[YOUR CURRENT SUBTASK]
${currentTask}${subtaskFilesNote}${subtaskLineRangeNote}${subtaskImplNote}${subtaskConstraintsNote}${subtaskAcceptanceCriteria}${subtaskFailureCriteria}${hazardSection}${reactScaffoldWarning}${testContractBlock}
${processRewardNote}${toolEfficiencyNote}${effectiveScopeSection || researchSection}${localDevUrlSection}${proceduralSection}${ragSection}${environmentSection}${retrievedContextSection}${crossSessionReflexionSection}${criticSection}${debugSection}${reflexionSection}${retrySection}
Instructions:
- [TOOL PLANNING PROTOCOL] At the very start of your response, output a brief intent block:\n<tool-plan>\nGoal: <one line — what this subtask achieves>\nSteps: <3-5 tool names in the order you plan to call them, comma-separated>\n</tool-plan>\nThen immediately proceed with the tool calls.
- Use the appropriate tools (write_file, patch_file, read_file) via strict JSON tool calling.
- CRITICAL - PROSE OUTPUT IS NOT A FILE WRITE: If your task requires creating or modifying a file, you MUST use a write_file or patch_file tool call. Printing file content as text in your response does NOT create the file - the content will appear in the chat and be immediately discarded. The file will NOT exist on disk. You MUST output a JSON tool call: [{"tool": "write_file", "path": "/abs/path", "content": "..."}]
${diagnosticsInstruction}- Do not deviate from the current subtask.
- NEVER write, patch, delete, or diff files inside vendor/, node_modules/, or .git/ - these directories are managed by package managers and must not be modified manually.
- READ-AFTER-WRITE: After writing or patching any YAML, JSON, XML, or config file, immediately re-read it using read_file to verify the content - especially indentation, which is invisible in write output. Correct any formatting issues before proceeding.
- COMMAND OUTPUT ANALYSIS: After running any command tool (run_sake, run_composer, run_phpunit, execute_bash, run_npm), read the output carefully. If you see a non-zero exit code, "Fatal error:", "Parse error:", "Uncaught Exception", or "npm ERR!" - the command FAILED. You must fix the root cause and re-run before declaring the subtask complete.
${coderDirective}
- EXISTING FILES: For files that already exist and need changes, use patch_file with the smallest search_block that uniquely identifies the target location. write_file is for new files. EXCEPTION: config files like .gitignore, README.md, package.json — if they already exist with acceptable content and no changes are needed, emit "NO_CHANGES_NEEDED": true rather than outputting prose. Never output a prose explanation instead of a tool call.
- TOOL ARG ENCODING: In ALL tool call arguments (content, search_block, replace_block, diff_content): NEVER HTML-encode characters. Use literal characters - => not &gt;, -> not -&gt;, < not &lt;, > not &gt;, & not &amp;.
- INVESTIGATION SUBTASKS: For tasks beginning with "REVIEW:", "LOCATE", "FIND", "IDENTIFY", "VERIFY THAT", or "ENSURE NO" - you PASS by reading the target file(s) with read_file and quoting the specific line(s) that confirm or deny the requirement. Do NOT write a .md documentation file to record your findings. Do NOT write any new file at all unless the scope explicitly requires it.
${buildAcceptanceTestDirective(state.projectType)}
- REFLEXION: Before completing any fix subtask, ask yourself: "Did I actually verify that the error is gone, or did I just write what I think the fix should be?" If you have not run the affected command and confirmed clean output, you have not completed the task.
- FILE OPERATION REQUIREMENT: If this subtask requires code changes (implementation, fix, refactor, etc.), you MUST produce at least one write_file or patch_file tool call. If you genuinely cannot make any change (e.g., the code is already correct), you MUST output a JSON field at the end of your response: \"NO_CHANGES_NEEDED\": true. Do NOT output this flag if you wrote any files.
- After executing, summarize your changes so the verifier can assess them.`;

  // Tail window size: reduce aggressively on high retry counts to prevent
  // context bloat from repeated error messages pushing the model into
  // explanation/prose mode instead of JSON tool-call mode.
  const TAIL_SIZE = retryCount >= 3 ? 8 : retryCount >= 2 ? 12 : 20;
  const allMessages = state.messages;
  let windowedMessages;
  if (allMessages.length <= TAIL_SIZE + 1) {
    windowedMessages = allMessages;
  } else {
    const omitted = allMessages.length - 1 - TAIL_SIZE;
    windowedMessages = [
      allMessages[0],
      {
        role: "user",
        content: `[${omitted} earlier message(s) omitted to save context window. Use read_file if you need file contents again.]`,
      },
      ...allMessages.slice(-TAIL_SIZE),
    ];
  }

  // Raised truncation limit - C# files regularly exceed 4000 chars.
  const prunedMessages = windowedMessages.map((msg) => {
    if (typeof msg.content === "string" && msg.content.length > 8000) {
      return {
        ...msg,
        content:
          msg.content.substring(0, 2000) +
          `\n...[CONTENT TRUNCATED - use read_file to retrieve full content if needed]...\n` +
          msg.content.substring(msg.content.length - 400),
      };
    }
    return msg;
  });

  const messages = [
    { role: "system", content: systemPrompt },
    ...prunedMessages,
  ];

  let fullText = "";
  let resolvedTools = [];
  let modifiedFiles = [];
  let executionErrors = [];

  const signal = config?.signal ?? null;
  const context = { rootDir: state.projectDir, ignore: state.ignore, allowedDirs: state.contextDirs || [], signal, projectConfig: state.project };
  if (state.model) {
    const { textStream, toolCalls } = streamText({
      model: state.model,
      messages,
      tools: /** @type {import('ai').ToolSet} */ (await getMcpBoundTools(context)),
      maxSteps: getCoderMaxSteps(state.projectType, MAX_STEPS_CODER, MAX_STEPS_CODER_UNITY),
      abortSignal: signal,
    });

    for await (const part of textStream) {
      fullText += part;
      eventBus.emit("message_chunk", { chunk: part });
    }
    eventBus.emit("message_complete", {});

    resolvedTools = await toolCalls;

    modifiedFiles = (resolvedTools || [])
      .filter((tc) =>
        [
          "write_file",
          "patch_file",
          "apply_diff",
          "delete_file",
          "move_file",
        ].includes(tc.toolName),
      )
      .map((tc) => tc.args?.path || tc.args?.destination)
      // Filter out placeholder paths that the AI echoes from system prompt examples
      .filter((p) => Boolean(p) && p !== "/abs/path" && !/^\/abs\//.test(p) && p !== "/path/to/file" && !/^\/absolute\//.test(p) && !p.includes("/path/to/your/"));
  } else {
    // Tick the spinner every 10 s so the UI shows elapsed turn time.
    // The Vercel AI SDK path streams natively; the automation-api path is silent.
    const _coderTurnStart = Date.now();
    const _coderTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - _coderTurnStart) / 1000);
      const label = `Coder Agent - waiting for AI response (${elapsed}s)...`;
      dashboardState.aiStatus = label;
      eventBus.emit("spinner_update", { status: label });
    }, 10000);

    let result;
    try {
      result = await state.provider.sendTurn(messages, "coder", context);
    } finally {
      clearInterval(_coderTicker);
    }

    if (!result.ok) {
      const isContentRejected = result.reason?.includes("CONTENT_REJECTED");
      const isBusy =
        !isContentRejected &&
        (result.reason?.includes("SESSION_BUSY") ||
          result.reason?.includes("TURN_SKIPPED"));

      log(
        colors.yellow(
          `  [Graph] -> Coder turn failed (${result.reason}). Resetting to last checkpoint...`,
        ),
      );
      const resetResult = await gitResetHard(state.projectDir);
      if (resetResult.ok) {
        log(colors.dim("  [Graph] -> Reset to last checkpoint complete."));
      } else {
        log(colors.yellow(`  [Graph] -> Could not reset to checkpoint: ${resetResult.error}`));
      }

      if (isBusy) {
        // Exponential backoff: each consecutive STALL waits longer.
        // retry 0 → 15s, retry 1 → 30s, retry 2 → 60s, retry 3+ → 120s
        const retryCount = state.coderRetryCount ?? 0;
        const stallCount = (state.consecutiveStallCount ?? 0) + 1;
        const waitMs = Math.min(15000 * Math.pow(2, retryCount), 120000);
        log(
          colors.dim(
            `  [Graph] -> Session busy (stall ${stallCount}) - waiting ${waitMs / 1000}s before retrying...`,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));

        // Nuclear override: after 3+ consecutive stalls, send a minimal bare-JSON
        // prompt with zero prose so the provider cannot produce prose-only output.
        // (Bumped from 2 → 3 to allow one more normal retry — short stalls are
        // common and don't always indicate the provider is truly stuck.)
        if (stallCount >= 3) {
          log(colors.yellow(
            `  [Graph] -> ANTI-STALL NUCLEAR OVERRIDE after ${stallCount} consecutive stalls`,
          ));
          const bareTask = state.subtasks?.[state.currentSubtaskIndex]?.task || "complete the subtask";
          return {
            messages: [{
              role: "user",
              content: `OUTPUT ONLY THIS JSON ARRAY, NOTHING ELSE:\n[{"tool":"write_file","input":{"path":"<file path>","content":"<file content>"}}]\n\nTask: ${bareTask}`,
            }],
            modifiedFiles: [],
            lastCoderResponse: `[STALL NUCLEAR OVERRIDE ${stallCount}]`,
            lastToolsExecuted: [],
            lastExecutionErrors: [],
            coderFailed: true,
            consecutiveStallCount: stallCount,
          };
        }

        return {
          messages: [{
            role: "user",
            content: `[CODER TURN FAILED - REVERTED TO CHECKPOINT]\nReason: ${result.reason}\n\nAll partial changes have been reverted to the last verified checkpoint. You MUST retry the current subtask using write_file or patch_file tools.`,
          }],
          modifiedFiles: [],
          lastCoderResponse: `[CODER TURN FAILED] ${result.reason}`,
          lastToolsExecuted: [],
          lastExecutionErrors: [],
          coderFailed: true,
          consecutiveStallCount: stallCount,
        };
      }

      const failureMessage = isContentRejected
        ? `[CODER TURN FAILED - CONTENT POLICY REJECTION]\nThe previous prompt was blocked by the provider's content filter.\n\nYou MUST retry the current subtask using a different approach: rephrase your tool calls and avoid content that may trigger the filter.`
        : `[CODER TURN FAILED - REVERTED TO CHECKPOINT]\nReason: ${result.reason}\n\nAll partial changes have been reverted to the last verified checkpoint. You MUST retry the current subtask using write_file or patch_file tools.`;

      return {
        messages: [
          {
            role: "user",
            content: failureMessage,
          },
        ],
        modifiedFiles: [],
        lastCoderResponse: `[CODER TURN FAILED] ${result.reason}`,
        lastToolsExecuted: [],
        lastExecutionErrors: [],
        coderFailed: true,
      };
    }

    fullText = result.text ?? "";
    resolvedTools = result.toolCalls ?? [];

    modifiedFiles = result.modifiedFiles ?? [];
    executionErrors = result.executionErrors ?? [];
    eventBus.emit("message_complete", {});

    // ── Inline prose-output detection ────────────────────────────────────────
    // When the provider returns a long text response with zero tool calls, the
    // model output file content as prose instead of calling write_file/patch_file.
    // Rather than waiting for a full verifier round-trip (3-4 wasted retries per
    // subtask), inject a "USE TOOLS" nuclear message and retry immediately.
    // Only fires once per turn (no infinite retry here — just one extra attempt).
    if (resolvedTools.length === 0 && fullText.length > 300) {
      // Detect prose file content: markdown code fences, YAML structure,
      // or indented code blocks that indicate the model wrote out file content.
      const looksLikeFileContent =
        /^```[\w\s]/m.test(fullText) ||       // markdown code fence
        /^---\s*$/m.test(fullText) ||          // YAML document separator
        /^\s{2,}\w+:/m.test(fullText) ||       // indented YAML key
        /^\s*(class|function|public|private|protected|namespace|use|import|require)\s/m.test(fullText) ||
        /^<\?php\b/m.test(fullText) ||         // PHP open tag
        /^<%-?\s*(if|loop|with)\b/m.test(fullText) || // SS template tag
        /^[.#]?[\w-]+\s*\{[\s\S]*?[\w-]+\s*:/m.test(fullText) || // CSS rule block
        /^\s+[\w-]+\s*:\s+[^;{]+;/m.test(fullText); // CSS property declaration

      if (looksLikeFileContent) {
        log(colors.yellow(
          `  [Graph] -> Prose-output detected (${fullText.length} chars, 0 tool calls) — injecting nuclear retry`,
        ));
        eventBus.emit("system_message", {
          text: `⚠️ Coder output prose instead of tool calls — auto-retrying with direct instruction`,
          type: "warning",
        });

        const bareTask = state.subtasks?.[state.currentSubtaskIndex]?.task || "complete the subtask";
        const nuclearMessages = [
          ...messages,
          { role: "assistant", content: fullText },
          {
            role: "user",
            content: `YOU OUTPUT FILE CONTENT AS PLAIN TEXT INSTEAD OF USING TOOL CALLS. This is wrong.\n\nDo NOT describe what you will do. Do NOT write file content in your response text.\nIMMEDIATELY call write_file or patch_file with the content as a tool argument — nothing else.\n\nTask: ${bareTask}`,
          },
        ];

        try {
          const nuclearResult = await state.provider.sendTurn(nuclearMessages, "coder", context);
          if (nuclearResult?.ok && (nuclearResult.toolCalls?.length ?? 0) > 0) {
            log(colors.cyan(
              `  [Graph] -> Nuclear prose-retry succeeded (${nuclearResult.toolCalls.length} tool call(s))`,
            ));
            fullText = nuclearResult.text ?? fullText;
            resolvedTools = nuclearResult.toolCalls;
            modifiedFiles = nuclearResult.modifiedFiles ?? [];
            executionErrors = nuclearResult.executionErrors ?? [];
          } else {
            log(colors.yellow(`  [Graph] -> Nuclear prose-retry also produced no tool calls — continuing to verifier`));
          }
        } catch (nuclearErr) {
          log(colors.yellow(`  [Graph] -> Nuclear prose-retry failed (${nuclearErr.message}) — continuing`));
        }
      }
    }
  }

  const lastToolsExecuted = (resolvedTools || [])
    .map((tc) => tc.tool || tc.toolName || tc.name)
    .filter(Boolean);

  // ── Tool Plan parsing ──────────────────────────────────────────────────────
  // Extract the <tool-plan> block the coder outputs at the start of its response.
  let parsedToolPlan = null;
  const toolPlanMatch = fullText.match(/<tool-plan>([\s\S]*?)<\/tool-plan>/i);
  if (toolPlanMatch) {
    const raw = toolPlanMatch[1];
    const goalMatch = raw.match(/goal:\s*(.+)/i);
    const stepsMatch = raw.match(/steps:\s*(.+)/i);
    parsedToolPlan = {
      goal: goalMatch?.[1]?.trim() || "",
      steps: stepsMatch?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) || [],
      subtaskIndex: state.currentSubtaskIndex ?? 0,
      t: Date.now(),
    };
    eventBus.emit("tool_plan_update", parsedToolPlan);
  }

  // ── Process Reward Modeling ────────────────────────────────────────────────
  // Score each tool call by productivity: writes > execution > first reads > repeated reads.
  // Emits tool_reward_update per call and accumulates in state for UI visualisation.
  const recentReads = new Set();
  const toolRewardEntries = [];
  for (const tc of resolvedTools || []) {
    const name = (tc.tool || tc.toolName || tc.name || "").toLowerCase();
    const args = tc.args || tc.input || {};
    const filePath = args.path || args.file_path || args.filepath || "";

    let score;
    if (/write_file|patch_file|apply_diff|delete_file|move_file/.test(name)) {
      score = 1.0;
    } else if (/execute_bash|run_sake|run_composer|run_phpunit|run_npm/.test(name)) {
      score = 0.8;
    } else if (/read_file|list_dir|grep|find|search|list_files/.test(name)) {
      score = filePath && recentReads.has(filePath) ? 0.1 : 0.5;
      if (filePath) recentReads.add(filePath);
    } else {
      score = 0.4;
    }

    const entry = { tool: name, score, t: Date.now() };
    toolRewardEntries.push(entry);
    eventBus.emit("tool_reward_update", { subtaskIndex: state.currentSubtaskIndex ?? 0, ...entry });
  }

  if (modifiedFiles.length > 0) {
    // Accumulate all modified files across subtasks for the dashboard areas view.
    const allModified = Array.from(new Set([
      ...(dashboardState.modifiedFiles || []),
      ...modifiedFiles,
    ]));
    dashboardState.modifiedFiles = allModified;
    eventBus.emit("files_modified", { files: allModified });
  }

  return {
    messages: [{ role: "assistant", content: fullText }],
    modifiedFiles,
    lastCoderResponse: fullText,
    lastToolsExecuted,
    lastExecutionErrors: executionErrors,
    coderFailed: false,
    currentPersona: PERSONA.id,
    toolPlan: parsedToolPlan,
    toolRewardLog: toolRewardEntries,
    consecutiveStallCount: 0, // reset on successful turn
  };
}
