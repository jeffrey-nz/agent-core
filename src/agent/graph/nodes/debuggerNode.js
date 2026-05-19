/**
 * debuggerNode.js
 *
 * Industry-standard "separate investigation from implementation" pattern.
 *
 * Fires when the coder has failed the same subtask twice (coderRetryCount >= 2).
 * Two distinct failure modes are handled differently:
 *
 * MODE A - EXECUTION ERROR (stack trace, syntax error, command failure):
 *   1. Parses the execution error output for exact file:line locations
 *   2. Uses MCP tools to read those specific files/lines (targeted, not broad)
 *   3. Traces the call chain one level up from the crash site
 *   4. Returns a structured DEBUG REPORT with ROOT CAUSE, FIX TARGET
 *
 * MODE B - INACTION (coder produced no files, no execution errors):
 *   1. Reads the files that should be modified (from scope doc + subtask file list)
 *   2. Identifies the current state of the code vs. what the subtask requires
 *   3. Returns a DEBUG REPORT that is effectively a concrete pre-implementation plan:
 *      exact file paths, line numbers, and what to write
 *
 * The retry counter is reset to 1 after debugging so the coder gets one more
 * fresh attempt with the new context before reaching MAX_VERIFIER_RETRIES.
 *
 * Gracefully degrades: if no model/provider is available, or if the AI produces
 * output without the structured block, synthesises a fallback report from available
 * context (stack trace or task description) so the coder always has some guidance.
 */

import { streamText } from "ai";
import { getMcpBoundTools } from "../../tools/sdkRegistry.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { personaMeta } from "../personas.js";
import { parseStackTrace, formatParsedError, extractFilesFromTrace } from "#utils/stackTraceParser.js";
const PERSONA = personaMeta("debugger");

function classifyFailure(executionErrors, parsed) {
  if (executionErrors.length > 0) return "error";
  if (parsed) return "error";
  return "inaction";
}

/**
 * Builds probe questions for MODE A - execution errors with or without stack traces.
 */
function buildErrorProbeQuestions(parsed, executionErrors, taskDescription) {
  const questions = [];

  if (parsed?.root?.file) {
    const { file, line } = parsed.root;
    questions.push(
      `1. Read ${file}${line ? ` around line ${line}` : ""}. What is the code actually doing at the crash site?`,
      `2. Is this code correct for what the task requires, or does it contain a bug?`,
    );
  }

  const appFiles = parsed ? extractFilesFromTrace(parsed) : [];
  if (appFiles.length > 1) {
    questions.push(
      `3. Also read ${appFiles.slice(1, 3).join(" and ")} to understand the calling context.`,
    );
  }

  if (executionErrors?.length > 0) {
    questions.push(
      `4. The following commands failed: ${executionErrors.map((e) => e.tool).join(", ")}. Are the right commands being run, with the right arguments?`,
    );
  }

  questions.push(
    `${questions.length + 1}. What is the single most likely root cause? State it as one sentence: "The error occurs because ___."`,
    `${questions.length + 2}. What is the minimal change needed to fix it? Be specific: which file, which line(s), what to change.`,
  );

  return questions.join("\n");
}

/**
 * Builds probe questions for MODE B - coder produced no files.
 * The goal is to read the target files and produce a concrete implementation plan.
 */
function buildInactionProbeQuestions(currentSubtask, scopeDocument) {
  const files = currentSubtask?.files || [];
  const lineRange = currentSubtask?.lineRange || "";
  const implNote = currentSubtask?.implementationNote || "";

  const constraints = currentSubtask?.constraints
    ? `\nSubtask constraints: ${currentSubtask.constraints}`
    : "";

  // Detect "create new file" tasks - the file doesn't exist yet, so we can't read it.
  // Signs: lineRange is "new file", or all target files are doc/config extensions.
  const isNewFile = lineRange === "new file" || files.every((f) => /\.(md|txt|rst|adoc)$/i.test(f));
  const fileList = files.length > 0
    ? files.slice(0, 4).join(", ")
    : "the files mentioned in the scope document";

  if (isNewFile && implNote) {
    // For new-file creation tasks, the content is already in the scope/impl note.
    // The coder just needs to issue a write_file call - not read anything.
    return [
      `The coder failed to create the new file. The file content is already known - no reads needed.`,
      ``,
      `The coder MUST issue a write_file tool call immediately:`,
      `  { "tool": "write_file", "path": "${files[0] || "docs/output.md"}", "content": "...full content from scope..." }`,
      ``,
      `CRITICAL: The coder outputted the file content as plain text chat - that does NOT create the file.`,
      `The file content must be wrapped in a write_file JSON tool call. Nothing else is required.`,
      ``,
      `FIX TARGET: ${fileList}`,
      `RECOMMENDED CHANGE: Issue write_file with the full file content. The content is in the scope document above.`,
    ].join("\n");
  }

  return [
    `The coder failed to write any files. Your job is to produce a concrete implementation plan so the next coder attempt has no ambiguity about what to do.`,
    ``,
    `1. Read the following files that this subtask needs to modify: ${fileList}`,
    `   ${scopeDocument ? "The scope document (above) has verified file paths - trust those." : "Use list_dir to discover the file structure if needed, then read the relevant files."}`,
    `2. For each file, identify the EXACT lines that need to change and what the new code should be.`,
    `3. State: "The coder needs to modify FILE at LINE(s) X-Y, changing [current code] to [new code]."${constraints}`,
    `4. Make your RECOMMENDED CHANGE specific enough that the coder can execute it as a write_file or patch_file call WITHOUT needing to re-read the files.`,
  ].join("\n");
}

