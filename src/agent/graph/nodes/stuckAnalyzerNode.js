/**
 * stuckAnalyzerNode.js
 *
 * Fires when the coder has exhausted all retry attempts on a subtask and the
 * system would otherwise force-advance past it. Rather than giving up, this
 * node does a deep strategic analysis of WHY all previous attempts failed —
 * not just the last one — and produces a fundamentally revised approach.
 *
 * After analysis, the coder's retry counter is reset to 0 so it gets a
 * completely fresh round with the new strategy. The subtask is only truly
 * force-advanced if this second round ALSO exhausts all retries
 * (stuckAnalysisAttempted prevents a second firing).
 *
 * Failure patterns this node specifically investigates:
 *   - PHANTOM PATHS: File paths in the scope document that don't exist on disk.
 *     Uses find_file to locate the real paths and patches the scope document.
 *   - ENVIRONMENT BLOCKS: DNS failures, permission errors, etc. that can't be
 *     fixed by code. Identifies these and revises the verification strategy.
 *   - WRONG APPROACH: The coder's logic was fundamentally incorrect. Reads the
 *     actual code, understands the real structure, and prescribes a different fix.
 *   - INACTION LOOP: The coder kept producing prose instead of tool calls.
 *     Provides a step-by-step implementation plan with exact file/line/content.
 */

import { streamText } from "ai";
import { getMcpBoundTools } from "../../tools/sdkRegistry.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { personaMeta } from "../personas.js";
import { classifyEnvironmentError } from "#agent/utils/executionOutputAnalysis.js";

const PERSONA = personaMeta("stuckAnalyzer");

/**
 * Summarises the message history to extract a compact log of what was tried.
 * Looks for coder summaries, verifier feedback, and ensemble rejections.
 * Caps at 3000 chars so it fits in the prompt without drowning it.
 */
function buildAttemptHistory(messages, maxLen = 3000) {
  const relevant = messages.filter((m) => {
    const c = typeof m.content === "string" ? m.content : "";
    return (
      c.includes("VERIFIER AUTOMATED FEEDBACK") ||
      c.includes("ENSEMBLE REVIEW FEEDBACK") ||
      c.includes("RETRY CONTEXT") ||
      c.includes("DEBUG REPORT") ||
      c.includes("VERDICT:") ||
      (m.role === "assistant" && c.length > 50)
    );
  });

  const snippets = relevant.slice(-12).map((m) => {
    const c = typeof m.content === "string" ? m.content : "";
    const label = m.role === "assistant" ? "CODER" : "SYSTEM";
    return `[${label}] ${c.slice(0, 300).replace(/\n+/g, " ")}`;
  });

  const joined = snippets.join("\n\n");
  return joined.length > maxLen ? joined.slice(0, maxLen) + "\n...[truncated]" : joined;
}

/**
 * Identifies the dominant failure pattern across all attempts.
 * Returns one of: "phantom_paths" | "env_blocked" | "inaction" | "wrong_logic"
 */
function classifyFailurePattern(messages, lastExecutionErrors) {
  const allContent = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  // Environment blocks (DNS, permissions) — check last errors first
  if (lastExecutionErrors?.length > 0) {
    const allEnv = lastExecutionErrors.every((e) => classifyEnvironmentError(e.summary) !== null);
    if (allEnv) return "env_blocked";
  }

  // Phantom paths — repeated "File not found" or "search_block not found"
  const notFoundCount = (allContent.match(/File not found|search_block not found|\[ERROR: File not found\]/gi) || []).length;
  if (notFoundCount >= 2) return "phantom_paths";

  // Inaction — repeated "did not write any files"
  const inactionCount = (allContent.match(/did not write.*file|no files.*modified|write or modify/gi) || []).length;
  if (inactionCount >= 3) return "inaction";

  return "wrong_logic";
}

