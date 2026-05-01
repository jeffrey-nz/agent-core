import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { runAdvancedValidator } from "#copilot/run/main/applyFilesPhase/advancedValidator.js";
import { detectAuthRedirect } from "#agent/tools/http.js";
import { execAsync } from "#utils/exec.js";
import { gitResetHard } from "#utils/gitReset.js";
import { eventBus } from "#web/eventBus.js";
import { dashboardState } from "#app/ui/dashboard.js";
import { personaMeta } from "../personas.js";
import { parseStackTrace, formatParsedError } from "#utils/stackTraceParser.js";
import { classifyEnvironmentError, classifyHttpResponseError, classifyClassReferenceError } from "#agent/utils/executionOutputAnalysis.js";
import { MAX_VERIFIER_RETRIES, DEBUGGER_TRIGGER_RETRIES } from "#config/pipeline.js";
import { UNITY_ASSET_EXTENSIONS as _UNITY_ASSET_EXTENSIONS, SWIFT_ASSET_EXTENSIONS as _SWIFT_ASSET_EXTENSIONS, BUILD_COMMAND_RE } from "#utils/projectDirectives.js";
import { getLastSmokeScreenshot } from "../smokeScreenshotStore.js";

const PERSONA = personaMeta("verifier");

async function closeSubIssueForSubtask(state) {
  const { githubOptions, subtaskIssueMap, subtasks, currentSubtaskIndex } = state;
  if (!githubOptions || !subtaskIssueMap) return;
  const subtask = subtasks?.[currentSubtaskIndex];
  if (!subtask) return;
  const subIssueNumber = subtaskIssueMap[String(subtask.id)];
  if (!subIssueNumber) return;
  try {
    const { closeSubIssue } = await import("#github/subIssues.js");
    await closeSubIssue({
      client: githubOptions.client,
      owner: githubOptions.owner,
      repo: githubOptions.repo,
      issueNumber: subIssueNumber,
    });
  } catch { /* non-fatal */ }
}

function writeVerificationMarker() {
  try {
    const markerPath = path.join(process.cwd(), ".verification_complete.txt");
    fs.writeFileSync(markerPath, `Verification passed at ${new Date().toISOString()}\n`);
  } catch (err) {
    // Silently fail - don't let marker writing crash the verifier
  }
}

const EXECUTION_ONLY_RE =
  /\b(run|execute|test|verify|check|confirm|baseline|validate|audit|inspect|flush|rebuild|regenerate|clear|purge|reindex|resync|restart|reload|warm|compile|transpile|deploy|migrate|seed|snapshot)\b/i;
const IMPLEMENTATION_RE =
  /\b(implement|write|create|add|build|fix|refactor|modify|update|remove|delete|install|configure)\b/i;

// Investigation/review tasks are satisfied by reading and quoting evidence -
// NOT by writing new files. The coder passes by citing the relevant code line.
const INVESTIGATION_RE =
  /^(?:REVIEW|LOCATE|FIND|SEARCH|LOOK\s+FOR|SCAN|IDENTIFY|INVESTIGATE|DISCOVER|VERIFY\s+THAT|CONFIRM\s+THAT|ENSURE\s+NO|ENSURE\s+THAT\s+NO|CHECK\s+THAT|VALIDATE\s+THAT)/i;

// Acceptance test subtasks require live HTTP evidence - not file writes.
const ACCEPTANCE_TEST_RE = /^ACCEPTANCE TEST:/i;

function isInvestigationTask(taskDescription = "") {
  return INVESTIGATION_RE.test(taskDescription.trim()) && !IMPLEMENTATION_RE.test(taskDescription);
}

// Resource-aware retry budgeting: allocate retries based on subtask complexity
// rather than a fixed global ceiling. Investigation tasks waste retries because
// the coder passes by citing code, not writing files — cap them aggressively.
function computeAdaptiveMaxRetries(subtask) {
  const desc = (subtask?.task || subtask?.description || subtask?.title || "").toLowerCase();
  const files = subtask?.files || [];
  if (INVESTIGATION_RE.test(desc.trim())) return 2;
  let budget = 3;
  budget += Math.min(files.length, 3);
  if (/migrat|refactor|restructur|replac/.test(desc)) budget += 1;
  return Math.min(budget, 7);
}

const DOCS_ONLY_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);

// Re-export from projectDirectives for use in this module.
const UNITY_ASSET_EXTENSIONS = _UNITY_ASSET_EXTENSIONS;
const SWIFT_ASSET_EXTENSIONS = _SWIFT_ASSET_EXTENSIONS;

function isDocsOnlyChange(modifiedFiles = []) {
  return (
    modifiedFiles.length > 0 &&
    modifiedFiles.every((f) => {
      const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
      return DOCS_ONLY_EXTENSIONS.has(ext);
    })
  );
}

function isUnityAssetOnlyChange(modifiedFiles = []) {
  return (
    modifiedFiles.length > 0 &&
    modifiedFiles.every((f) => {
      const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
      return UNITY_ASSET_EXTENSIONS.has(ext);
    })
  );
}

function isSwiftAssetOnlyChange(modifiedFiles = []) {
  return (
    modifiedFiles.length > 0 &&
    modifiedFiles.every((f) => {
      const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
      return SWIFT_ASSET_EXTENSIONS.has(ext);
    })
  );
}

// Expanded to cover dotnet and Unity batchmode alongside existing PHP/JS tooling.
// Framework-specific build command patterns (dev/build, db:build, sake) come from projectDirectives.
const REQUIRES_COMMAND_RE = new RegExp(
  `(?:run|execute|regenerate|rerun|re-run|perform|invoke|boot|confirm|trigger)\\s+(?:\\S+\\s+)*?(?:composer|phpunit|npm|yarn|pnpm|artisan|rake|docker|ddev|dotnet|unity|${BUILD_COMMAND_RE.source})\\b|composer\\s+(?:install|update|require|remove|dump-autoload)\\b|${BUILD_COMMAND_RE.source}\\b|dotnet\\s+(?:build|test|run|restore)\\b`,
  "i"
);

const EXECUTION_TOOL_NAMES = new Set([
  "run_composer",
  "run_phpunit",
  "execute_bash",
  "run_sake",
  "run_npm",
]);

// Detects subtasks that exist purely to verify a prior fix ran correctly.
const VERIFY_FIX_RE =
  /\b(verify|confirm|check)\b.*\b(no error|without error|succeed|succeed|pass|clean|fix|work)/i;

// Execution-only tasks that contain implementation verbs but are still
// purely command-runner steps - e.g. "Flush SilverStripe cache and rebuild manifest",
// "Rebuild the search index", "Regenerate assets". These are detected by
// EXECUTION_ONLY_RE but would be filtered out by IMPLEMENTATION_RE on "build" etc.
//
// IMPORTANT: "Run database schema build with flush" must match here even though
// "build" normally triggers IMPLEMENTATION_RE. The phrase "schema build" / "database
// schema build" is SilverStripe's name for running `sake db:build` — it is NOT a
// code-change request. Without this override the verifier demands file writes on a
// command-execution subtask and loops indefinitely.
const COMMAND_ONLY_OVERRIDE_RE =
  /\b(flush|rebuild|regenerate|clear|purge|reindex|resync|restart|reload|warm)\b.*\b(cache|manifest|index|database|db|assets|config|registry|container|server|queue)\b|\b(sake|dev\/build|db:build)\b|\b(?:schema|database)\s+build\b|\brun\b.{0,80}\b(?:db:build|sake\s+db|sake\s+dev)\b/i;

function isExecutionOnlyTask(taskDescription = "") {
  if (COMMAND_ONLY_OVERRIDE_RE.test(taskDescription)) return true;
  return (
    EXECUTION_ONLY_RE.test(taskDescription) &&
    !IMPLEMENTATION_RE.test(taskDescription)
  );
}

function calledExecutionTool(toolsExecuted = []) {
  return toolsExecuted.some((name) => EXECUTION_TOOL_NAMES.has(name));
}

function emitTaskCompleted(state) {
  const subtask = state.subtasks?.[state.currentSubtaskIndex];
  const taskId = subtask?.id;
  if (taskId == null) return;

  const steps = dashboardState.plan?.steps;
  if (steps) {
    const step = steps.find((s) => String(s.id) === String(taskId));
    if (step) step.state = "completed";
  }
  dashboardState.activeTaskId = null;
  dashboardState.completedCount = (dashboardState.completedCount || 0) + 1;

  eventBus.emit("task_state_change", { taskId, state: "completed" });
  eventBus.emit("progress_update", {
    completed: dashboardState.completedCount,
    total: dashboardState.totalCount || state.subtasks?.length || 1,
  });
}