export async function debuggerNode(state, config) {
  log(colors.yellow("  [Graph] -> 🔍 Running Debugger Agent (targeted root-cause investigation)..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Investigating root cause of repeated failure" });
  eventBus.emit("phase_change", { phase: "DEBUGGING", label: "Debugging..." });
  eventBus.emit("session_role_update", {
    role: "auxiliary", status: "active",
    provider: state.provider?.providerName || "unknown",
    task: "debugging",
  });
  log(colors.dim(`  [Sessions] auxiliary active · ${state.provider?.providerName || "unknown"} · debugging`));

  const executionErrors = state.lastExecutionErrors || [];
  const lastResponse = state.lastCoderResponse || "";
  const verifierFeedback = state.verifierFeedback || "";
  const currentSubtask = state.subtasks?.[state.currentSubtaskIndex];
  const taskDescription = currentSubtask?.task || state.messages?.[0]?.content || "";
  const originalError = state.originalError || "";
  const scopeDocument = state.scopeDocument || "";

  // Aggregate all available error text for parsing
  const errorText = [
    ...executionErrors.map((e) => e.summary),
    originalError,
    verifierFeedback,
  ].filter(Boolean).join("\n\n");

  // Parse the stack trace for structured location data
  const parsed = parseStackTrace(errorText);
  const parsedSummary = parsed ? formatParsedError(parsed) : null;

  if (parsedSummary) {
    log(colors.dim(`  [Graph] -> 🔍 Stack trace parsed: ${parsed.type} - ${parsed.frames.length} frame(s)`));
  }

  const failureMode = classifyFailure(executionErrors, parsed, lastResponse);
  log(colors.dim(`  [Graph] -> 🔍 Failure mode: ${failureMode}`));

  const subtaskIdx = (state.currentSubtaskIndex ?? 0) + 1;
  const FAILURE_LABELS = {
    env_blocked: "environment blockage",
    inaction: "coder inaction loop",
    stagnant: "stagnant error (no progress)",
    wrong_output: "incorrect output",
  };
  eventBus.emit("system_message", {
    text: `🔍 Debugger — ${FAILURE_LABELS[failureMode] || failureMode} on subtask ${subtaskIdx}`,
    type: "info",
  });

  const probeQuestions = failureMode === "inaction"
    ? buildInactionProbeQuestions(currentSubtask, scopeDocument)
    : buildErrorProbeQuestions(parsed, executionErrors, taskDescription);

  // Scope section - only inject if the scope doc is short enough to be useful inline.
  const scopeSection = scopeDocument
    ? `\n[SCOPE DOCUMENT - verified file paths from Scoper]\n${
        scopeDocument.length > 2000
          ? scopeDocument.slice(0, 2000) + "\n...[truncated]"
          : scopeDocument
      }\n`
    : "";

  // The debug-report block format is repeated BOTH at the top and bottom of every
  // system prompt. Models frequently complete their analysis and then omit the
  // structured block because they "already answered" above. The top reminder
  // sets the expectation before tool use; the bottom reminder reinforces it.
  const reportFormatReminder = `
⚠️ MANDATORY OUTPUT: Your final message MUST end with this exact fenced block - no exceptions:
\`\`\`debug-report
ROOT CAUSE: [one sentence]
EVIDENCE: [file:line and what you found]
FIX TARGET: [exact file path(s) and line number(s)]
RECOMMENDED CHANGE: [specific, actionable - enough detail for a write_file call]
CONFIDENCE: [HIGH | MEDIUM | LOW]
\`\`\`
Do NOT skip this block. Do NOT paraphrase it as prose. The block is parsed programmatically.`;

  const systemPrompt = failureMode === "inaction"
    ? `You are a Pre-Implementation Analyst. The coder wrote no files - read the relevant code and produce a concrete plan with exact file paths and line numbers.

SUBTASK:
${taskDescription}
${scopeSection}
${lastResponse ? `CODER OUTPUT (excerpt):\n${lastResponse.slice(0, 400)}\n` : ""}
INSTRUCTIONS:
${probeQuestions}

RULES: Read files before planning. Max 5 files. No code changes - produce the debug-report block only.
${reportFormatReminder}`

    : `You are a Debugger Agent. Find the root cause - do NOT fix it.

SUBTASK: ${taskDescription}

ERRORS:
${executionErrors.length > 0
    ? executionErrors.map((e) => `- ${e.tool}: ${e.summary}`).join("\n")
    : "(no execution errors - check coder response below)"}
${parsedSummary ? `\nPARSED LOCATION:\n${parsedSummary}` : ""}
${verifierFeedback ? `\nVERIFIER:\n${verifierFeedback}` : ""}
${originalError ? `\nORIGINAL ERROR:\n${originalError}` : ""}
${scopeSection}
${lastResponse ? `CODER ATTEMPT (excerpt):\n${lastResponse.slice(0, 600)}\n` : ""}
PROBE: ${probeQuestions}

RULES: Read exact files/lines from error. Max 5 files. No code changes.
${reportFormatReminder}`;

  const context = {
    rootDir: state.projectDir,
    ignore: state.ignore,
    allowedDirs: state.contextDirs || [],
    signal: config?.signal ?? null,
    // "debugging" mode → read-only tool list, no directory listing injected
    interactionMode: "debugging",
  };

  let debugReport = null;
  let fullOutputText = "";

  // ── SDK path (Vercel AI) ────────────────────────────────────────────────────
  if (state.model) {
    try {
      const messages = [
        { role: "system", content: systemPrompt },
        ...state.messages.slice(0, 1), // original user task only
      ];

      const { textStream } = streamText({
        model: state.model,
        messages,
        tools: /** @type {import('ai').ToolSet} */ (await getMcpBoundTools(context)),
        // Inaction mode needs more steps: list → read files → synthesise plan
        maxSteps: failureMode === "inaction" ? 10 : 6,
        abortSignal: config?.signal ?? null,
      });

      for await (const part of textStream) {
        fullOutputText += part;
        eventBus.emit("message_chunk", { chunk: part });
      }
      eventBus.emit("message_complete", {});

      debugReport = extractDebugReport(fullOutputText);
      log(colors.yellow(`  [Graph] -> 🔍 Debug report: ${debugReport ? "extracted" : "not found in output"}`));
    } catch (err) {
      log(colors.yellow(`  [Graph] -> 🔍 Debugger agent error (non-fatal): ${err.message}`));
    }
  }

  // ── Automation-API path ─────────────────────────────────────────────────────
  else if (state.provider) {
    try {
      const messages = [
        { role: "system", content: systemPrompt },
        ...state.messages.slice(0, 1),
      ];
      const result = await state.provider.sendTurn(messages, "debugger", context);
      fullOutputText = result.text ?? "";
      if (fullOutputText) eventBus.emit("message_complete", { text: fullOutputText });
      debugReport = extractDebugReport(fullOutputText);
      eventBus.emit("session_role_update", { role: "auxiliary", status: "idle" });
      log(colors.dim(`  [Sessions] auxiliary idle`));
      log(colors.yellow(`  [Graph] -> 🔍 Debug report: ${debugReport ? "extracted" : "not found in output"}`));
    } catch (err) {
      log(colors.yellow(`  [Graph] -> 🔍 Debugger agent error (non-fatal): ${err.message}`));
    }
  }

  // ── Fallback A: synthesise from parsed stack trace ──────────────────────────
  if (!debugReport && parsed) {
    const appFiles = extractFilesFromTrace(parsed);
    debugReport = [
      `ROOT CAUSE: Unconfirmed - stack trace points to ${parsed.type}: ${parsed.message}`,
      `EVIDENCE: Crash site appears to be ${parsed.root ? `${parsed.root.file}${parsed.root.line ? `:${parsed.root.line}` : ""}` : "unknown"}`,
      `FIX TARGET: ${appFiles.slice(0, 2).join(", ") || "unknown"}`,
      `RECOMMENDED CHANGE: Read the crash site and verify the logic is correct for the task requirements`,
      `CONFIDENCE: LOW`,
    ].join("\n");
    log(colors.dim("  [Graph] -> 🔍 Using fallback debug report from stack trace parser."));
  }

  // ── Fallback B: synthesise from task context when AI produced no block ───────
  // Fires when the AI ran tools and produced output but forgot the output format.
  // Also fires for the inaction case when there is no stack trace at all.
  if (!debugReport) {
    const subtaskFiles = currentSubtask?.files?.length > 0
      ? currentSubtask.files.slice(0, 3).join(", ")
      : null;

    if (failureMode === "inaction") {
      debugReport = [
        `ROOT CAUSE: The coder did not write any files - likely uncertain about which file to modify or what to write.`,
        `EVIDENCE: No file writes were recorded. Subtask expected files: ${subtaskFiles || "(not specified in plan)"}.`,
        `FIX TARGET: ${subtaskFiles || "Determine the correct file from the scope document or project structure"}`,
        `RECOMMENDED CHANGE: Use write_file or patch_file to implement: "${taskDescription.slice(0, 200)}"`,
        `CONFIDENCE: LOW`,
      ].join("\n");
    } else if (fullOutputText.trim().length > 50) {
      // AI produced output but no structured block - extract what we can from the text
      const firstLine = fullOutputText.trim().split("\n")[0].slice(0, 200);
      debugReport = [
        `ROOT CAUSE: Debugger produced output but no structured block. Partial analysis: ${firstLine}`,
        `EVIDENCE: See full debugger output in message history`,
        `FIX TARGET: ${currentSubtask?.files?.slice(0, 2).join(", ") || "unknown"}`,
        `RECOMMENDED CHANGE: Review the coder's last attempt and implement the subtask: "${taskDescription.slice(0, 200)}"`,
        `CONFIDENCE: LOW`,
      ].join("\n");
    }

    if (debugReport) {
      log(colors.dim(`  [Graph] -> 🔍 Using synthesised fallback debug report (${failureMode} mode).`));
    }
  }

  if (debugReport) {
    log(colors.yellow(`  [Graph] -> 🔍 Debug complete. Coder retry reset with targeted guidance.`));
  } else {
    log(colors.yellow(`  [Graph] -> 🔍 Debug produced no report - coder will retry with verifier context only.`));
  }

  // Track whether this is the second debugger run (state.debugAttempted already true
  // means the first debug fired earlier in this subtask's retry cycle).
  const isSecondDebug = state.debugAttempted === true;

  return {
    debugReport: debugReport || null,
    // Mark that the debugger has run for this subtask so the first-debug guard
    // does not re-trigger. For the second run, also set debug2Attempted.
    debugAttempted: true,
    debug2Attempted: isSecondDebug ? true : (state.debug2Attempted ?? false),
    // Reset retry count to 1 so the coder gets one more fresh attempt WITH the
    // debug report in context. Only reset if we actually produced useful output -
    // if the debug run itself stalled (no report), don't burn an extra retry.
    coderRetryCount: debugReport ? 1 : undefined,
  };
}