export async function stuckAnalyzerNode(state, config) {
  log(colors.yellow("  [Graph] -> 🧠 Running Stuck Analyzer — deep failure-pattern investigation..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Re-analysing strategy after repeated failures" });
  eventBus.emit("phase_change", { phase: "RESEARCHING", label: "Re-analysing strategy..." });

  const currentSubtask = state.subtasks?.[state.currentSubtaskIndex];
  const taskDescription = currentSubtask?.task || state.messages?.[0]?.content || "";
  const originalTask = state.messages?.[0]?.content || "";
  const scopeDocument = state.scopeDocument || "";
  const lastErrors = state.lastExecutionErrors || [];
  const retryCount = state.coderRetryCount ?? 0;

  const failurePattern = classifyFailurePattern(state.messages, lastErrors);
  log(colors.dim(`  [Graph] -> 🧠 Failure pattern: ${failurePattern} (after ${retryCount} retries)`));

  const attemptHistory = buildAttemptHistory(state.messages);

  // Build pattern-specific investigation instructions
  const patternInstructions = {
    phantom_paths: `
FAILURE PATTERN DETECTED: PHANTOM FILE PATHS
The coder repeatedly tried to patch files that don't exist at the expected locations.
Your primary job is to find where these files ACTUALLY live.

INVESTIGATION STEPS:
1. For every file path mentioned in the scope document, call find_file with just the filename (not the directory). Example: find_file("ElementPromotionalTiles_ElementalArea.ss")
2. If find_file returns no results, try a broader search: execute_bash with: find /project-root -name "*PartialName*" -type f
3. Once you have the correct paths, read each file to confirm it contains the content that needs changing.
4. In your REVISED STRATEGY, list only CONFIRMED paths — mark each as "✓ verified at [actual-path]".`,

    env_blocked: `
FAILURE PATTERN DETECTED: ENVIRONMENT BLOCKAGE
The verification is blocked by environment issues (DNS failures, file permissions) that code changes cannot fix.

INVESTIGATION STEPS:
1. Confirm the code changes themselves were correctly applied — read the modified files.
2. Try an alternative verification approach that doesn't rely on the blocked resource:
   - For DNS failures: use "http://localhost" instead of the external hostname
   - For assets/.htaccess permissions: use execute_bash to check if templates compiled (check var/www/*/silverstripe-cache for .php files)
   - For other permissions: identify if the core task (template fix, config change) is achievable without the blocked operation
3. Identify whether the actual fix is correct even if automated verification can't confirm it.
4. In your REVISED STRATEGY, specify a verification approach that WILL work in this environment.`,

    inaction: `
FAILURE PATTERN DETECTED: CODER INACTION LOOP
The coder repeatedly produced text responses instead of JSON tool calls.

INVESTIGATION STEPS:
1. Read the target file(s) from the scope document NOW — get the actual content and line numbers.
2. Identify EXACTLY what line(s) need to change and what the new content should be.
3. Your REVISED STRATEGY must be a step-by-step implementation plan so concrete that the coder only needs to execute it — no thinking required.
   Format: "Call write_file on [exact-path] with this exact content: [content]"
   or: "Call patch_file on [exact-path], replacing [exact-old-line] with [exact-new-line]"`,

    wrong_logic: `
FAILURE PATTERN DETECTED: INCORRECT APPROACH
The coder's approach was logically wrong — files were modified but the fix didn't work.

INVESTIGATION STEPS:
1. Read the CURRENT state of the target files (they may have been partially modified).
2. Understand what the code is ACTUALLY doing vs what it needs to do.
3. Check if the scope document's diagnosis was correct — the researcher may have misidentified the root cause.
4. Read adjacent files that might be involved (callers, parents, configs).
5. Identify a DIFFERENT approach that addresses the actual root cause.`,
  };

  const envNotes = lastErrors.length > 0
    ? `\nLAST EXECUTION ERRORS:\n${lastErrors.map((e) => `  [${e.tool}] ${e.summary.slice(0, 200)}`).join("\n")}`
    : "";

  const scopeSection = scopeDocument
    ? `\nCURRENT SCOPE DOCUMENT (may contain errors — verify before trusting):\n${scopeDocument.slice(0, 2000)}${scopeDocument.length > 2000 ? "\n...[truncated]" : ""}`
    : "";

  const systemPrompt = `You are a Senior Strategic Analyst. A subtask has failed after ${retryCount} attempts.
Your job is NOT to debug one error — it is to understand WHY EVERY ATTEMPT FAILED and produce a fundamentally new strategy.

ORIGINAL TASK:
${originalTask.slice(0, 800)}

CURRENT SUBTASK:
${taskDescription}
${scopeSection}
HISTORY OF FAILED ATTEMPTS (last ${Math.min(retryCount, 12)} attempts):
${attemptHistory}
${envNotes}

${patternInstructions[failurePattern] || patternInstructions.wrong_logic}

RULES:
- Use tools aggressively. Read the actual files — do NOT guess.
- Use find_file before assuming any path from the scope document is correct.
- Read the real file content at the real path before prescribing a fix.
- Your strategy must be different from every approach already tried.
- Be concrete: exact file paths (verified), exact line ranges, exact content to write.
- Do NOT exceed 15 tool calls — stay focused on the specific failure pattern above.

At the end of your analysis, write a section titled exactly:
## REVISED STRATEGY

Under that heading, write:
- **Pattern**: What was wrong with all previous attempts (one sentence)
- **Root cause**: The actual underlying problem
- **Correct path(s)**: Exact file path(s), confirmed with find_file/read_file
- **What to change**: Exact content changes needed (specific enough to execute without re-reading)
- **Verification approach**: How to confirm the fix worked in THIS environment
- **What to avoid**: List of approaches already tried that must NOT be repeated`;

  const context = {
    rootDir: state.projectDir,
    ignore: state.ignore,
    requireWriteFile: false,
    readOnly: true,
    allowedDirs: state.contextDirs || [],
    signal: config?.signal ?? null,
  };

  let fullText = "";
  let revisedStrategy = null;
  let revisedScopeDocument = null;

  // ── SDK path ────────────────────────────────────────────────────────────────
  if (state.model) {
    try {
      const { textStream } = streamText({
        model: state.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Analyse the failures and produce a revised strategy for: ${taskDescription}` },
        ],
        tools: await getMcpBoundTools(context),
        maxSteps: 15,
        abortSignal: config?.signal ?? null,
      });

      for await (const part of textStream) {
        fullText += part;
        eventBus.emit("message_chunk", { chunk: part });
      }
      eventBus.emit("message_complete", {});
    } catch (err) {
      log(colors.yellow(`  [Graph] -> 🧠 Stuck analyzer error (non-fatal): ${err.message}`));
    }
  }

  // ── Automation-API path ─────────────────────────────────────────────────────
  else if (state.provider) {
    const _start = Date.now();
    const _ticker = setInterval(() => {
      const elapsed = Math.round((Date.now() - _start) / 1000);
      eventBus.emit("spinner_update", { status: `Stuck Analyzer — deep investigation (${elapsed}s)...` });
    }, 10000);

    try {
      const result = await state.provider.sendTurn(
        [{ role: "system", content: systemPrompt }, { role: "user", content: `Analyse the failures and produce a revised strategy for: ${taskDescription}` }],
        "stuck-analyzer",
        context,
      );
      fullText = result.text ?? "";
      if (fullText) eventBus.emit("message_complete", { text: fullText });
    } catch (err) {
      log(colors.yellow(`  [Graph] -> 🧠 Stuck analyzer error (non-fatal): ${err.message}`));
    } finally {
      clearInterval(_ticker);
    }
  }

  // Extract the REVISED STRATEGY section for injection into the next coder turn
  const strategyMatch = fullText.match(/##\s*REVISED STRATEGY[\s\S]*$/i);
  if (strategyMatch) {
    revisedStrategy = strategyMatch[0].slice(0, 3000);
    log(colors.green("  [Graph] -> 🧠 Revised strategy extracted."));

    // If the strategy contains confirmed file paths that differ from the scope
    // document, build a revised scope document so the coder uses correct paths.
    const scopeLines = revisedStrategy.match(/✓ verified at [^\n]+/g);
    if (scopeLines && scopeLines.length > 0) {
      revisedScopeDocument = scopeDocument
        ? `${scopeDocument}\n\n[STUCK ANALYZER CORRECTIONS — USE THESE PATHS]\n${scopeLines.join("\n")}`
        : `[STUCK ANALYZER VERIFIED PATHS]\n${scopeLines.join("\n")}`;
    }
  } else {
    // Fallback: use the full output as the strategy hint
    revisedStrategy = fullText.trim().slice(0, 2000) || null;
    if (revisedStrategy) {
      log(colors.yellow("  [Graph] -> 🧠 No structured strategy found — using full output as debug hint."));
    }
  }

  if (!revisedStrategy) {
    log(colors.yellow("  [Graph] -> 🧠 Stuck analyzer produced no usable output — coder will retry with pattern classification only."));
    // Produce a minimal fallback strategy so the coder at least knows the failure pattern
    revisedStrategy = [
      `## REVISED STRATEGY`,
      `- **Pattern**: ${failurePattern.replace(/_/g, " ")}`,
      `- **What to avoid**: All approaches tried in the previous ${retryCount} attempts`,
      `- **Next step**: Use find_file to locate the target file before attempting any patch`,
    ].join("\n");
  }

  log(colors.green(`  [Graph] -> 🧠 Stuck analysis complete. Resetting coder for fresh attempt.`));

  // Format the debug report so it integrates with the existing debugSection
  // injection in coderNode — same format as debuggerNode produces.
  const debugReportBlock = [
    `ROOT CAUSE: ${failurePattern} — see REVISED STRATEGY below`,
    `EVIDENCE: ${retryCount} failed attempts — see message history`,
    `FIX TARGET: See REVISED STRATEGY — paths have been verified`,
    `RECOMMENDED CHANGE: Follow the REVISED STRATEGY exactly. Do NOT reuse any approach from previous attempts.`,
    `CONFIDENCE: MEDIUM`,
    ``,
    revisedStrategy,
  ].join("\n");

  return {
    // Inject as the debug report so coderNode picks it up in the same slot
    debugReport: debugReportBlock,
    // Use corrected scope document if the analyzer found real paths
    ...(revisedScopeDocument ? { scopeDocument: revisedScopeDocument } : {}),
    // Mark that analysis was done so a second exhaustion causes real force-advance
    stuckAnalysisAttempted: true,
    // Reset retry counter completely — fresh round
    coderRetryCount: 0,
    // Allow the normal debugger to fire again in round 2 if needed
    debugAttempted: false,
    currentPersona: PERSONA.id,
  };
}