async function commitVerifiedSubtask(projectDir, taskLabel) {
  try {
    await execAsync(`git add -A`, { cwd: projectDir });

    const status = await execAsync(`git status --porcelain`, {
      cwd: projectDir,
    });
    if (!status.stdout.trim()) return;
    const safeLabel = taskLabel.replace(/["`$\\]/g, "'").slice(0, 72);
    await execAsync(`git commit -m "${safeLabel}"`, { cwd: projectDir });
    log(colors.dim(`  [Graph] -> Committed verified subtask: ${safeLabel}`));
  } catch (e) {
    log(
      colors.yellow(`  [Graph] -> Could not auto-commit subtask: ${e.message}`),
    );
  }
}

async function archiveAndRevert(state) {
  try {
    const branchName = `failed-attempt-${Date.now()}`;

    await execAsync(`git checkout -b ${branchName}`, { cwd: state.projectDir });
    await execAsync(`git add -A`, { cwd: state.projectDir });
    const status = await execAsync(`git status --porcelain`, {
      cwd: state.projectDir,
    });
    if (status.stdout.trim()) {
      const msg = (state.messages[0]?.content || "unknown task")
        .slice(0, 40)
        .replace(/["`$\\]/g, "'");
      await execAsync(`git commit -m "debug: broken state for '${msg}'"`, {
        cwd: state.projectDir,
      });
    }
    await execAsync(`git checkout -`, { cwd: state.projectDir });
    log(colors.dim(`  [Graph] -> Broken state saved to branch: ${branchName}`));
  } catch (e) {
    log(
      colors.yellow(
        `  [Graph] -> Could not archive broken state: ${e.message}`,
      ),
    );
  }

  const resetResult = await gitResetHard(state.projectDir);
  if (!resetResult.ok) {
    log(colors.yellow(`  [Graph] -> Could not fully revert: ${resetResult.error}`));
  }
}

// ── Reflexion helpers ──────────────────────────────────────────────────────────

/**
 * Computes a 0.0–1.0 confidence score for the completed verifier run.
 * Perfect first-pass = 1.0; each retry, execution error, or debug attempt
 * reduces the score proportionally.
 */
function computeConfidence(state, feedback, retries) {
  if (feedback === "PASS" && retries === 0) return 1.0;
  let score = 1.0;
  score -= retries * 0.15;
  if (state.lastExecutionErrors?.length > 0) score -= 0.1;
  if (state.debugAttempted) score -= 0.15;
  return Math.max(0.1, Math.min(1.0, score));
}

/**
 * Uses the session AI model to distil a short verbal principle from a failed
 * coder attempt — Reflexion (Shinn et al. 2023).  Returns the lesson string or
 * null if unavailable (no model, generation failure, etc.).
 */
async function generateReflexionLesson(state) {
  if (!state.model || !state.lastCoderResponse) return null;
  try {
    const subtask = state.subtasks?.[state.currentSubtaskIndex]?.task || "unknown";
    const { text } = await generateText({
      model: state.model,
      prompt: `A software coder failed a subtask. Write one lesson (≤ 25 words) that generalises the failure as a principle for future attempts.\n\nFormat: Lesson: <principle>\n\nSubtask: ${subtask}\nCoder output summary: ${state.lastCoderResponse.slice(0, 600)}\n\nLesson:`,
      maxTokens: 60,
    });
    const match = text.match(/lesson:\s*(.+)/i);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// Checks that a new Node.js/React project has the mandatory setup files in place.
// Fired whenever package.json is among the files written in a subtask.
// Returns an array of error strings (empty = all good).
async function checkProjectSetup(projectDir) {
  const errors = [];

  // .gitignore must exist and contain node_modules
  const gitignorePath = path.join(projectDir, ".gitignore");
  try {
    const content = await fs.promises.readFile(gitignorePath, "utf8");
    if (!content.includes("node_modules")) {
      errors.push(
        ".gitignore exists but does NOT contain 'node_modules'. " +
          "Tracking node_modules in git is unacceptable (4,000+ files). " +
          "Add node_modules/ to .gitignore NOW.",
      );
    }
  } catch {
    errors.push(
      ".gitignore is MISSING. A new Node.js/React project MUST have a .gitignore " +
        "that includes at minimum: node_modules/, dist/, .env, *.log, .DS_Store, coverage/, .vite/. " +
        "Create it NOW before proceeding.",
    );
  }

  // package.json must not have fake deps (keys starting with "#")
  // Also check TypeScript projects have a tsconfig.
  try {
    const pkg = JSON.parse(
      await fs.promises.readFile(path.join(projectDir, "package.json"), "utf8"),
    );
    const allKeys = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ];
    const fakes = allKeys.filter((k) => k.startsWith("#"));
    if (fakes.length > 0) {
      errors.push(
        `package.json contains FAKE dependency entries: ${fakes.join(", ")}. ` +
          "These are NOT valid npm packages. Remove them immediately. " +
          "Never use package.json to track task completion or pipeline state.",
      );
    }

    // TypeScript project must have a tsconfig so tsc can type-check it.
    // Without a tsconfig, all type errors are silently skipped in every subtask.
    const hasTypeScript = !!(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
    if (hasTypeScript) {
      const hasTsconfigApp = await fs.promises.access(path.join(projectDir, "tsconfig.app.json")).then(() => true).catch(() => false);
      const hasTsconfigRoot = await fs.promises.access(path.join(projectDir, "tsconfig.json")).then(() => true).catch(() => false);
      if (!hasTsconfigApp && !hasTsconfigRoot) {
        errors.push(
          "TypeScript project is MISSING tsconfig.json (or tsconfig.app.json). " +
            "Without it, the TypeScript compiler cannot type-check ANY file, so type errors accumulate silently. " +
            "Create tsconfig.json NOW with at minimum: target, lib, module, jsx, strict, noEmit, moduleResolution, include. " +
            "Vite projects typically also need: allowImportingTsExtensions, isolatedModules.",
        );
      }
    }

    // React projects must include eslint-plugin-react-hooks to catch useEffect dependency bugs.
    // Missing deps in useEffect dependency arrays cause broken AI opponents, stale closures,
    // infinite loops, and timer-cancellation bugs that are invisible to tsc.
    const hasReact = !!(pkg.dependencies?.react || pkg.devDependencies?.react);
    if (hasReact) {
      const hasReactHooksPlugin = !!(
        pkg.devDependencies?.["eslint-plugin-react-hooks"] ||
        pkg.dependencies?.["eslint-plugin-react-hooks"]
      );
      if (!hasReactHooksPlugin) {
        errors.push(
          "React project is MISSING eslint-plugin-react-hooks in devDependencies. " +
            "This plugin catches useEffect/useCallback dependency bugs that cause broken AI opponents, " +
            "stale closures, and infinite re-render loops at lint time rather than runtime. " +
            "Add to devDependencies: \"eslint-plugin-react-hooks\": \"^5.0.0\" and configure it in eslint.config.js.",
        );
      }
    }
  } catch {
    /* JSON parse errors are caught by the syntax validator */
  }

  return errors;
}

async function _verifierImpl(state) {
  // Adaptive retry budget: investigation subtasks get 2 retries, implementation subtasks
  // get 3-7 based on file count. Falls back to MAX_VERIFIER_RETRIES for unknown types.
  // Benchmark runs use a tighter cap (4) — check.js gives precise TAP feedback so
  // fewer retries are needed than with AI-generated feedback.
  const effectiveMaxRetries = state.benchmarkScenarioId
    ? Math.min(4, computeAdaptiveMaxRetries(state.subtasks?.[state.currentSubtaskIndex]) ?? MAX_VERIFIER_RETRIES)
    : (computeAdaptiveMaxRetries(state.subtasks?.[state.currentSubtaskIndex]) ?? MAX_VERIFIER_RETRIES);

  // Cross-check against Scope Document's Definition of done
  if (state.scopeDoc && state.scopeDoc.definition_of_done) {
    console.warn('[Verifier] Scope Document has Definition of done items that require manual verification:', state.scopeDoc.definition_of_done);
  }
  // Benchmark verifier: run check.js instead of AI verification so the agent gets
  // ground-truth TAP feedback rather than an AI opinion. This closes the gap where
  // the AI verifier PASS'd a correct-but-unexported class and the session burned
  // 742s before check.js finally revealed the missing `export` keyword.
  if (state.benchmarkScenarioId) {
    log(colors.magenta(`  [Graph] -> Benchmark verifier: running check.js for ${state.benchmarkScenarioId}...`));
    eventBus.emit("persona_change", { ...PERSONA, description: "Running check.js ground-truth tests" });
    eventBus.emit("phase_change", { phase: "VERIFYING", label: "Running check.js..." });

    const { evaluateScenario } = await import("#benchmark/evaluate.js");
    const result = await evaluateScenario(state.benchmarkScenarioId);

    log(colors.dim(`  [Graph] -> check.js raw result: passed=${result.passed}, exit_code_based, passCount=${result.passCount}, failCount=${result.failCount}, tests=${result.tests?.length ?? 0}`));
    if (result.passed) {
      log(colors.green(`  [Graph] -> check.js PASS (${result.passCount}/${result.passCount + result.failCount} tests)`));
      const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "benchmark implementation";
      await commitVerifiedSubtask(state.projectDir, taskLabel);
      emitTaskCompleted(state);
      return { verifierFeedback: "PASS", coderRetryCount: 0 };
    }

    const newRetryCount = (state.coderRetryCount ?? 0) + 1;
    const failingTests = (result.tests || [])
      .filter((t) => !t.passed)
      .map((t) => `  ✗ ${t.name}`)
      .join("\n");
    const tapSnippet = result.output?.slice(0, 1500) || "";
    log(colors.red(`  [Graph] -> check.js FAIL (${result.passCount}/${result.passCount + result.failCount} tests). Retry ${newRetryCount}/${effectiveMaxRetries}.`));

    return {
      verifierFeedback: "FAIL",
      coderRetryCount: newRetryCount,
      lastCoderResponse: `check.js results — ${result.passCount}/${result.passCount + (result.failCount ?? 0)} tests passed:\n${failingTests}\n\nTAP output:\n${tapSnippet}`,
      messages: [
        {
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]\ncheck.js test results: ${result.passCount}/${result.passCount + (result.failCount ?? 0)} tests passed.\n\nFailing tests:\n${failingTests}\n\nTAP output:\n\`\`\`\n${tapSnippet}\n\`\`\`\n\nFix the implementation so all tests pass.`,
        },
      ],
    };
  }

  log(colors.magenta("  [Graph] -> Running Deterministic Verifier..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Checking syntax, compilation, and page rendering" });
  eventBus.emit("phase_change", { phase: "VERIFYING", label: "Verifying..." });

  // If the coder turn itself failed (e.g. SESSION_BUSY, TURN_SKIPPED), the
  // modifiedFiles list is stale (accumulated from prior subtasks). Always fail
  // here rather than letting stale files produce a false PASS.
  if (state.coderFailed) {
    const failedTask =
      state.subtasks?.[state.currentSubtaskIndex]?.task ||
      "Complete the implementation";
    const reason = state.lastCoderResponse?.replace("[CODER TURN FAILED] ", "") || "unknown";
    const newRetryCount = (state.coderRetryCount ?? 0) + 1;
    log(colors.red(`  [Graph] -> Verifier blocked: coder turn failed (${reason.slice(0, 80)}). Retry ${newRetryCount}/${effectiveMaxRetries}.`));
    const atCap = newRetryCount >= effectiveMaxRetries;
    const capWarning = atCap
      ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not write or modify a file in this response, this subtask will be force-skipped.`
      : "";
    return {
      verifierFeedback: "FAIL",
      coderRetryCount: newRetryCount,
      messages: [
        {
          role: "user",
          content: `[CODER TURN FAILED - REVERTED TO CHECKPOINT]
Reason: ${reason}

All partial changes have been reverted to the last verified checkpoint. You MUST retry the current subtask using write_file or patch_file tools.

---

[VERIFIER AUTOMATED FEEDBACK]
The previous coder turn failed to execute (reason: ${reason}).

⚠️ IMPORTANT: Any files you edited in the previous attempt have been REVERTED by git reset. The codebase is back to the state before your last attempt. Do NOT assume your previous changes are still present - read the file first, then re-apply the change from scratch.

CRITICAL INSTRUCTION: You MUST use 'write_file' or 'patch_file' in your very next response to implement the subtask below. Do not explain what you will do - execute the tool immediately.

CURRENT SUBTASK:
${failedTask}${capWarning}`,
        },
      ],
    };
  }

  // If modifiedFiles is empty, fall back to git status — the coder may have
  // written files via execute_bash (heredoc, tee, etc.) rather than write_file.
  if ((!state.modifiedFiles || state.modifiedFiles.length === 0) && state.projectDir) {
    try {
      const { stdout } = await execAsync("git status --porcelain", { cwd: state.projectDir });
      if (stdout.trim()) {
        const gitFiles = stdout
          .trim()
          .split("\n")
          .map((line) => path.join(state.projectDir, line.slice(3).trim()))
          .filter(Boolean);
        log(colors.dim(`  [Verifier] Detected ${gitFiles.length} git-tracked change(s) from bash writes`));
        state.modifiedFiles = gitFiles;
      }
    } catch {}
  }

  if (!state.modifiedFiles || state.modifiedFiles.length === 0) {
    const currentTask =
      state.subtasks?.[state.currentSubtaskIndex]?.task ||
      "Complete the implementation";

    // ── NO_CHANGES_NEEDED detection (explicit flag + natural language variants) ──
    // Self-consistency check (Wang et al. 2022): the coder must cite specific line
    // numbers or file evidence when claiming no change is needed. An uncited claim
    // on an implementation task is almost always a false positive — the coder gave up
    // rather than verifying. We require evidence before accepting the claim.
    const lastCoderResponse = state.lastCoderResponse || "";
    const noChangesFlag = /"NO_CHANGES_NEEDED"\s*:\s*true/i.test(lastCoderResponse);
    const naturalLanguageNoChange =
      !noChangesFlag && // Only check natural language if explicit flag absent
      /no changes? (are |were )?(needed|required|necessary)|already (correct|implemented|in place|exists?|present|done)|nothing (to change|needs? (to be )?(changed|done|fixed|modified))|code is already (correct|in place|good)|this (is already|has already been)|no (modifications?|edits?) (needed|required)/i.test(lastCoderResponse);
    const claimsNoChanges = noChangesFlag || naturalLanguageNoChange;

    if (claimsNoChanges) {
      const currentSubtask = state.subtasks?.[state.currentSubtaskIndex];
      const fullTaskText = currentTask + " " + (currentSubtask?.implementationNote || "");
      const isImplementationTask = /\b(create|add|write|implement|generate|fix|modify|update|refactor|remove|replace|migrate|convert)\b/i.test(fullTaskText);

      // Reject natural-language "no changes" on implementation tasks unless the
      // coder cites specific line numbers or file path evidence to prove it.
      // Without evidence, this is a false positive — the coder checked nothing.
      if (naturalLanguageNoChange && isImplementationTask) {
        const citesLineNumbers = /line\s+\d+|\blines?\s+\d+[-–]\d+|:\d+\b|L\d+\b/i.test(lastCoderResponse);
        const citesFileContent = /```[\s\S]{20,}```/.test(lastCoderResponse); // quoted code block
        if (!citesLineNumbers && !citesFileContent) {
          const newRetryCount = (state.coderRetryCount ?? 0) + 1;
          log(colors.yellow(
            `  [Graph] -> Verifier: rejecting uncited "no changes needed" claim on implementation task (retry ${newRetryCount}).`,
          ));
          return {
            verifierFeedback: "FAIL",
            coderRetryCount: newRetryCount,
            messages: [{
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK — NO_CHANGES_NEEDED REJECTED]\n\n` +
                `You claimed no changes are needed, but provided NO evidence (no line numbers, no code quotes).\n\n` +
                `To pass this task with no changes, you MUST:\n` +
                `1. Use read_file on the target file(s)\n` +
                `2. Quote the specific lines (with line numbers) that prove the requirement is already satisfied\n` +
                `3. Then output: "NO_CHANGES_NEEDED": true\n\n` +
                `If you cannot cite specific lines proving the code is already correct, you have NOT verified it — implement the required change.\n\n` +
                `CURRENT SUBTASK:\n${currentTask}`,
            }],
          };
        }
      }

      // For explicit flag: validate file-creation tasks have files on disk.
      // Prefer PM-planned files list; fall back to regex extraction from task text.
      if (noChangesFlag && isImplementationTask && state.projectDir) {
        const subtaskMetaForNcn = state.subtasks?.[state.currentSubtaskIndex];
        let pathsToCheck = [];
        if (Array.isArray(subtaskMetaForNcn?.files) && subtaskMetaForNcn.files.length > 0) {
          // Use the PM's planned files list — authoritative and handles all extensions
          pathsToCheck = subtaskMetaForNcn.files;
        } else {
          // Fall back to regex extraction (covers .jsx, .tsx, .css, .ts, .js, .php, etc.)
          const filePathRe = /\b((?:app|mysite|public|themes|src|Sources|src)\/[\w\-./ ]+?\.(?:php|yml|yaml|ss|js|ts|jsx|tsx|css|html|svg|json|swift|mjs|cjs))\b/gi;
          pathsToCheck = [...fullTaskText.matchAll(filePathRe)].map((m) => m[1].trim());
        }
        const missingFiles = [];
        for (const relPath of pathsToCheck) {
          const abs = path.isAbsolute(relPath) ? relPath : path.join(state.projectDir, relPath);
          try { await fs.promises.access(abs); }
          catch { missingFiles.push(relPath); }
        }
        if (missingFiles.length > 0) {
          const newRetryCount = (state.coderRetryCount ?? 0) + 1;
          log(colors.yellow(
            `  [Graph] -> Verifier: rejecting NO_CHANGES_NEEDED — required files missing: ${missingFiles.join(", ")}`,
          ));
          return {
            verifierFeedback: "FAIL",
            coderRetryCount: newRetryCount,
            messages: [{
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK]\n\nNO_CHANGES_NEEDED is NOT valid for this subtask. The following required files do not exist on disk:\n${missingFiles.map((f) => `  - ${f}`).join("\n")}\n\nThis is a FILE CREATION task. You MUST use write_file to create these files now. Do not emit NO_CHANGES_NEEDED again.\n\nCURRENT SUBTASK:\n${currentTask}`,
            }],
          };
        }
      }

      log(colors.green("  [Graph] -> Verifier: coder indicated NO_CHANGES_NEEDED (with evidence) - passing."));
      eventBus.emit("system_message", { text: `✓ No changes needed: ${currentTask.slice(0, 80)}`, type: "info" });
      emitTaskCompleted(state);
      const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "no-changes subtask";
      await commitVerifiedSubtask(state.projectDir, taskLabel);
      await closeSubIssueForSubtask(state);
      writeVerificationMarker();
      return { verifierFeedback: "PASS" };
    }

    // CSS/JSX consistency verification pass: the CSS gate on a prior retry sent
    // the coder back to read JSX and verify class names. If the coder read a JSX
    // file this turn and the planned CSS files already exist on disk (written in a
    // previous retry), there's nothing left to write — the subtask is done.
    // Without this, the "no files written" check creates an unresolvable deadlock:
    // CSS gate says "read JSX then output []", but no-files gate rejects that [].
    if (state.projectDir) {
      const subtaskForCssCheck = state.subtasks?.[state.currentSubtaskIndex];
      const plannedCssFiles = (subtaskForCssCheck?.files || []).filter(f => f.endsWith('.css'));
      const readJsxThisTurn = /"read_file"[^}]{1,200}\.(jsx|tsx)/.test(lastCoderResponse) ||
        /read_file[^\n]{1,100}\.(jsx|tsx)/.test(lastCoderResponse);
      if (readJsxThisTurn && (plannedCssFiles.length > 0 || lastCoderResponse.includes('.css'))) {
        // Find any .css files that exist on disk (were written in a previous retry)
        const cssFilesToCheck = plannedCssFiles.length > 0
          ? plannedCssFiles
          : [...(lastCoderResponse.matchAll(/["']([^"']*\.css)["']/g))].map(m => m[1]).slice(0, 5);
        const cssExistResults = await Promise.all(
          cssFilesToCheck.map(f => {
            const abs = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
            return fs.promises.access(abs).then(() => true).catch(() => false);
          })
        );
        if (cssExistResults.some(Boolean)) {
          log(colors.green("  [Graph] -> CSS/JSX consistency verified — JSX read + CSS already on disk. Passing."));
          eventBus.emit("system_message", { text: `✓ CSS/JSX consistency verified: ${currentTask.slice(0, 80)}`, type: "info" });
          emitTaskCompleted(state);
          const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "css-verify subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          await closeSubIssueForSubtask(state);
          writeVerificationMarker();
          return { verifierFeedback: "PASS" };
        }
      }
    }

    // Investigation / review tasks are satisfied by textual evidence - reading
    // a file and quoting the relevant line. No file write is required or expected.
    if (isInvestigationTask(currentTask)) {
      const hasEvidence = (state.lastCoderResponse || "").length > 20;
      if (hasEvidence) {
        log(colors.green("  [Graph] -> Verifier: investigation task satisfied by textual evidence - passing."));
        eventBus.emit("system_message", { text: `✓ Investigation complete: ${currentTask.slice(0, 80)}`, type: "info" });
        emitTaskCompleted(state);
        const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "investigation subtask";
        await commitVerifiedSubtask(state.projectDir, taskLabel);
        await closeSubIssueForSubtask(state);
        writeVerificationMarker();
        return { verifierFeedback: "PASS" };
      }
      // No evidence at all - retry asking for concrete quotes
      const newRetryCount = (state.coderRetryCount ?? 0) + 1;
      return {
        verifierFeedback: "FAIL",
        coderRetryCount: newRetryCount,
        messages: [{
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]
This is a read-only investigation task. You do NOT need to write a file.
You MUST read the relevant file(s) using read_file and then quote the specific line(s) that confirm or deny the requirement.

Do NOT write a .md documentation file. Do NOT write any new file. Just read and quote.

CURRENT TASK:
${currentTask}`,
        }],
      };
    }

    // Acceptance test subtasks: coder must use http_request and report feature-level
    // HTML evidence. Neither file writes nor db:build output alone are sufficient.
    if (ACCEPTANCE_TEST_RE.test(currentTask)) {
      // ── Swift / native app acceptance test bypass ──────────────────────────
      // Native iOS/macOS apps have no HTTP server — acceptance is bash-tool evidence
      // (swiftc -parse + grep) rather than http_request. Short-circuit the HTTP
      // path entirely so the model isn't asked for something impossible.
      if (state.projectType === "swift") {
        // Run swiftc -typecheck authoritatively instead of trusting the model's
        // self-report. This eliminates hallucinated "ACCEPTANCE TEST PASSED" responses
        // where the model mentions "execute_bash" in plan text without actually running it.
        //
        // typecheckErrors === null  → swiftc/xcrun unavailable (fall back to self-report)
        // typecheckErrors === ""    → typecheck clean
        // typecheckErrors = string  → real errors found; coder must fix them
        let typecheckErrors = null;

        const hasSwiftc = await execAsync("swiftc --version")
          .then((r) => r.status === 0)
          .catch(() => false);

        if (hasSwiftc) {
          const sdkPath = await execAsync("xcrun --show-sdk-path")
            .then((r) => r.stdout.trim())
            .catch(() => "");

          if (sdkPath) {
            const findRes = await execAsync(
              `find . -name "*.swift" -not -path "*/Pods/*" -not -path "*/.build/*" -not -path "*/DerivedData/*" -not -path "*Tests*" -not -path "*UITests*"`,
              { cwd: state.projectDir },
            ).catch(() => null);

            const swiftFiles = (findRes?.stdout || "")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((f) => `"${path.resolve(state.projectDir, f)}"`);

            if (swiftFiles.length > 0) {
              // -strict-concurrency=targeted promotes Swift concurrency warnings to errors.
              // Without this flag, "Main actor-isolated property cannot be referenced from a
              // Sendable closure" is only a warning in Swift 5 mode (exit code 0) but becomes
              // a hard error in Xcode 16 / Swift 6 builds. The flag makes these detectable here.
              const tcRes = await execAsync(
                `swiftc -typecheck -sdk "${sdkPath}" -strict-concurrency=targeted ${swiftFiles.join(" ")}`,
                { cwd: state.projectDir },
              ).catch((e) => e);

              // swiftc sends ALL output (both errors and warnings) to stderr.
              // Exit code 0 = no hard errors, but may have WARNINGS (deprecations, etc.)
              // Exit code 1 = hard compile errors present
              // We must capture and inspect output regardless of exit code.
              const rawOut = ((tcRes?.stderr || "") + (tcRes?.stdout || "")).trim();

              // Shared noise filter — removes SDK environment artifacts that are not real code issues
              const filterSwiftcNoise = (lines) => lines.filter((line) => {
                // Drop "no such module" — UIKit/Pods unavailable in macOS SDK (environment, not code error)
                if (line.includes("no such module")) return false;
                // Drop swiftc source-context annotation lines that accompany error messages:
                //   "  7 | import SwiftUI"   (source line with leading spaces + digit + pipe)
                //   "    | ^^^"              (location marker with leading spaces + pipe)
                // When the parent error is filtered out, these orphaned lines look like errors.
                if (/^\s+\d+\s*\|/.test(line)) return false;
                if (/^\s+\|/.test(line)) return false;
                return true;
              });

              if (!tcRes || (!rawOut && tcRes?.status === 0)) {
                // Completely clean: swiftc exited 0 with no output
                typecheckErrors = "";
              } else if (tcRes?.status === 0 && rawOut) {
                // Exit 0 but output present: may be deprecation warnings or concurrency warnings.
                // These emit to stderr with exit code 0 but WILL cause Xcode warnings/errors.
                // Examples: "'onChange(of:perform:)' was deprecated in iOS 17.0"
                //           "Main actor-isolated X accessed from nonisolated context (warning)"
                const filtered = filterSwiftcNoise(rawOut.split("\n")).join("\n").trim();
                if (filtered) {
                  typecheckErrors =
                    "[DEPRECATION/CONCURRENCY WARNINGS — must fix for clean Xcode build]\n" + filtered;
                } else if (rawOut.includes("no such module")) {
                  typecheckErrors =
                    "[WARNING] Type-check returned only 'no such module' errors — " +
                    "a UIKit or Pods dependency is masking potential additional errors. " +
                    "Fix the module import issue first, then re-run the type-check to surface hidden errors.";
                } else {
                  typecheckErrors = "";
                }
              } else {
                // Non-zero exit — real compile errors
                const filtered = filterSwiftcNoise(rawOut.split("\n")).join("\n").trim();
                if (!filtered && rawOut.includes("no such module")) {
                  typecheckErrors =
                    "[WARNING] Type-check returned only 'no such module' errors — " +
                    "a UIKit or Pods dependency is masking potential additional errors. " +
                    "Fix the module import issue first, then re-run the type-check to surface hidden errors.";
                } else {
                  typecheckErrors = filtered;
                }
              }
            }
          }
        }

        // ── Static preferredColorScheme-on-Scene check ─────────────────────────
        // swiftc -typecheck ALWAYS masks the "preferredColorScheme on WindowGroup"
        // error (a Scene, not a View) when ContentView.swift has any cascade error.
        // We detect it independently via brace-depth analysis of *App.swift files,
        // completely independent of swiftc output. This catches the error even when
        // the typecheck is "clean" due to UIKit cascade filtering.
        let preferredColorSchemeOnSceneErr = null;
        {
          const findAppRes = await execAsync(
            `find "${state.projectDir}" -name "*App.swift" -not -path "*/Pods/*" -not -path "*Tests*" -not -path "*/.build/*"`,
          ).catch(() => null);
          const appSwiftFiles = (findAppRes?.stdout || "").trim().split("\n").filter(Boolean);
          for (const appFile of appSwiftFiles) {
            const fileContent = await execAsync(`cat "${appFile}"`)
              .then((r) => r.stdout)
              .catch(() => "");
            const fileLines = fileContent.split("\n");
            // Find the WindowGroup declaration line
            const wgIdx = fileLines.findIndex((l) => /WindowGroup\s*[({]/.test(l));
            if (wgIdx === -1) continue;
            const wgIndent = (fileLines[wgIdx].match(/^(\s*)/)?.[1] ?? "").length;
            // A .preferredColorScheme call at the same or lesser indent than WindowGroup
            // (and after it in the file) is applied to the Scene result — type error.
            for (let li = wgIdx + 1; li < fileLines.length; li++) {
              const fl = fileLines[li];
              if (!fl.includes(".preferredColorScheme")) continue;
              const pcIndent = (fl.match(/^(\s*)/)?.[1] ?? "").length;
              if (pcIndent <= wgIndent) {
                preferredColorSchemeOnSceneErr = { file: appFile, lineNo: li + 1, text: fl.trim() };
                break;
              }
            }
            if (preferredColorSchemeOnSceneErr) break;
          }
        }

        // ── Static deprecated onChange(of:) check ─────────────────────────────
        // The single-parameter closure form .onChange(of: X) { val in ... } was
        // deprecated in iOS 17.0. Xcode 16 emits a warning for it; Swift 6 strict mode
        // makes it an error. The macOS swiftc typecheck may miss it when UIKit cascade
        // blocks the type-checker from reaching those callsites. Detect it statically.
        //
        // Deprecated (single param):  .onChange(of: x) { newValue in ... }
        // Correct iOS 17+ (two param): .onChange(of: x) { oldValue, newValue in ... }
        // Correct iOS 17+ (zero param): .onChange(of: x) { /* use x directly */ }
        let deprecatedOnChangeInstances = [];
        {
          const findSwift2 = await execAsync(
            `find "${state.projectDir}" -name "*.swift" -not -path "*/Pods/*" -not -path "*Tests*" -not -path "*/.build/*"`,
          ).catch(() => null);
          const allSwift2 = (findSwift2?.stdout || "").trim().split("\n").filter(Boolean);
          for (const sf of allSwift2) {
            const sfContent = await execAsync(`cat "${sf}"`).then((r) => r.stdout).catch(() => "");
            const sfLines = sfContent.split("\n");
            for (let li = 0; li < sfLines.length; li++) {
              if (!/\.onChange\s*\(of:/.test(sfLines[li])) continue;
              // Look at this line plus next 4 for the closure opening
              const window = sfLines.slice(li, Math.min(li + 5, sfLines.length)).join("\n");
              // Deprecated: "{ singleWord in" or "{ _ in" (single binding before "in")
              // NOT deprecated: "{ old, new in" (two params) or "{ " with no "in" (zero params)
              if (
                /\{\s*[\w_]+\s+in\b/.test(window) &&
                !/\{\s*[\w_]+\s*,\s*[\w_]+\s+in\b/.test(window)
              ) {
                deprecatedOnChangeInstances.push({ file: sf, lineNo: li + 1, text: sfLines[li].trim() });
              }
            }
          }
        }

        // ── Static MainActor isolation in NotificationCenter closure check ──────
        // NotificationCenter.addObserver closures are typed @escaping @Sendable.
        // Directly accessing @StateObject/@ObservedObject viewModel properties or
        // calling its methods from inside the closure is a Swift 6 actor-isolation
        // error: "Main actor-isolated property 'X' cannot be referenced from a
        // Sendable closure". The correct fix is to use scenePhase onChange instead,
        // or wrap with Task { @MainActor in ... }.
        let mainActorNotifInstances = [];
        {
          const findSwift3 = await execAsync(
            `find "${state.projectDir}" -name "*.swift" -not -path "*/Pods/*" -not -path "*Tests*" -not -path "*/.build/*"`,
          ).catch(() => null);
          const allSwift3 = (findSwift3?.stdout || "").trim().split("\n").filter(Boolean);
          for (const sf of allSwift3) {
            const sfContent = await execAsync(`cat "${sf}"`).then((r) => r.stdout).catch(() => "");
            const sfLines = sfContent.split("\n");
            for (let li = 0; li < sfLines.length; li++) {
              if (!/addObserver\s*\(.*forName:/.test(sfLines[li])) continue;
              // Check the next 30 lines for a direct viewModel access without @MainActor protection.
              // 30 lines covers realistic closure bodies (12 was too small and caused misses).
              const window = sfLines.slice(li, Math.min(li + 30, sfLines.length)).join("\n");
              const hasViewModelAccess = /\bviewModel\.\w+\s*[\(\.]/.test(window);
              const hasMainActorProtection =
                /Task\s*\{\s*@MainActor\b/.test(window) ||
                /Task\s*\{[^}]*@MainActor\b/.test(window) ||
                /MainActor\.run\s*\{/.test(window);
              if (hasViewModelAccess && !hasMainActorProtection) {
                mainActorNotifInstances.push({ file: sf, lineNo: li + 1, text: sfLines[li].trim() });
              }
            }
          }

          // ── Redundant+broken coexistence check ───────────────────────────────
          // When the coder adds scenePhase .onChange in the App struct as the fix
          // for a NotificationCenter MainActor error, it often fails to REMOVE the
          // NotificationCenter code from ContentView. Both patterns then coexist:
          //   App struct: .onChange(of: scenePhase) { ..., viewModel.saveAllData() }
          //   ContentView: NotificationCenter.addObserver(...) { viewModel.saveAllData() }
          // The NotificationCenter code is now both redundant AND broken (still a
          // MainActor isolation error). Detect this coexistence and inject it as a
          // mainActorNotifInstance even if the window check above misses the call.
          {
            let hasScenePhaseOnChange = false;
            let hasNotifObserver = false;
            let notifObserverFile = null;
            let notifObserverLine = 0;
            for (const sf of allSwift3) {
              const c = await execAsync(`cat "${sf}"`).then((r) => r.stdout).catch(() => "");
              if (/\.onChange\s*\(of:\s*scenePhase\b/.test(c) && /viewModel\.\w+/.test(c)) {
                hasScenePhaseOnChange = true;
              }
              if (/addObserver\s*\(.*forName:/.test(c)) {
                hasNotifObserver = true;
                if (!notifObserverFile) {
                  notifObserverFile = sf;
                  const idx = c.split("\n").findIndex((l) => /addObserver\s*\(.*forName:/.test(l));
                  notifObserverLine = idx + 1;
                }
              }
            }
            if (hasScenePhaseOnChange && hasNotifObserver) {
              // Only add if this file isn't already flagged (avoid double-reporting)
              const alreadyFlagged = mainActorNotifInstances.some((i) => i.file === notifObserverFile);
              if (!alreadyFlagged) {
                mainActorNotifInstances.push({
                  file: notifObserverFile,
                  lineNo: notifObserverLine,
                  text: "NotificationCenter.addObserver (REDUNDANT+BROKEN: scenePhase .onChange already handles this)",
                });
              }
            }
          }
        }

        // ── Static @Observable consistency check ───────────────────────────────
        // Migrating a class from ObservableObject to @Observable requires ALL consuming
        // views to be updated in the SAME CODER TURN:
        //   @StateObject → @State  (for the class that owns the @Observable instance)
        //   @ObservedObject → @Bindable  (for views that receive it as a parameter)
        //   @EnvironmentObject → @Environment (with key path)
        // Mixing old ObservableObject wrappers with @Observable classes is a Swift compile
        // error. Detect cross-file consistency violations statically.
        let observableMismatchInstances = [];
        {
          const findSwift4 = await execAsync(
            `find "${state.projectDir}" -name "*.swift" -not -path "*/Pods/*" -not -path "*Tests*" -not -path "*/.build/*"`,
          ).catch(() => null);
          const allSwift4 = (findSwift4?.stdout || "").trim().split("\n").filter(Boolean);

          // Pass 1: collect all @Observable class names and all ObservableObject-conforming class names
          const observableClasses = new Set();
          const observableObjectClasses = new Set();
          for (const sf of allSwift4) {
            const c = await execAsync(`cat "${sf}"`).then((r) => r.stdout).catch(() => "");
            for (const m of c.matchAll(/@Observable\s+(?:final\s+)?(?:@MainActor\s+)?class\s+(\w+)/g)) {
              observableClasses.add(m[1]);
            }
            for (const m of c.matchAll(/class\s+(\w+)\s*(?::\s*[^{]+)?ObservableObject/g)) {
              observableObjectClasses.add(m[1]);
            }
          }

          // Pass 2: scan all files for wrapper/class mismatches
          for (const sf of allSwift4) {
            const c = await execAsync(`cat "${sf}"`).then((r) => r.stdout).catch(() => "");
            const sfLines = c.split("\n");
            for (let li = 0; li < sfLines.length; li++) {
              const line = sfLines[li];
              // @StateObject / @ObservedObject used with an @Observable class (must be @State / @Bindable)
              if (/@StateObject\b/.test(line) || /@ObservedObject\b/.test(line)) {
                for (const cls of observableClasses) {
                  if (new RegExp(`(?:var|let)\\s+\\w+\\s*(?:=\\s*\\w+)?\\s*:\\s*${cls}\\b|=\\s*${cls}\\(`).test(line)) {
                    const wrong = /@StateObject\b/.test(line) ? "@StateObject" : "@ObservedObject";
                    const right = /@StateObject\b/.test(line) ? "@State" : "@Bindable";
                    observableMismatchInstances.push({ file: sf, lineNo: li + 1, text: line.trim(), cls, wrong, right });
                  }
                }
              }
              // @Bindable used with an ObservableObject-conforming class (must be @ObservedObject)
              if (/@Bindable\b/.test(line)) {
                for (const cls of observableObjectClasses) {
                  if (new RegExp(`:\\s*${cls}\\b`).test(line)) {
                    observableMismatchInstances.push({ file: sf, lineNo: li + 1, text: line.trim(), cls, wrong: "@Bindable", right: "@ObservedObject" });
                  }
                }
              }
            }
          }
        }

        // ── Build note strings for each static issue ──────────────────────────
        // Appended to type-error and clean-pass feedback so the coder fixes ALL issues in one pass
        const pcsAdditionalNote = preferredColorSchemeOnSceneErr
          ? `\n\n⚠️ ADDITIONAL STATIC ERROR: .preferredColorScheme applied to Scene (WindowGroup) at ${preferredColorSchemeOnSceneErr.file}:${preferredColorSchemeOnSceneErr.lineNo}\n` +
            `  Found: ${preferredColorSchemeOnSceneErr.text}\n` +
            `  .preferredColorScheme is a View modifier — NOT a Scene modifier. Fix: move it INSIDE the WindowGroup content:\n` +
            `    WRONG: WindowGroup { ContentView() }.preferredColorScheme(.dark)\n` +
            `    RIGHT: WindowGroup { Group { ContentView() }.preferredColorScheme(.dark) }`
          : "";

        const deprecatedOnChangeNote = deprecatedOnChangeInstances.length > 0
          ? `\n\n⚠️ DEPRECATED API (iOS 17.0): onChange(of:) single-parameter closure is deprecated.\n` +
            `Instances found:\n${deprecatedOnChangeInstances.map((d) => `  ${d.file}:${d.lineNo}: ${d.text}`).join("\n")}\n` +
            `Fix — use the two-parameter form (iOS 17+):\n` +
            `  WRONG (deprecated): .onChange(of: scenePhase) { newPhase in ... }\n` +
            `  RIGHT (iOS 17+):    .onChange(of: scenePhase) { oldPhase, newPhase in ... }\n` +
            `  OR (zero params):   .onChange(of: scenePhase) { /* use scenePhase directly */ }`
          : "";

        const mainActorNotifNote = mainActorNotifInstances.length > 0
          ? `\n\n⚠️ SWIFT 6 PERSONA ISOLATION ERROR: NotificationCenter.addObserver closure references @MainActor viewModel directly.\n` +
            `Instances found:\n${mainActorNotifInstances.map((d) => `  ${d.file}:${d.lineNo}: ${d.text}`).join("\n")}\n` +
            `The addObserver closure is @Sendable — accessing @MainActor properties directly is a Swift 6 error.\n` +
            `PREFERRED FIX — eliminate NotificationCenter ENTIRELY from that file (this is complete removal, not wrapping):\n` +
            `  1. Remove the saveObserver property declaration (e.g. "private var saveObserver: NSObjectProtocol?")\n` +
            `  2. Remove the entire .onAppear block that calls NotificationCenter.default.addObserver(...)\n` +
            `  3. Remove the entire .onDisappear block that calls NotificationCenter.default.removeObserver(...)\n` +
            `  4. Add scenePhase onChange in the same view file:\n` +
            `       @Environment(\\.scenePhase) var scenePhase\n` +
            `       // In view body modifiers:\n` +
            `       .onChange(of: scenePhase) { oldPhase, newPhase in\n` +
            `           if newPhase == .background { viewModel.saveAllData() }\n` +
            `       }\n` +
            `  NOTE: If scenePhase .onChange already exists in the App struct (*App.swift) for this same purpose,\n` +
            `  you do NOT need to add it to ContentView too — just REMOVE the NotificationCenter code.\n` +
            `ALTERNATIVE FIX — if NotificationCenter must be kept, wrap viewModel calls with Task { @MainActor in ... }:\n` +
            `  NotificationCenter.default.addObserver(forName: ...) { _ in\n` +
            `      Task { @MainActor in viewModel.saveAllData() }\n` +
            `  }`
          : "";

        const observableMismatchNote = observableMismatchInstances.length > 0
          ? `\n\n⚠️ @Observable/@ObservableObject CONSISTENCY ERROR — PARTIAL MIGRATION DETECTED.\n` +
            `The following files use the WRONG property wrapper for their ViewModel type:\n` +
            observableMismatchInstances.map((d) =>
              `  ${d.file}:${d.lineNo}: ${d.text}\n` +
              `    Class '${d.cls}' — use ${d.right} not ${d.wrong}`,
            ).join("\n") + "\n\n" +
            `@Observable classes require:\n` +
            `  @State      (not @StateObject)    — for the view that owns/instantiates the model\n` +
            `  @Bindable   (not @ObservedObject) — for views that receive the model as a parameter\n` +
            `ObservableObject classes require:\n` +
            `  @StateObject   (not @State)     — for the view that owns the model\n` +
            `  @ObservedObject (not @Bindable) — for views that receive the model\n\n` +
            `CRITICAL: @Observable migration MUST be atomic across ALL files in ONE write_file pass.\n` +
            `Do NOT migrate the ViewModel in one subtask and plan to update consuming views later —\n` +
            `the patch validator catches the intermediate broken state and rolls back every patch.\n` +
            `Fix ALL files now: write_file StoryViewModel.swift (add @Observable, remove @Published) +\n` +
            `write_file ContentView.swift (@State) + write_file DefinitionPanel.swift (@Bindable) +\n` +
            `write_file SettingsView.swift (@Bindable) — all in a single JSON tool call array.`
          : "";

        if (typecheckErrors !== null && typecheckErrors !== "") {
          // Real type errors (or deprecation/concurrency warnings) — coder must fix them
          const newRetryCount = (state.coderRetryCount ?? 0) + 1;
          const atCap = newRetryCount >= effectiveMaxRetries;
          const capWarning = atCap
            ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If errors persist, this subtask will be force-skipped.`
            : "";
          const isWarningsOnly = typecheckErrors.startsWith("[DEPRECATION/CONCURRENCY WARNINGS");
          log(colors.red(`  [Graph] -> Verifier: Swift typecheck found ${isWarningsOnly ? "warnings" : "errors"}. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
          if (preferredColorSchemeOnSceneErr) {
            log(colors.red(`  [Graph] -> Verifier: Also detected preferredColorScheme on Scene at ${path.basename(preferredColorSchemeOnSceneErr.file)}:${preferredColorSchemeOnSceneErr.lineNo}`));
          }
          if (deprecatedOnChangeInstances.length > 0) {
            log(colors.yellow(`  [Graph] -> Verifier: Detected deprecated onChange(of:) in ${deprecatedOnChangeInstances.length} location(s).`));
          }
          if (mainActorNotifInstances.length > 0) {
            log(colors.yellow(`  [Graph] -> Verifier: Detected MainActor isolation issue in NotificationCenter closure.`));
          }
          if (observableMismatchInstances.length > 0) {
            log(colors.red(`  [Graph] -> Verifier: Detected @Observable/@ObservableObject mismatch in ${observableMismatchInstances.length} location(s) — partial migration.`));
          }

          // ── Error Stagnation Detection ──────────────────────────────────────
          // When the SAME typecheck error appears on consecutive retries without
          // any change, the coder is stuck in a single-strategy loop. Escalate
          // to the Debugger earlier than the default DEBUGGER_TRIGGER_RETRIES
          // threshold by bumping coderRetryCount when stagnation is detected.
          // Inspired by: failure-mode analysis in RLHF process reward models.
          if (newRetryCount >= 2 && typecheckErrors) {
            // Build a compact signature from the first 3 diagnostic lines
            const errorSig = typecheckErrors
              .split("\n")
              .filter((l) => /:\s*(error|warning):/.test(l))
              .slice(0, 3)
              .join("|")
              .slice(0, 180);

            if (errorSig) {
              // Scan the most recent prior verifier FAIL message from state.messages
              const priorVerifierMsg = [...(state.messages || [])]
                .reverse()
                .find(
                  (m) =>
                    m.role === "user" &&
                    typeof m.content === "string" &&
                    m.content.includes("[VERIFIER AUTOMATED FEEDBACK]") &&
                    m.content.includes("swiftc -typecheck"),
                );

              const isStagnant =
                priorVerifierMsg &&
                priorVerifierMsg.content.includes(errorSig.slice(0, 80));

              if (isStagnant) {
                const escalatedCount = Math.max(newRetryCount, DEBUGGER_TRIGGER_RETRIES);
                log(colors.red(
                  `  [Graph] -> Verifier: STAGNANT ERROR detected (same typecheck error on retry ${newRetryCount}) — escalating to debugger (retryCount→${escalatedCount}).`,
                ));
                return {
                  verifierFeedback: "FAIL",
                  coderRetryCount: escalatedCount,
                  messages: [{
                    role: "user",
                    content: `[VERIFIER AUTOMATED FEEDBACK — STAGNANT ERROR DETECTED]

The SAME typecheck error has appeared on ${newRetryCount} consecutive attempts without progress.
The Debugger will now perform root-cause investigation.

=== STAGNANT ERROR (unchanged across ${newRetryCount} retries) ===
${typecheckErrors}${pcsAdditionalNote}${deprecatedOnChangeNote}${mainActorNotifNote}${observableMismatchNote}

CURRENT SUBTASK:
${currentTask}`,
                  }],
                };
              }
            }
          }

          return {
            verifierFeedback: "FAIL",
            coderRetryCount: newRetryCount,
            messages: [{
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK]

swiftc -typecheck found ${isWarningsOnly ? "WARNINGS that indicate iOS 17+/Swift 6 incompatibilities" : "REAL ERRORS"}. Your acceptance test claim is REJECTED.

=== SWIFT ${isWarningsOnly ? "WARNINGS" : "TYPE ERRORS"} ===
${typecheckErrors}${pcsAdditionalNote}${deprecatedOnChangeNote}${mainActorNotifNote}${observableMismatchNote}

Fix ${isWarningsOnly ? "these warnings" : "these errors"} with patch_file, then verify by running swiftc -typecheck and reporting "ACCEPTANCE TEST PASSED".

CURRENT SUBTASK:
${currentTask}${capWarning}`,
            }],
          };
        }

        if (typecheckErrors === "") {
          // Typecheck passed — now run the static preferredColorScheme-on-Scene check.
          // This error is ALWAYS masked by cascade errors in swiftc output, so we
          // must catch it here independently even when the typecheck appears clean.
          if (preferredColorSchemeOnSceneErr) {
            const newRetryCount = (state.coderRetryCount ?? 0) + 1;
            const atCap = newRetryCount >= effectiveMaxRetries;
            const capWarning = atCap
              ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): This subtask will be force-skipped if not fixed.`
              : "";
            log(colors.red(
              `  [Graph] -> Verifier: preferredColorScheme on Scene detected in ${path.basename(preferredColorSchemeOnSceneErr.file)}:${preferredColorSchemeOnSceneErr.lineNo} — FAIL despite clean typecheck.`,
            ));
            return {
              verifierFeedback: "FAIL",
              coderRetryCount: newRetryCount,
              messages: [{
                role: "user",
                content: `[VERIFIER AUTOMATED FEEDBACK]

TYPE ERROR DETECTED (static analysis): .preferredColorScheme applied to a Scene (WindowGroup).

File: ${preferredColorSchemeOnSceneErr.file}
Line ${preferredColorSchemeOnSceneErr.lineNo}: ${preferredColorSchemeOnSceneErr.text}

.preferredColorScheme is a View modifier — NOT a Scene modifier. WindowGroup returns some Scene,
so calling .preferredColorScheme on the WindowGroup result is a type error that Xcode will refuse to compile.

This error is MASKED by swiftc -typecheck when run from the macOS command line (cascade errors
in ContentView.swift prevent the type-checker from reaching this line in the App struct body).
The verifier detects it via static brace-depth analysis, independently of swiftc output.

Fix required — move .preferredColorScheme INSIDE the WindowGroup content block:
  WRONG (current):
    WindowGroup {
      ContentView()
    }
    .preferredColorScheme(.dark)    ← applied to Scene — TYPE ERROR

  RIGHT:
    WindowGroup {
      Group {
        ContentView()
      }
      .preferredColorScheme(.dark)  ← applied to View inside WindowGroup — CORRECT
    }

Use patch_file to fix ${preferredColorSchemeOnSceneErr.file}.
After fixing, re-run swiftc -typecheck and report "ACCEPTANCE TEST PASSED".${capWarning}`,
              }],
            };
          }
          // Typecheck and PCS are clean — check remaining static issues
          const remainingStaticIssues = [deprecatedOnChangeNote, mainActorNotifNote, observableMismatchNote]
            .filter(Boolean)
            .join("");
          if (remainingStaticIssues) {
            const newRetryCount = (state.coderRetryCount ?? 0) + 1;
            const atCap = newRetryCount >= effectiveMaxRetries;
            const capWarning = atCap
              ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): This subtask will be force-skipped if not fixed.`
              : "";
            if (deprecatedOnChangeInstances.length > 0) {
              log(colors.red(`  [Graph] -> Verifier: Deprecated onChange(of:) detected — FAIL despite clean typecheck.`));
            }
            if (mainActorNotifInstances.length > 0) {
              log(colors.red(`  [Graph] -> Verifier: MainActor isolation in NotificationCenter closure — FAIL despite clean typecheck.`));
            }
            if (observableMismatchInstances.length > 0) {
              log(colors.red(`  [Graph] -> Verifier: @Observable/@ObservableObject mismatch in ${observableMismatchInstances.length} location(s) — FAIL despite clean typecheck.`));
            }
            return {
              verifierFeedback: "FAIL",
              coderRetryCount: newRetryCount,
              messages: [{
                role: "user",
                content: `[VERIFIER AUTOMATED FEEDBACK]

STATIC ANALYSIS ISSUES DETECTED — Your acceptance test claim is REJECTED.

swiftc -typecheck passed (no compile errors), but the verifier found Swift 6 / iOS 17+ compatibility issues via static analysis that WILL cause errors in Xcode builds:
${remainingStaticIssues}

Fix these with patch_file. After fixing, re-run swiftc -typecheck and report "ACCEPTANCE TEST PASSED".

CURRENT SUBTASK:
${currentTask}${capWarning}`,
              }],
            };
          }
          // All checks passed — genuine clean acceptance
          log(colors.green("  [Graph] -> Verifier: Swift acceptance test passed (swiftc -typecheck clean + all static checks passed)."));
          eventBus.emit("system_message", { text: `✓ Swift acceptance test passed: ${currentTask.slice(0, 80)}`, type: "info" });
          emitTaskCompleted(state);
          const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "acceptance test subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          await closeSubIssueForSubtask(state);
          writeVerificationMarker();
          return { verifierFeedback: "PASS" };
        }

        // typecheckErrors === null: swiftc/xcrun unavailable — fall back to self-report
        const response = state.lastCoderResponse || "";
        const hasPassed = /ACCEPTANCE TEST PASSED/i.test(response);

        if (hasPassed) {
          log(colors.green("  [Graph] -> Verifier: Swift acceptance test passed (swiftc unavailable; model self-report accepted)."));
          eventBus.emit("system_message", { text: `✓ Swift acceptance test passed: ${currentTask.slice(0, 80)}`, type: "info" });
          emitTaskCompleted(state);
          const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "acceptance test subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          await closeSubIssueForSubtask(state);
          writeVerificationMarker();
          return { verifierFeedback: "PASS" };
        }

        const newRetryCount = (state.coderRetryCount ?? 0) + 1;
        const atCap = newRetryCount >= effectiveMaxRetries;
        const capWarning = atCap
          ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not provide evidence in this response, this subtask will be force-skipped.`
          : "";
        log(colors.red(`  [Graph] -> Verifier: Swift acceptance test — swiftc unavailable, model did not report PASSED. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetryCount,
          messages: [{
            role: "user",
            content: `[VERIFIER AUTOMATED FEEDBACK]

ACCEPTANCE TEST for Swift project requires swiftc verification.
This is a native iOS/macOS app — there is no HTTP server to curl.
Your response did not report "ACCEPTANCE TEST PASSED".

Required steps:
1. execute_bash: swiftc -typecheck -sdk "$(xcrun --show-sdk-path)" <all .swift files> (exit 0 = clean)
2. execute_bash: grep -q "pattern" <file.swift> for each required code pattern
3. Report: "ACCEPTANCE TEST PASSED — swiftc typecheck clean, all patterns confirmed."

CURRENT SUBTASK:
${currentTask}${capWarning}`,
          }],
        };
      }
      // ── end Swift acceptance test bypass ──

      // ── Unity / native game engine acceptance test bypass ─────────────────
      // Unity has no HTTP server — acceptance is execute_bash evidence (Unity
      // batchmode test runner + parsing editmode_results.xml), NOT http_request.
      if (state.projectType === "unity") {
        const response = state.lastCoderResponse || "";
        const hasPassed = /ACCEPTANCE TEST PASSED/i.test(response);
        const calledBash = (state.lastToolsExecuted || []).some(
          (t) => /^execute_bash$/i.test(t),
        );

        if (hasPassed && calledBash) {
          log(colors.green("  [Graph] -> Verifier: Unity acceptance test passed (execute_bash evidence confirmed)."));
          eventBus.emit("system_message", { text: `✓ Unity acceptance test passed: ${currentTask.slice(0, 80)}`, type: "info" });
          emitTaskCompleted(state);
          const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "acceptance test subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          await closeSubIssueForSubtask(state);
          writeVerificationMarker();
          return { verifierFeedback: "PASS" };
        }

        const newRetryCount = (state.coderRetryCount ?? 0) + 1;
        const atCap = newRetryCount >= effectiveMaxRetries;
        const capWarning = atCap
          ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not provide execute_bash evidence in this response, this subtask will be force-skipped.`
          : "";

        const subtaskMeta = state.subtasks?.[state.currentSubtaskIndex];
        const criteriaHint = subtaskMeta?.acceptanceCriteria
          ? `\nSuccess evidence: ${subtaskMeta.acceptanceCriteria}\nFailure indicators: ${subtaskMeta.failureCriteria || "test XML missing or batchmode exit non-zero"}`
          : "";

        const missingReason = !calledBash
          ? "You have not called execute_bash yet."
          : "You called execute_bash but did not report \"ACCEPTANCE TEST PASSED\".";

        log(colors.red(`  [Graph] -> Verifier: Unity acceptance test — ${missingReason} Retry ${newRetryCount}/${effectiveMaxRetries}.`));
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetryCount,
          messages: [{
            role: "user",
            content: `[VERIFIER AUTOMATED FEEDBACK]

UNITY ACCEPTANCE TEST requires execute_bash evidence — NOT http_request (Unity has no HTTP server).

${missingReason}

Required steps:
1. execute_bash: run Unity batchmode test runner:
   "<UNITY_BIN>" -batchmode -projectPath "${state.projectDir}" -runTests -testPlatform editmode -testResults "${state.projectDir}/Logs/editmode_results.xml" -nographics
2. read_file: inspect Logs/editmode_results.xml — confirm each required test-case result="Passed"
3. Report: "ACCEPTANCE TEST PASSED — [test names] confirmed in editmode_results.xml"
${criteriaHint}

Do NOT use http_request. This is a Unity game — there is no web server.

CURRENT SUBTASK:
${currentTask}${capWarning}`,
          }],
        };
      }
      // ── end Unity acceptance test bypass ──

      const response = state.lastCoderResponse || "";
      const hasPassed = /ACCEPTANCE TEST PASSED/i.test(response);
      const hasFailed = /ACCEPTANCE TEST FAILED/i.test(response);
      // Check both the text response AND the executed tool list.
      // The text-only check breaks when the coder uses a named-vhost URL like
      // http://thescopes.local — the regex won't match "localhost" and the
      // verifier falsely reports "no http_request call found" even though the
      // tool WAS called and the result was valid.
      const calledHttpTool = (state.lastToolsExecuted || []).some(
        (t) => /^http_request$/i.test(t),
      );
      const hasHttpEvidence =
        calledHttpTool ||
        /http_request|http:\/\/(?:localhost|127\.0\.0\.1|[\w-]+\.local\b|[\w-]+\.test\b)/i.test(response);

      // ── Structural acceptance test detection ─────────────────────────────────
      // Some acceptance tests cannot be verified via HTTP because they target:
      //   - SilverStripe CMS admin pages (require authentication)
      //   - Internal code patterns verified by grep/read_file
      //   - DB schema state verified by db:build output
      // These are "structural" acceptance tests: implementationNote describes
      // grep/execute_bash/read_file checks and contains NO URL to fetch.
      //
      // For structural acceptance: accept evidence when the coder:
      //   (a) called at least one structural tool (grep, read_file, execute_bash, run_sake), AND
      //   (b) explicitly reported "ACCEPTANCE TEST PASSED" with the tool output quoted
      //
      // This prevents the infinite loop where the verifier demands http_request for
      // a CMS-admin test and the coder keeps trying to fetch an auth-protected URL.
      const subtaskAcceptanceCriteria = state.subtasks?.[state.currentSubtaskIndex]?.acceptanceCriteria || "";
      const subtaskImplNote = state.subtasks?.[state.currentSubtaskIndex]?.implementationNote || "";
      const allCriteriaText = subtaskAcceptanceCriteria + " " + subtaskImplNote;

      // Structural if: criteria mention structural tools (or Unity/batchmode patterns)
      // AND there is no URL to fetch. Unity acceptance tests describe batchmode XML
      // parsing without necessarily using the keyword "execute_bash" in the criteria.
      const isStructuralAcceptance =
        /\b(grep|read_file|execute_bash|find_file|db[:\-]build|sake|run_sake|batchmode|editmode[_\s]results|unity.*test)\b/i.test(allCriteriaText) &&
        !/https?:\/\/|http_request\s*\(/.test(subtaskImplNote);

      const calledStructuralTool = (state.lastToolsExecuted || []).some(
        (t) => /^(execute_bash|read_file|find_file|grep|list_files|run_sake|run_phpunit)$/i.test(t),
      );
      const hasStructuralEvidence = isStructuralAcceptance && calledStructuralTool;

      // Infrastructure error detection: check the most recent <http_result> block
      // for server-side environment failures (permission denied, disk full, etc.).
      // These cannot be fixed by editing code — the verifier provides a shell fix command.
      const httpResultMatch = response.match(/<http_result[^>]*>([\s\S]*?)<\/http_result>/i);
      const httpResultText = httpResultMatch?.[1] || "";
      const httpEnvErr = classifyHttpResponseError(httpResultText);

      if (httpEnvErr) {
        const newRetryCount = (state.coderRetryCount ?? 0) + 1;
        const affectedPath = httpEnvErr.path
          ? path.dirname(httpEnvErr.path)
          : (state.projectDir ? `${state.projectDir}/public/assets` : null);
        const fixCmd = affectedPath
          ? `sudo chown -R www-data:www-data "${affectedPath}" && sudo chmod -R 775 "${affectedPath}"`
          : "sudo chown -R www-data:www-data <assets-directory>";

        // At retry cap: escalate to ENVIRONMENT_BLOCKED and force-advance
        if (newRetryCount >= effectiveMaxRetries) {
          log(colors.yellow(
            `  [Graph] -> Acceptance test ENVIRONMENT_BLOCKED: ${httpEnvErr.description}`,
          ));
          eventBus.emit("system_message", {
            text: `⚠️ Acceptance test blocked by infrastructure: ${httpEnvErr.description} — manual fix may be required`,
            type: "warning",
          });
          emitTaskCompleted(state);
          const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "acceptance test subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          return { verifierFeedback: "ENVIRONMENT_BLOCKED" };
        }

        // Before cap: inject the fix command into coder feedback
        log(colors.yellow(
          `  [Graph] -> Verifier: HTTP 500 infrastructure error detected (${httpEnvErr.type}). Providing fix command. Retry ${newRetryCount}/${effectiveMaxRetries}.`,
        ));
        const atCap = newRetryCount >= effectiveMaxRetries;
        const capWarning = atCap
          ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If the permission error persists, this subtask will be force-skipped.`
          : "";
        const urlGuess = currentTask.match(/https?:\/\/[^\s"')]+/)?.[0] ||
          (state.subtasks?.[state.currentSubtaskIndex]?.implementationNote || "the project URL");

        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetryCount,
          messages: [{
            role: "user",
            content: `[VERIFIER AUTOMATED FEEDBACK]

The http_request returned HTTP 500 with a server-side infrastructure error:

ERROR: ${httpEnvErr.description}

This is NOT a PHP code issue — the web server user lacks permission to write to a required directory. You cannot fix this by editing PHP/YAML/template files.

FIX WITH execute_bash:
  ${fixCmd}

After running the fix command:
1. Re-run the acceptance test: http_request(url="${urlGuess}/?flush=1")
2. If HTTP 200 → report ACCEPTANCE TEST PASSED
3. If still HTTP 500 → report the new error output

CURRENT SUBTASK:
${currentTask}${capWarning}`,
          }],
        };
      }

      // Check if the response contains an auth-redirect warning emitted by the
      // http_request tool — if so, the AI tested the wrong URL (production site
      // behind SSO returning HTTP 200 on a login page) and must be forced to retry.
      const hasAuthRedirectWarning =
        /AUTH REDIRECT DETECTED|WRONG URL — AUTH PAGE RETURNED|microsoft.*login|login\.microsoftonline/i.test(response);

      // Also check if the http_request URL was an external (non-local) domain.
      // External = has a TLD that isn't .local or is https with a real domain.
      const httpUrlMatch = response.match(/http_result\s+url="([^"]+)"/i) ||
        response.match(/\[HTTP GET\]\s+(https?:\/\/\S+)/i);
      const testedUrl = httpUrlMatch?.[1] || "";
      const isExternalUrl = testedUrl && !/localhost|127\.0\.0\.1|\.local\b|\.test\b/.test(testedUrl) && /^https?:\/\/[^/]+\.[a-z]{2,}/.test(testedUrl);

      if (hasPassed && (hasHttpEvidence || hasStructuralEvidence) && !hasAuthRedirectWarning && !isExternalUrl) {
        const evidenceType = hasStructuralEvidence ? "structural tool evidence" : "HTTP evidence";
        log(colors.green(`  [Graph] -> Verifier: acceptance test passed with ${evidenceType}.`));
        eventBus.emit("system_message", { text: `✓ Acceptance test passed: ${currentTask.slice(0, 80)}`, type: "info" });
        emitTaskCompleted(state);
        const taskLabel = state.subtasks?.[state.currentSubtaskIndex]?.task || "acceptance test subtask";
        await commitVerifiedSubtask(state.projectDir, taskLabel);
        await closeSubIssueForSubtask(state);
        writeVerificationMarker();
        return { verifierFeedback: "PASS" };
      }

      const newRetryCount = (state.coderRetryCount ?? 0) + 1;
      const evidenceLabel = isStructuralAcceptance ? "structural tool evidence" : "live HTTP evidence";
      log(colors.red(`  [Graph] -> Verifier: acceptance test requires ${evidenceLabel}. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
      const atCap = newRetryCount >= effectiveMaxRetries;
      const capWarning = atCap
        ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not provide ${evidenceLabel} in this response, this subtask will be force-skipped.`
        : "";

      const subtaskMeta = state.subtasks?.[state.currentSubtaskIndex];
      // Use structured fields when present; fall back to implementation_note for older plans.
      const criteriaHint = subtaskMeta?.acceptanceCriteria
        ? `\nSuccess evidence: ${subtaskMeta.acceptanceCriteria}\nFailure indicators: ${subtaskMeta.failureCriteria || "PHP error or missing feature markup"}`
        : subtaskMeta?.implementationNote
          ? `\nExpected evidence:\n${subtaskMeta.implementationNote}`
          : "";

      // Build appropriate failure guidance based on whether this is a structural or HTTP test
      let failureDetail;
      if (hasAuthRedirectWarning || isExternalUrl) {
        failureDetail = `\n⛔ WRONG URL: Your http_request called ${testedUrl || "an external URL"} — this is the LIVE PRODUCTION SITE, not the local development server.\nThe production site has authentication (Azure AD / SSO) and returns a login page on HTTP 200, which does NOT reflect your local code changes.\nYou MUST use the LOCAL DEV URL from your system prompt for all http_request calls. Check the [LOCAL DEV URL] section at the top of your context.\nExample: http_request(url="http://thescopes.local/?flush=1")`;
      } else if (isStructuralAcceptance) {
        if (!calledStructuralTool) {
          failureDetail =
            `\nThis is a STRUCTURAL acceptance test — it verifies code patterns and DB state, NOT a live web page.\n` +
            `Do NOT use http_request for this test (the CMS admin requires authentication; unauthenticated requests return a login redirect).\n\n` +
            `You MUST run the structural checks using execute_bash or read_file:\n` +
            `  1. grep -rn "removeByName" app/src/ — confirm the problematic pattern is gone\n` +
            `  2. read_file the relevant YAML/PHP file(s) to quote the correct content\n` +
            `  3. run_sake (db:build) if schema verification is needed\n` +
            `  4. Report: "ACCEPTANCE TEST PASSED — [criterion 1]: [tool output], [criterion 2]: [tool output]"\n\n` +
            `Do NOT return an empty array []. Do NOT output NO_CHANGES_NEEDED. Call the tools and quote their output.`;
        } else {
          failureDetail =
            `\nYou ran structural tool checks but did not report "ACCEPTANCE TEST PASSED".\n` +
            `Quote the tool output that confirms EACH criterion from the acceptance criteria:\n` +
            `  - For grep results: quote the "no matches found" output or the matching lines\n` +
            `  - For read_file: quote the relevant file content that proves the state is correct\n` +
            `  - For db:build: quote the exit code and "Build completed" line\n` +
            `Then explicitly report: "ACCEPTANCE TEST PASSED — [criterion]: [evidence], [criterion]: [evidence]"`;
        }
      } else if (hasFailed) {
        failureDetail = "\nYour response reported ACCEPTANCE TEST FAILED — diagnose the missing component and fix it, then re-curl.";
      } else if (!hasHttpEvidence) {
        failureDetail =
          "\nYou have not called the http_request tool yet. You MUST call http_request to fetch the page and inspect the HTML response body. HTTP 200 alone is not acceptance — you need to confirm the SUCCESS evidence HTML is present.\nIf the URL is unknown: read the project .env file (grep -E '^SS_BASE_URL' .env) to find the base URL, then call http_request(url='<BASE_URL>/?flush=1').";
      } else {
        failureDetail =
          "\nYou called http_request but did not report 'ACCEPTANCE TEST PASSED'. You must:\n1. Inspect the response HTML body for the SUCCESS evidence described in the subtask\n2. Quote the specific HTML snippet that proves the feature is live\n3. If the SUCCESS evidence is absent: diagnose what is missing and fix it, then re-curl\n4. Once evidence is confirmed: explicitly report 'ACCEPTANCE TEST PASSED — [feature]: [quoted snippet]'";
      }

      const mainInstruction = isStructuralAcceptance
        ? `ACCEPTANCE TEST subtask requires structural verification — grep, read_file, and execute_bash evidence.\n\nDo NOT use http_request (CMS admin requires authentication). Run the structural checks from the acceptance criteria.`
        : `ACCEPTANCE TEST subtask requires live HTTP evidence — not file writes, not db:build output.\n\nYou must use http_request to fetch the page and find the SUCCESS evidence HTML in the response body.\nHTTP 200 alone is not acceptance. "db:build succeeded" is not acceptance.`;

      return {
        verifierFeedback: "FAIL",
        coderRetryCount: newRetryCount,
        messages: [{
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]

${mainInstruction}
${failureDetail}
${criteriaHint}

CURRENT SUBTASK:
${currentTask}${capWarning}`,
        }],
      };
    }

    if (isExecutionOnlyTask(currentTask)) {
      const needsCommandEvidence =
        REQUIRES_COMMAND_RE.test(currentTask) || VERIFY_FIX_RE.test(currentTask);

      if (
        needsCommandEvidence &&
        !calledExecutionTool(state.lastToolsExecuted)
      ) {
        const newRetryCount = (state.coderRetryCount ?? 0) + 1;
        log(
          colors.red(
            `  [Graph] -> Execution task requires command tool call - none found. Retry ${newRetryCount}/${effectiveMaxRetries}.`,
          ),
        );

        const isComposer = /composer/i.test(currentTask);
        const isPhpunit = /phpunit|test/i.test(currentTask);
        const toolHint = isComposer
          ? "Required: call the 'run_composer' tool (e.g. run_composer install or run_composer update -W)"
          : isPhpunit
            ? "Required: call the 'run_phpunit' tool"
            : "Required: call 'execute_bash', 'run_composer', or 'run_phpunit' with the appropriate command.";

        const atCap = newRetryCount >= effectiveMaxRetries;
        const capWarning = atCap
          ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not call the required tool in this response, this subtask will be force-skipped.`
          : "";

        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetryCount,
          messages: [
            {
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK]
CRITICAL: Your response contained only text. You did NOT actually run any commands.

${toolHint}

You MUST call the appropriate tool (run_composer, run_phpunit, or execute_bash) in your VERY NEXT response and include the REAL output. Do NOT write a summary or verification document until you have run the actual command and can show the real output.

If the command fails, report the real error. Do not fabricate success.

CURRENT SUBTASK:
${currentTask}${capWarning}`,
            },
          ],
        };
      }

      // Even for execution-only tasks: if the command itself returned errors,
      // do NOT auto-pass - force the coder to fix the failures first.
      // Exception: if ALL errors are environment-level issues (DNS, permissions)
      // that code changes cannot fix, escalate to the user and auto-advance
      // rather than burning retries on an unwinnable loop.
      if (state.lastExecutionErrors?.length > 0) {
        const newRetryCount = (state.coderRetryCount ?? 0) + 1;

        // Classify each error: environment issue vs real code defect.
        const classified = state.lastExecutionErrors.map((e) => ({
          ...e,
          envError: classifyEnvironmentError(e.summary),
        }));
        const envErrors = classified.filter((e) => e.envError !== null);
        const codeErrors = classified.filter((e) => e.envError === null);

        // If every error is environmental AND we have already retried once,
        // the coder cannot fix this - escalate rather than loop.
        if (envErrors.length > 0 && codeErrors.length === 0 && newRetryCount >= 2) {
          const envDescriptions = [...new Set(envErrors.map((e) => e.envError.description))];
          log(
            colors.yellow(
              `  [Graph] -> Verifier: all execution errors are environmental (${envErrors.map((e) => e.envError.type).join(", ")}). Auto-advancing after ${newRetryCount} retries.`,
            ),
          );
          eventBus.emit("system_message", {
            text: `⚠️ Automated verification blocked by environment issue - ${envDescriptions[0]} Manual verification may be required.`,
            type: "warning",
          });
          emitTaskCompleted(state);
          const taskLabel =
            state.subtasks?.[state.currentSubtaskIndex]?.task || "environment-blocked subtask";
          await commitVerifiedSubtask(state.projectDir, taskLabel);
          return { verifierFeedback: "ENVIRONMENT_BLOCKED" };
        }

        const errorLines = state.lastExecutionErrors
          .map((e) => `[${e.tool}]\n${e.summary}`)
          .join("\n\n");

        // Parse the stack trace for structured file:line location data so the
        // coder gets a direct pointer to the crash site, not just raw error text.
        const allErrorText = state.lastExecutionErrors.map((e) => e.summary).join("\n\n");
        const parsed = parseStackTrace(allErrorText);
        const parsedBlock = parsed
          ? `\nPARSED ERROR LOCATION:\n${formatParsedError(parsed)}\n`
          : "";

        // Preserve the original error from research so context is never lost on retries.
        const originalErrorBlock = state.originalError
          ? `\nORIGINAL ERROR (from research phase):\n${state.originalError}\n`
          : "";

        // Annotate any environment-noise errors so the coder knows to skip them.
        const envNoteBlock = envErrors.length > 0
          ? `\nNOTE - ENVIRONMENT ISSUE (not a code bug, do not attempt to fix):\n${envErrors.map((e) => `  ${e.envError.type}: ${e.envError.description}`).join("\n")}\n`
          : "";

        log(
          colors.red(
            `  [Graph] -> Verifier blocked: execution command(s) failed. Retry ${newRetryCount}/${effectiveMaxRetries}.`,
          ),
        );
        const atCap = newRetryCount >= effectiveMaxRetries;
        const capWarning = atCap
          ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): This subtask will be force-skipped if the command still fails.`
          : "";
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetryCount,
          messages: [
            {
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK]
The command you ran produced errors. You MUST fix the underlying cause before this subtask can pass.

EXECUTION ERRORS:
${errorLines}
${parsedBlock}${originalErrorBlock}${envNoteBlock}
DEBUGGING STRATEGY:
1. Read the exact file and line number from the error above.
2. Identify what the code does vs. what it should do.
3. Apply the minimal fix using write_file or patch_file.
4. Re-run the command and confirm clean output before declaring success.${capWarning}`,
            },
          ],
        };
      }

      log(
        colors.yellow(
          "  [Graph] -> No files modified, but task is execution-only - auto-passing.",
        ),
      );
      emitTaskCompleted(state);
      const taskLabel =
        state.subtasks?.[state.currentSubtaskIndex]?.task ||
        "execution-only subtask";
      await commitVerifiedSubtask(state.projectDir, taskLabel);
      await closeSubIssueForSubtask(state);
      writeVerificationMarker();
      return { verifierFeedback: "PASS" };
    }

    // If the PM explicitly planned this subtask as file-free (files: []) AND the
    // coder called at least one execution tool, treat it as an execution-only pass.
    // This avoids false "no files written" loops on test/verify subtasks where the
    // PM correctly signalled that no code changes are required.
    const subtaskMetaEarly = state.subtasks?.[state.currentSubtaskIndex];
    const pmPlannedNoFiles =
      Array.isArray(subtaskMetaEarly?.files) && subtaskMetaEarly.files.length === 0;
    if (pmPlannedNoFiles && calledExecutionTool(state.lastToolsExecuted)) {
      log(
        colors.yellow(
          "  [Graph] -> No files modified, PM planned files:[] and execution tool ran - auto-passing.",
        ),
      );
      emitTaskCompleted(state);
      const taskLabelEarly =
        subtaskMetaEarly?.task || "execution-only subtask";
      await commitVerifiedSubtask(state.projectDir, taskLabelEarly);
      await closeSubIssueForSubtask(state);
      writeVerificationMarker();
      return { verifierFeedback: "PASS" };
    }

    // Planned-files-exist gate: if the PM listed specific files for this subtask,
    // each of those files MUST exist on disk (either created this subtask or already
    // present from a prior subtask). Catches the silent failure mode where the coder
    // writes README/package.json edits and ignores the actual planned source files —
    // verifier was previously passing these because state.modifiedFiles was non-empty
    // even though none of the planned files were touched.
    if (Array.isArray(subtaskMetaEarly?.files) && subtaskMetaEarly.files.length > 0 && state.projectDir) {
      const missingPlannedFiles = [];
      const untouchedPlannedFiles = [];
      const modifiedSet = new Set((state.modifiedFiles || []).map(f => path.isAbsolute(f) ? f : path.join(state.projectDir, f)));
      for (const f of subtaskMetaEarly.files) {
        const abs = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
        const exists = await fs.promises.access(abs).then(() => true).catch(() => false);
        if (!exists) {
          missingPlannedFiles.push(f);
        } else if (!modifiedSet.has(abs)) {
          untouchedPlannedFiles.push(f);
        }
      }
      // FAIL if any planned files don't exist at all.
      if (missingPlannedFiles.length > 0) {
        const newRetry = (state.coderRetryCount ?? 0) + 1;
        log(colors.red(`  [Graph] -> Planned-files gate FAILED: ${missingPlannedFiles.length} file(s) missing.`));

        // Detect if the coder printed the file as plain text instead of using write_file
        const lastResp = state.lastCoderResponse || "";
        const missingNames = missingPlannedFiles.map(f => f.split("/").pop());
        const proseDetected = lastResp.length > 300 && missingNames.some(n => lastResp.includes(n));
        const proseNote = proseDetected
          ? `\n\n⚠️ PROSE OUTPUT DETECTED: Your previous response contained the content of ${missingNames.find(n => lastResp.includes(n))} as plain text chat. THIS DID NOT CREATE THE FILE. Printing code in chat is NOT the same as writing it to disk.\n\nYour response must be ONLY a JSON tool call array:\n[{"tool":"write_file","path":"${missingPlannedFiles[0]}","content":"// full file content here"}]`
          : "";

        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetry,
          messages: [{
            role: "user",
            content: `[VERIFIER PLANNED FILES GATE]\n\nThe PM planned this subtask to write the following files, but they do not exist on disk:\n${missingPlannedFiles.map(f => `  - ${f}`).join("\n")}\n\nYou MUST use write_file to create each of these files with the actual implementation. Editing README.md, package.json, or vite.config.js does NOT satisfy this subtask — write the planned source files.${proseNote}`,
          }],
        };
      }
      // FAIL if all planned files exist but none were modified this subtask
      // AND the coder did write some other files (state.modifiedFiles non-empty).
      // This catches the "coder edits package.json instead of the planned source"
      // pattern. Skip when modifiedFiles is empty (the no-files gate handles that).
      if (untouchedPlannedFiles.length === subtaskMetaEarly.files.length && (state.modifiedFiles?.length ?? 0) > 0) {
        const newRetry = (state.coderRetryCount ?? 0) + 1;
        log(colors.red(`  [Graph] -> Planned-files gate FAILED: planned files exist but were not modified this subtask.`));
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetry,
          messages: [{
            role: "user",
            content: `[VERIFIER PLANNED FILES GATE]\n\nThe PM planned this subtask to modify the following files, but you didn't write to any of them this turn:\n${untouchedPlannedFiles.map(f => `  - ${f}`).join("\n")}\n\nYou modified other files (${(state.modifiedFiles || []).map(f => path.basename(f)).slice(0,5).join(", ")}) instead. You MUST use write_file or patch_file on the planned files to satisfy this subtask. Re-edit them with the actual implementation described in the subtask.`,
          }],
        };
      }
    }

    // Project setup gate: fires when package.json was written this subtask.
    // Ensures .gitignore (with node_modules) exists and package.json has no
    // fake "#key" entries. Catches the two most common new-project setup failures.
    // Trigger when package.json exists in the project root — not just when it was
    // written on this turn. The "modifiedFiles only includes this turn" semantics
    // mean the gate would silently no-op on retry turns (when the coder doesn't
    // re-write package.json), letting subtask 1 pass without .gitignore.
    const pkgJsonExistsForGate = state.projectDir
      ? await fs.promises
          .access(path.join(state.projectDir, "package.json"))
          .then(() => true)
          .catch(() => false)
      : false;
    if (pkgJsonExistsForGate && state.projectDir) {
      const setupErrors = await checkProjectSetup(state.projectDir);
      if (setupErrors.length > 0) {
        const newRetry = (state.coderRetryCount ?? 0) + 1;
        log(colors.red(`  [Graph] -> Project setup gate FAILED. Retry ${newRetry}/${effectiveMaxRetries}.`));
        eventBus.emit("system_message", { text: "✗ Project setup check failed — missing .gitignore or fake deps", type: "warning" });
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetry,
          messages: [
            {
              role: "user",
              content: `[VERIFIER PROJECT SETUP GATE]\n\n${setupErrors.join("\n\n")}\n\nFix ALL of the above before this subtask can pass.`,
            },
          ],
        };
      }

    }

    // Auto npm install: run whenever package.json exists in the project root and
    // node_modules does not. Independent of which subtask wrote package.json — this
    // ensures node_modules is present for devServer/visualVerify on later subtasks
    // even when the scaffold was committed in a prior turn.
    if (state.projectDir) {
      const pkgJsonExists = await fs.promises
        .access(path.join(state.projectDir, "package.json"))
        .then(() => true)
        .catch(() => false);
      if (pkgJsonExists) {
        const nodeModulesExists = await fs.promises
          .access(path.join(state.projectDir, "node_modules"))
          .then(() => true)
          .catch(() => false);
        if (!nodeModulesExists) {
          log(colors.dim("  [Setup] node_modules missing — running npm install..."));
          try {
            await execAsync("npm install --prefer-offline", {
              cwd: state.projectDir,
              timeout: 180000,
            });
            log(colors.green("  [Setup] npm install completed"));
          } catch (err) {
            log(colors.yellow(`  [Setup] npm install failed (non-fatal): ${err.stderr?.slice(0, 200) || err.message?.slice(0, 120)}`));
          }
        }
      }
    }

    // Auto-pass if all planned files already exist on disk with content.
    // Handles the case where files were written in a prior subtask and the coder
    // correctly skips re-writing them — but produces no write_file calls, triggering
    // this false "no files written" loop.
    const subtaskFilesForAutoPass = state.subtasks?.[state.currentSubtaskIndex]?.files;
    if (Array.isArray(subtaskFilesForAutoPass) && subtaskFilesForAutoPass.length > 0 && state.projectDir) {
      const allExist = await Promise.all(
        subtaskFilesForAutoPass.map(async (f) => {
          const abs = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
          try {
            const stat = await fs.promises.stat(abs);
            return stat.size > 20; // non-trivial content
          } catch {
            return false;
          }
        })
      );
      if (allExist.every(Boolean)) {
        log(colors.yellow(`  [Graph] -> No files written, but all ${subtaskFilesForAutoPass.length} planned file(s) already exist on disk — auto-passing subtask.`));
        emitTaskCompleted(state);
        const taskLabelAutoPass = state.subtasks?.[state.currentSubtaskIndex]?.task || "subtask";
        await commitVerifiedSubtask(state.projectDir, taskLabelAutoPass);
        await closeSubIssueForSubtask(state);
        writeVerificationMarker();
        return { verifierFeedback: "PASS" };
      }
    }

    const newRetryCount = (state.coderRetryCount ?? 0) + 1;
    log(colors.red(`  [Graph] -> Verifier failed: coder wrote no files. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
    eventBus.emit("system_message", { text: `✗ Retry ${newRetryCount}: no files written - nudging coder`, type: "warning" });
    const atCap = newRetryCount >= effectiveMaxRetries;
    const capWarning = atCap
      ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not write or modify a file in this response, this subtask will be force-skipped.`
      : "";

    // Surface the expected files, line range, and implementation note from the
    // subtask plan so the coder knows exactly what to write without re-reading files.
    const subtaskMeta = state.subtasks?.[state.currentSubtaskIndex];
    const subtaskFiles = subtaskMeta?.files;
    const fileHint = subtaskFiles?.length > 0
      ? `\nExpected files to write/modify:\n${subtaskFiles.map((f) => `  - ${f}`).join("\n")}`
      : "";
    const lineRangeHint = subtaskMeta?.lineRange
      ? `\nTarget line range: ${subtaskMeta.lineRange}`
      : "";
    const implNoteHint = subtaskMeta?.implementationNote
      ? `\nWhat to change (from Scope Document):\n${subtaskMeta.implementationNote}`
      : "";

    // Detect the "prose output" failure mode: the coder printed file content as
    // plain text in the response instead of using a write_file tool call.
    // Signs: response is long AND contains a likely filename from the expected files
    // OR contains markdown headers that suggest the model was printing file content.
    const lastResponse = state.lastCoderResponse || "";
    const responseIsLong = lastResponse.length > 300;
    const targetFilename = subtaskFiles?.[0]?.split("/").pop() ?? "";
    const responseContainsTargetFilename = targetFilename && lastResponse.includes(targetFilename);
    const responseContainsMarkdown = /^#{1,3} /m.test(lastResponse);
    const isProsaicOutput = responseIsLong && (responseContainsTargetFilename || responseContainsMarkdown);

    const proseExamplePath = subtaskFiles?.[0] || "src/example.js";
    const proseWarning = isProsaicOutput
      ? `\n\n⚠️ PROSE OUTPUT DETECTED: Your response contained what appears to be file content printed as plain text. THIS DOES NOT CREATE THE FILE. The content was discarded.\nYou MUST use the write_file tool with the actual file path. Example:\n[{"tool": "write_file", "path": "${proseExamplePath}", "content": "...full file content here..."}]`
      : "";

    // Ground-truth filesystem snapshot: show which expected files are missing vs.
    // already exist. This breaks DeepSeek's confabulation pattern where it "recalls"
    // writing a file from earlier conversation context and skips the write_file call.
    let fsStateHint = "";
    if (subtaskFiles?.length > 0 && state.projectDir) {
      const fileStates = subtaskFiles.map((f) => {
        const absPath = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
        const exists = fs.existsSync(absPath);
        return `  ${exists ? "✓ EXISTS" : "✗ MISSING"}: ${absPath}`;
      });
      // Also list the actual contents of directories containing missing files
      const missingDirs = new Set(
        subtaskFiles
          .filter((f) => {
            const absPath = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
            return !fs.existsSync(absPath);
          })
          .map((f) => {
            const absPath = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
            return path.dirname(absPath);
          }),
      );
      const dirListings = [];
      for (const dir of missingDirs) {
        try {
          const entries = fs.readdirSync(dir);
          dirListings.push(`  ${dir}/: [${entries.join(", ")}]`);
        } catch {
          // dir doesn't exist yet — no listing
        }
      }
      fsStateHint =
        `\n\nFILESYSTEM STATE (actual disk state — not conversation history):\n` +
        fileStates.join("\n") +
        (dirListings.length > 0
          ? `\n\nActual directory contents:\n${dirListings.join("\n")}`
          : "");
    }

    return {
      verifierFeedback: "FAIL",
      coderRetryCount: newRetryCount,
      messages: [
        {
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]
You did not write or modify any files in your last response. This task requires concrete code changes.

CRITICAL INSTRUCTION: You MUST use 'write_file' or 'patch_file' in your very next response to implement the subtask below. Do not explain what you will do - execute the tool immediately.

CURRENT SUBTASK:
${currentTask}${fileHint}${lineRangeHint}${implNoteHint}${fsStateHint}${proseWarning}${capWarning}`,
        },
      ],
    };
  }

  const currentTask =
    state.subtasks?.[state.currentSubtaskIndex]?.task ||
    "Complete the implementation";

  // Planned-files gate (files-written path): if the PM listed specific files for
  // this subtask and the coder wrote NONE of them (wrote different files instead),
  // fail early. This catches the debugger-writes-App.tsx-for-CapturedPieces pattern
  // where a wrong file happens to compile, causing a false PASS.
  {
    const subtaskPlan = state.subtasks?.[state.currentSubtaskIndex];
    if (
      Array.isArray(subtaskPlan?.files) &&
      subtaskPlan.files.length > 0 &&
      state.projectDir
    ) {
      const modifiedAbsSet = new Set(
        (state.modifiedFiles || []).map((f) =>
          path.isAbsolute(f) ? f : path.join(state.projectDir, f),
        ),
      );
      const anyPlanFileTouched = subtaskPlan.files.some((f) => {
        const abs = path.isAbsolute(f) ? f : path.join(state.projectDir, f);
        return modifiedAbsSet.has(abs);
      });
      if (!anyPlanFileTouched) {
        const newRetry = (state.coderRetryCount ?? 0) + 1;
        log(
          colors.red(
            `  [Graph] -> Planned-files gate FAIL: coder wrote ${(state.modifiedFiles || []).map((f) => path.basename(f)).join(", ")} but none of the planned files.`,
          ),
        );
        return {
          verifierFeedback: "FAIL",
          coderRetryCount: newRetry,
          messages: [
            {
              role: "user",
              content:
                `[VERIFIER PLANNED FILES GATE]\n\n` +
                `You wrote files but NONE of the PM-planned files for this subtask were among them.\n\n` +
                `Expected to write (at least one of):\n` +
                subtaskPlan.files.map((f) => `  - ${f}`).join("\n") +
                `\n\nYou actually modified: ` +
                (state.modifiedFiles || []).map((f) => path.basename(f)).slice(0, 5).join(", ") +
                `\n\nYou MUST use write_file or patch_file on one of the planned files above to satisfy this subtask.`,
            },
          ],
        };
      }
    }
  }

  // Unity UI Toolkit asset files (UXML, USS) are implementation output that
  // doesn't require C# compilation. Short-circuit to PASS immediately so the
  // asset subtask isn't blocked waiting for a dotnet build that can't run.
  if (isUnityAssetOnlyChange(state.modifiedFiles)) {
    log(
      colors.green(
        "  [Graph] -> Verifier: Unity asset-only change (UXML/USS) - skipping compilation check.",
      ),
    );
    emitTaskCompleted(state);
    const assetTaskLabel =
      state.subtasks?.[state.currentSubtaskIndex]?.task || "Unity asset subtask";
    await commitVerifiedSubtask(state.projectDir, assetTaskLabel);
    await closeSubIssueForSubtask(state);
    writeVerificationMarker();
    return { verifierFeedback: "PASS" };
  }

  // Swift asset files (.storyboard, .xib, .xcassets, .strings) are implementation
  // output that doesn't require Swift compilation. Short-circuit to PASS so the
  // subtask isn't blocked waiting for xcodebuild that can't run in the pipeline.
  if (isSwiftAssetOnlyChange(state.modifiedFiles)) {
    log(
      colors.green(
        "  [Graph] -> Verifier: Swift asset-only change (storyboard/xib/xcassets) - skipping compilation check.",
      ),
    );
    emitTaskCompleted(state);
    const assetTaskLabel =
      state.subtasks?.[state.currentSubtaskIndex]?.task || "Swift asset subtask";
    await commitVerifiedSubtask(state.projectDir, assetTaskLabel);
    await closeSubIssueForSubtask(state);
    writeVerificationMarker();
    return { verifierFeedback: "PASS" };
  }

  // Skip this check for documentation pipeline tasks - writing only .md files
  // IS the correct outcome for taskType === "documentation".
  if (isDocsOnlyChange(state.modifiedFiles) && IMPLEMENTATION_RE.test(currentTask) && state.taskType !== "documentation") {
    const newRetryCount = (state.coderRetryCount ?? 0) + 1;
    log(colors.red(`  [Graph] -> Verifier failed: only documentation files written for a code-change task. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
    const atCap = newRetryCount >= effectiveMaxRetries;
    const capWarning = atCap
      ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If you do not modify a source or config file in this response, this subtask will be force-skipped.`
      : "";
    return {
      verifierFeedback: "FAIL",
      coderRetryCount: newRetryCount,
      messages: [
        {
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]
You wrote only documentation or markdown files, but this subtask requires actual code changes.

CRITICAL INSTRUCTION: You MUST use 'write_file' or 'patch_file' in your very next response to modify the specific source or configuration file(s) called out in the subtask. Do NOT write planning documents, analysis files, or markdown summaries - implement the change directly.

CURRENT SUBTASK:
${currentTask}${capWarning}`,
        },
      ],
    };
  }

  // CSS/JSX class-name consistency gate (React/Vue projects).
  // When a .css file was written, require the coder to explicitly confirm that
  // every selector in the CSS matches a className used in the JSX/TSX — before
  // the subtask can pass. Catches the common failure where the coder invents a
  // new naming convention (e.g. BEM .square.light) that doesn't match the JSX
  // (e.g. className="light-square"). This is checked on the FIRST pass — the
  // coder must have run a read_file on the JSX before we can trust the CSS.
  // CSS/JSX class-name consistency gate (React/Vue projects).
  // When a .css file was written on the FIRST attempt (coderRetryCount === 0),
  // require the coder to explicitly verify that every CSS selector matches a
  // className in the JSX before the subtask can pass. Catches the common failure
  // where the coder invents a new naming convention (e.g. .square.light) that
  // doesn't match the JSX (e.g. className="light-square"). Only fires once per
  // subtask to avoid consuming all retries on the consistency check alone.
  const cssFilesWritten = (state.modifiedFiles || []).filter(f => f.endsWith('.css'));
  if (cssFilesWritten.length > 0) {
    // Check if the last coder response included reading a JSX/TSX file.
    // This is the evidence that the coder actually verified class name consistency.
    // Pattern: JSON tool call with "read_file" and a .jsx/.tsx path.
    const lastResp = state.lastCoderResponse || "";
    const readJsxEvidence = /"read_file"[^}]{1,200}\.(jsx|tsx)/.test(lastResp) ||
      /read_file[^\n]{1,100}\.(jsx|tsx)/.test(lastResp);

    if (!readJsxEvidence) {
      const jsxPaths = (state.modifiedFiles || []).filter(f => /\.(jsx|tsx)$/.test(f));
      const jsxHint = jsxPaths.length > 0
        ? `JSX files written this subtask: ${jsxPaths.join(", ")}`
        : `Check the JSX/TSX component that imports ${cssFilesWritten.map(f => f.split('/').pop()).join(", ")}.`;
      const newCssRetry = (state.coderRetryCount ?? 0) + 1;
      log(colors.yellow(`  [Graph] -> CSS written but no JSX read detected — requiring CSS/JSX class-name consistency verification.`));
      return {
        verifierFeedback: "FAIL",
        coderRetryCount: newCssRetry,
        messages: [{
          role: "user",
          content: `[VERIFIER CSS CONSISTENCY CHECK]
You wrote a CSS file (${cssFilesWritten.map(f => f.split('/').pop()).join(", ")}) but did not read the JSX component to verify class name consistency. Before this subtask can pass, you MUST verify that every CSS selector matches a className actually used in the JSX.

MANDATORY STEPS:
1. Call read_file on the JSX component(s) that import this CSS.
2. List every className string used in the JSX (e.g. className="board", className="square light-square selected-square").
3. For each CSS class selector (.board, .square, .light-square, etc.) confirm it appears as a className in the JSX.
4. CRITICAL: .square.light (compound selector) ≠ .light-square (single hyphenated class). JSX className="light-square" requires CSS .light-square { }, NOT .square.light { }.
5. If ANY mismatch: fix the CSS selector (or JSX className) so they match exactly.
6. Once verified and any fixes applied: output [] to complete.

${jsxHint}

Do NOT output [] without reading the JSX first. The verifier checks your response for evidence of read_file on a .jsx or .tsx file.`,
        }],
      };
    }
  }

  // TypeScript compilation gate: for React/TypeScript projects, run tsc --noEmit to
  // catch type errors in written .ts/.tsx files before accepting the subtask.
  // Mirrors the Swift swiftc -typecheck gate so TypeScript gets the same static analysis.
  const hasTsFiles = (state.modifiedFiles || []).some(f => /\.(ts|tsx)$/.test(f));
  if (hasTsFiles && state.projectDir) {
    try {
      // Use the project's local tsc binary (from devDependencies) — faster than npx
      const localTsc = path.join(state.projectDir, "node_modules/.bin/tsc");
      const hasTsc = await fs.promises.access(localTsc).then(() => true).catch(() => false);

      if (hasTsc) {
        const tsconfigs = ["tsconfig.app.json", "tsconfig.json"];
        let tsconfigFlag = "";
        for (const tc of tsconfigs) {
          try {
            await fs.promises.access(path.join(state.projectDir, tc));
            tsconfigFlag = `-p ${tc}`;
            break;
          } catch { /* not found */ }
        }

        const tscResult = await execAsync(
          `"${localTsc}" --noEmit ${tsconfigFlag} 2>&1 || true`,
          { cwd: state.projectDir },
        ).catch((e) => ({ stdout: e.stdout || "", stderr: e.stderr || "", status: 1 }));

        const tscOutput = (tscResult.stdout || "").trim();
        // Surface ALL TypeScript errors across the whole project — not just modified files.
        // Filtering to modified files caused errors to accumulate silently across subtasks,
        // producing a project that "passed" every individual check but failed npm run build.
        // The coder is expected to fix any errors it finds, even in files it didn't write,
        // because all files are part of the same codebase and must compile together.
        const modifiedBaseNames = new Set((state.modifiedFiles || []).map(f => path.basename(f)));
        const allTscErrors = tscOutput
          .split("\n")
          .filter(l => l.includes("error TS") || (l.includes(": error") && l.includes(".ts")))
          .slice(0, 25);

        // Split into "your errors" (in files you wrote) vs "pre-existing errors" so the
        // coder knows what's urgent vs what's a carry-over from a prior subtask.
        const myErrors = allTscErrors.filter(l => [...modifiedBaseNames].some(n => l.includes(n)));
        const otherErrors = allTscErrors.filter(l => !myErrors.includes(l));

        const tscErrors = allTscErrors.join("\n").trim();

        if (tscErrors) {
          const newRetryCount = (state.coderRetryCount ?? 0) + 1;
          log(colors.red(`  [Graph] -> TypeScript typecheck found errors. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
          eventBus.emit("system_message", { text: `✗ Retry ${newRetryCount}: compilation/syntax errors - reverting and retrying`, type: "warning" });
          await archiveAndRevert(state);
          const atCap = newRetryCount >= effectiveMaxRetries;
          const capWarning = atCap
            ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): Fix ALL TypeScript errors in this response.`
            : "";

          const myErrorsSection = myErrors.length > 0
            ? `\nErrors in files YOU wrote this subtask (fix these first):\n${myErrors.join("\n")}`
            : "";
          const otherErrorsSection = otherErrors.length > 0
            ? `\nErrors in files from earlier subtasks (fix these too — they block npm run build):\n${otherErrors.join("\n")}`
            : "";

          return {
            verifierFeedback: "FAIL",
            coderRetryCount: newRetryCount,
            messages: [{
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK — TYPESCRIPT ERRORS]\n\nThe TypeScript compiler found errors. ALL must be fixed before this subtask can pass.${myErrorsSection}${otherErrorsSection}\n\nCommon causes: unused imports, wrong parameter types, missing type annotations, dead code.\n\nCURRENT SUBTASK:\n${currentTask}${capWarning}`,
            }],
          };
        }
      }
    } catch (tscCheckErr) {
      log(colors.dim(`  [Verifier] TypeScript check skipped: ${tscCheckErr.message?.slice(0, 80)}`));
    }
  }

  // Build gate: run `npm run build` for TypeScript/Vite projects.
  // Catches bundling errors, import path issues, and missing exports that tsc --noEmit misses.
  // Runs only when: package.json exists AND build script calls tsc or vite build.
  // Also catches broken package.json (missing scripts) when vite.config.ts is present.
  // Skipped on early subtasks (index < 3) to avoid blocking scaffolding.
  const subtaskIndex = state.currentSubtaskIndex ?? 0;
  if (state.projectDir && subtaskIndex >= 3) {
    try {
      const pkgPath = path.join(state.projectDir, "package.json");
      const pkgRaw = await fs.promises.readFile(pkgPath, "utf8").catch(() => null);
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        const buildScript = pkg.scripts?.build || "";
        const isTsOrViteBuild = /\btsc\b|\bvite build\b/.test(buildScript);

        // Detect corrupted package.json: vite.config.ts present but no build script.
        // This happens when the coder repeatedly rewrites package.json and loses the scripts section.
        const hasViteConfig = await fs.promises.access(path.join(state.projectDir, "vite.config.ts")).then(() => true).catch(() => false);
        const hasSrcDir = await fs.promises.access(path.join(state.projectDir, "src")).then(() => true).catch(() => false);
        const isViteProject = hasViteConfig && hasSrcDir;
        const isMissingBuildScript = !pkg.scripts?.build;
        const isMissingReactDeps = isViteProject && !pkg.dependencies?.react && !pkg.devDependencies?.react;
        if (isViteProject && (isMissingBuildScript || isMissingReactDeps)) {
          const missingFields = [];
          if (isMissingBuildScript) missingFields.push('scripts.build (e.g. "vite build")');
          if (isMissingReactDeps) missingFields.push('dependencies.react and dependencies.react-dom');
          const newRetryCount = (state.coderRetryCount ?? 0) + 1;
          log(colors.red(`  [Verifier] Corrupted package.json detected — missing: ${missingFields.join(", ")}. Retry ${newRetryCount}.`));
          eventBus.emit("system_message", { text: `✗ Retry ${newRetryCount}: package.json is missing required fields`, type: "warning" });
          await archiveAndRevert(state);
          const atCap = newRetryCount >= effectiveMaxRetries;
          const capWarning = atCap ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): Fix ALL issues.` : "";
          return {
            verifierFeedback: "FAIL",
            coderRetryCount: newRetryCount,
            messages: [{
              role: "user",
              content: `[VERIFIER AUTOMATED FEEDBACK — BROKEN PACKAGE.JSON]\n\nThis is a Vite/React project (vite.config.ts exists) but package.json is missing required fields:\n${missingFields.map(f => `  • ${f}`).join("\n")}\n\nThe package.json has been REVERTED to the last good version. Read package.json with read_file to see its current state, then add ONLY the missing fields using patch_file.\n\nDo NOT rewrite package.json from scratch — read it first, then patch only what is missing.\n\nRequired package.json structure for a Vite/React project:\n{\n  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },\n  "dependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" },\n  "devDependencies": { "@vitejs/plugin-react": "...", "vite": "...", "typescript": "..." }\n}\n\nCURRENT SUBTASK:\n${currentTask}${capWarning}`,
            }],
          };
        }

        if (isTsOrViteBuild) {
          log(colors.dim("  [Verifier] Running npm run build to verify no compile/bundle errors..."));
          const buildResult = await execAsync("npm run build 2>&1", {
            cwd: state.projectDir,
            timeout: 120000,
          }).catch((e) => ({ stdout: e.stdout || e.message || "", status: 1 }));
          const buildOutput = (buildResult.stdout || "").trim();
          const buildFailed = buildResult.status !== 0;
          if (buildFailed) {
            // Surface only the most relevant error lines (skip progress/verbose output)
            const errorLines = buildOutput
              .split("\n")
              .filter(l => /error|Error|failed|FAILED|✗|×/.test(l) && !/^>/.test(l))
              .slice(0, 20)
              .join("\n")
              .trim() || buildOutput.slice(-1500);
            const newRetryCount = (state.coderRetryCount ?? 0) + 1;
            log(colors.red(`  [Verifier] Build failed. Retry ${newRetryCount}/${effectiveMaxRetries}.`));
            eventBus.emit("system_message", { text: `✗ Retry ${newRetryCount}: npm run build failed`, type: "warning" });
            await archiveAndRevert(state);
            const atCap = newRetryCount >= effectiveMaxRetries;
            const capWarning = atCap
              ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): Fix ALL build errors.`
              : "";
            return {
              verifierFeedback: "FAIL",
              coderRetryCount: newRetryCount,
              messages: [{
                role: "user",
                content: `[VERIFIER AUTOMATED FEEDBACK — BUILD FAILED]\n\nnpm run build failed. The project must build cleanly before this subtask can pass.\n\nBuild errors:\n${errorLines}\n\nFix all errors. Check for: TypeScript type mismatches, missing exports, wrong import paths, unused variables with noUnusedLocals enabled.\n\nCURRENT SUBTASK:\n${currentTask}${capWarning}`,
              }],
            };
          } else {
            log(colors.green("  [Verifier] Build passed ✓"));
          }
        }
      }
    } catch (buildCheckErr) {
      log(colors.dim(`  [Verifier] Build gate skipped: ${buildCheckErr.message?.slice(0, 80)}`));
    }
  }

  // Stub detection gate: catches implementation files that contain return-nothing stubs
  // such as `return []`, `return false`, `return null` in named functions — the classic
  // anti-pattern where the coder scaffolds the shape but leaves logic empty.
  // Fires on every attempt — stubs are never acceptable regardless of retry count.
  if (true) {
    const implFiles = (state.modifiedFiles || []).filter(f =>
      /\.(js|ts|jsx|tsx|mjs)$/.test(f) && !/\.test\.|\.spec\./.test(f)
    );
    const stubPatterns = [
      // function body that is ONLY a return of an empty/falsy value
      /\bfunction\s+\w+\s*\([^)]*\)\s*\{\s*return\s+\[\s*\]\s*;?\s*\}/,
      /\bfunction\s+\w+\s*\([^)]*\)\s*\{\s*return\s+false\s*;?\s*\}/,
      /\bfunction\s+\w+\s*\([^)]*\)\s*\{\s*return\s+null\s*;?\s*\}/,
      // arrow function stubs: const foo = () => []
      /=\s*\([^)]*\)\s*=>\s*\[\s*\]/,
      // TODO / FIXME / placeholder comments indicating unfinished logic
      /\/\/\s*(TODO|FIXME|IMPLEMENT|PLACEHOLDER|stub|not yet implemented)/i,
    ];
    const stubsFound = [];
    for (const filePath of implFiles) {
      try {
        const content = await fs.promises.readFile(filePath, "utf8");
        for (const pattern of stubPatterns) {
          if (pattern.test(content)) {
            stubsFound.push({ file: path.basename(filePath), pattern: pattern.source.slice(0, 60) });
            break;
          }
        }

        // Extra check: function where ALL parameters are _-prefixed (all inputs ignored)
        // combined with a body that only returns a constant — definite stub.
        // Catches the pattern: function isLegalMove(_board, _from, _to, ...) { return true; }
        if (!stubsFound.some(s => s.file === path.basename(filePath))) {
          const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(([^)]+)\)\s*(?::[^{]+)?\s*\{([^}]{0,500})\}/gs;
          let funcMatch;
          while ((funcMatch = funcRegex.exec(content)) !== null) {
            const params = funcMatch[1];
            const body = funcMatch[2];
            // Check all parameter names start with _
            const paramNames = params.split(",")
              .map(p => p.trim().split(/[\s:=<(]/)[0].replace(/^\.\.\./,"").trim())
              .filter(Boolean);
            const allIgnored = paramNames.length >= 2 && paramNames.every(p => p.startsWith("_"));
            // Check body only returns a constant (true/false/null/0/"")
            const bodyTrimmed = body.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
            const onlyReturnsConstant = /^(?:if\s*\([^)]+\)\s*\{[^}]*return\s+(?:true|false|null|0|""|'');?\s*\}\s*)?return\s+(?:true|false|null|0|""|'');\s*$/.test(bodyTrimmed);
            if (allIgnored && onlyReturnsConstant) {
              stubsFound.push({ file: path.basename(filePath), pattern: "all parameters _-prefixed + body returns constant (all inputs ignored)" });
              break;
            }
          }
        }
      } catch {
        // file unreadable — skip
      }
    }
    if (stubsFound.length > 0) {
      const stubList = stubsFound.map(s => `  - ${s.file}: matched /${s.pattern.slice(0,80)}/`).join("\n");
      const newRetryCount = (state.coderRetryCount ?? 0) + 1;
      log(colors.red(`  [Graph] -> Stub detection gate FAILED: ${stubsFound.length} stub(s) found.`));
      return {
        verifierFeedback: "FAIL",
        coderRetryCount: newRetryCount,
        messages: [{
          role: "user",
          content: `[VERIFIER STUB DETECTION]
The following files contain stub implementations — functions that return empty arrays, false, null, or a constant boolean without any real logic:

${stubList}

This violates the ANTI-STUB RULE. You MUST replace each stub with a real implementation.

Examples of stubs that were detected:
  - function getLegalMoves(piece, board) { return []; }                        ← STUB — no moves calculated
  - const isCheck = () => false;                                               ← STUB — always returns false
  - function validate() { return null; }                                       ← STUB — no validation
  - function isLegalMove(_board, _from, _to, ...) { return true; }            ← STUB — all inputs ignored

Fix: implement the actual logic. The function body must contain real computation, not just a bare return of [] / false / null / true.`,
        }],
      };
    }
  }

  // Build-failure gate: if the coder ran a framework build command that exited
  // non-zero, block the subtask even though files were written.
  // A changed file cannot pass verification if the framework rejected it at build
  // time (e.g. YAML syntax error, invalid extension class, broken Injector config).
  // This check runs BEFORE httpSmoke so we never hit "HTTP 200 from Apache fallback"
  // as a false positive when the real problem is a failed db:build.
  if (state.lastExecutionErrors?.length > 0) {
    const buildErrors = state.lastExecutionErrors.filter(
      (e) => BUILD_COMMAND_RE.test(e.summary?.slice(0, 400) || ""),
    );
    if (buildErrors.length > 0) {
      const newRetryCount = (state.coderRetryCount ?? 0) + 1;
      log(colors.red(
        `  [Graph] -> Verifier blocked: framework build command failed. Retry ${newRetryCount}/${effectiveMaxRetries}.`,
      ));
      eventBus.emit("system_message", {
        text: `✗ Retry ${newRetryCount}: build command failed — fix the error and re-run`,
        type: "warning",
      });

      const errorLines = buildErrors.map((e) => `[${e.tool}]\n${e.summary}`).join("\n\n");
      const allErrorText = buildErrors.map((e) => e.summary).join("\n\n");
      const parsed = parseStackTrace(allErrorText);
      const parsedBlock = parsed
        ? `\nPARSED ERROR LOCATION:\n${formatParsedError(parsed)}\n`
        : "";

      // Check for a missing class/module/type reference error across all supported languages.
      // Distinguishes "format bug" (config serialisation mismatch — class exists but ref is
      // malformed) from "genuinely missing" (dependency not installed/created). Each case
      // produces targeted diagnostic steps rather than the generic YAML debugging advice.
      const classRefErr = classifyClassReferenceError(allErrorText);
      const extErrBlock = classRefErr
        ? `
CLASS REFERENCE ERROR DETECTED [${classRefErr.language.toUpperCase()}]:
${classRefErr.ownerClass ? `  Owner     : ${classRefErr.ownerClass}\n` : ""}  Bad ref   : ${classRefErr.badRef}
  Context   : ${classRefErr.context}
  Diagnosis : ${classRefErr.isFormatBug
    ? "FORMAT BUG — the reference format is wrong. The dependency exists but cannot be resolved due to a config/escaping/import issue."
    : "MISSING DEPENDENCY — the class/module/type was not found by the runtime."}
  Likely cause: ${classRefErr.likelyCause}

FIX STEPS:
${classRefErr.fixHint}
`
        : "";

      const atCap = newRetryCount >= effectiveMaxRetries;
      const capWarning = atCap
        ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): This subtask will be force-skipped if the build still fails.`
        : "";

      return {
        verifierFeedback: "FAIL",
        coderRetryCount: newRetryCount,
        messages: [{
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]
Your changes compiled but the framework build command failed with errors. You MUST fix the underlying cause before this subtask can pass.

BUILD COMMAND ERRORS:
${errorLines}${parsedBlock}${extErrBlock}${extErrBlock ? "" : `
DEBUGGING STRATEGY:
1. Read the exact file and line number from the error above.
2. For YAML errors: check indentation, class name backslashes, and extension keys.
3. Apply the minimal fix using write_file or patch_file.
4. Re-run the build command and confirm clean output before declaring success.

Do NOT skip the build command or declare success without a clean build.`}${capWarning}`,
        }],
      };
    }
  }

  const validationResult = await runAdvancedValidator(
    state.projectDir,
    state.modifiedFiles,
  );

  if (!validationResult.ok) {
    const newRetryCount = (state.coderRetryCount ?? 0) + 1;
    log(
      colors.red(
        `  [Graph] -> Verifier failed. Archiving broken state and reverting... Retry ${newRetryCount}/${effectiveMaxRetries}.`,
      ),
    );
    eventBus.emit("system_message", { text: `✗ Retry ${newRetryCount}: compilation/syntax errors - reverting and retrying`, type: "warning" });

    await archiveAndRevert(state);

    const atCap = newRetryCount >= effectiveMaxRetries;
    const capWarning = atCap
      ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${effectiveMaxRetries}): If the errors are not fixed in this response, this subtask will be force-skipped.`
      : "";

    return {
      verifierFeedback: "FAIL",
      coderRetryCount: newRetryCount,
      messages: [
        {
          role: "user",
          content: `[VERIFIER AUTOMATED FEEDBACK]
Your last changes caused the following compilation/syntax errors. ALL your changes were reverted to the last known-good state.

ERRORS:
${validationResult.errors.join("\n\n")}

CRITICAL INSTRUCTION:
You MUST use the 'patch_file' or 'write_file' tool in your very next response to fix the specific lines causing this error. Do not explain what you will do or read unrelated files - execute the tool to apply the fix immediately.${capWarning}`,
        },
      ],
    };
  }

  const taskLabel =
    state.subtasks?.[state.currentSubtaskIndex]?.task || "verified subtask";
  log(colors.green(`  [Graph] -> Verifier passed: ${taskLabel.slice(0, 80)}`));
  eventBus.emit("system_message", { text: `✓ Verified: ${taskLabel.slice(0, 100)}`, type: "info" });
  emitTaskCompleted(state);

  await commitVerifiedSubtask(state.projectDir, taskLabel);
  await closeSubIssueForSubtask(state);
  writeVerificationMarker();
  return { verifierFeedback: "PASS" };
}

/**
 * Public export — wraps _verifierImpl to append:
 *   1. Confidence scoring (emitted as confidence_update, stored in state)
 *   2. Reflexion memory (generated on meaningful FAIL; emitted + stored in state)
 *   3. Smoke screenshot propagation into state for vision-augmented verification
 */
export async function verifierNode(state) {
  // Capture any smoke screenshot taken during the coder turn (before _verifierImpl
  // runs its own smoke test via runAdvancedValidator → checkHttpSmoke).
  const screenshotData = getLastSmokeScreenshot();

  const result = await _verifierImpl(state);

  const feedback = result.verifierFeedback;
  const retries = result.coderRetryCount ?? (state.coderRetryCount ?? 0);
  const score = computeConfidence(state, feedback, retries);
  const subtaskIndex = state.currentSubtaskIndex ?? 0;

  eventBus.emit("confidence_update", {
    subtaskIndex,
    score,
    feedback,
    retries,
    t: Date.now(),
  });

  const confidenceEntry = { subtaskIndex, score, retries, t: Date.now() };

  // Propagate screenshot into state so future verifier runs (and the UI) have it.
  const screenshotUpdate = screenshotData ? { lastSmokeScreenshot: screenshotData } : {};

  // Emit a structured subtask_status event so the UI gets a clear signal on
  // both PASS and FAIL with confidence and file details — not just confidence_update.
  const currentSubtask = state.subtasks?.[subtaskIndex];
  eventBus.emit("subtask_status", {
    index: subtaskIndex,
    total: state.subtasks?.length || 1,
    label: currentSubtask?.task || "",
    feedback,
    score,
    retries,
    modifiedFiles: state.modifiedFiles || [],
    t: Date.now(),
  });

  // Generate a reflexion lesson for meaningful FAIL cases where there is real
  // coder output to learn from. Skip: coderFailed (connectivity), no coder
  // response, or trivial "no files written on first attempt".
  const shouldReflect =
    feedback === "FAIL" &&
    !state.coderFailed &&
    (state.lastCoderResponse?.length ?? 0) > 50 &&
    (state.coderRetryCount ?? 0) >= 0;

  if (shouldReflect) {
    const lesson = await generateReflexionLesson(state);
    if (lesson) {
      log(colors.dim(`  [Reflexion] Lesson: ${lesson}`));
      const entry = { subtaskIndex, lesson, t: Date.now() };
      eventBus.emit("reflexion_memory_update", entry);
      return {
        ...result,
        ...screenshotUpdate,
        confidenceHistory: [confidenceEntry],
        reflexionMemory: [entry],
      };
    }
  }

  // On a clean first-pass PASS, record a positive marker for the memory system.
  // Positive signals from memoryUpdateNode let future sessions know what approaches
  // work cleanly, complementing the failure-only reflexion (Shinn et al. 2023).
  if (feedback === "PASS" && (state.coderRetryCount ?? 0) === 0 && currentSubtask) {
    const positiveEntry = {
      subtaskIndex,
      lesson: `✓ First-pass success: "${currentSubtask.task?.slice(0, 60)}" — approach worked without retries`,
      positive: true,
      t: Date.now(),
    };
    return {
      ...result,
      ...screenshotUpdate,
      confidenceHistory: [confidenceEntry],
      reflexionMemory: [positiveEntry],
    };
  }

  return { ...result, ...screenshotUpdate, confidenceHistory: [confidenceEntry] };
}