/**
 * Extracts the debug-report block from the debugger's output.
 *
 * Strategy 1: look for the fenced ```debug-report ... ``` block (preferred).
 * Strategy 2: when the AI writes the labelled fields as plain prose (no fence),
 *   scan for the ROOT CAUSE / EVIDENCE / FIX TARGET / RECOMMENDED CHANGE lines
 *   and assemble them into a synthetic block. This handles models that reliably
 *   answer the questions but forget to wrap them in a code fence.
 *
 * Returns the block body as a plain string, or null if nothing usable is found.
 */
function extractDebugReport(text) {
  if (!text) return null;

  // Strategy 1: fenced block
  const fenced = text.match(/```debug-report\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // Strategy 2: labelled prose lines anywhere in the output
  const fields = {
    "ROOT CAUSE": null,
    "EVIDENCE": null,
    "FIX TARGET": null,
    "RECOMMENDED CHANGE": null,
    "CONFIDENCE": null,
  };

  for (const key of Object.keys(fields)) {
    // Match "KEY: value" - value runs to the next labelled line or end of text
    const re = new RegExp(
      `\\b${key}\\s*:\\s*(.+?)(?=\\n(?:ROOT CAUSE|EVIDENCE|FIX TARGET|RECOMMENDED CHANGE|CONFIDENCE)\\s*:|$)`,
      "is",
    );
    const m = text.match(re);
    if (m) fields[key] = m[1].trim();
  }

  const found = Object.values(fields).filter(Boolean);
  if (found.length >= 3) {
    // Enough labelled fields found - assemble a synthetic block
    return Object.entries(fields)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }

  return null;
}
