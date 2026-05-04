import path from "node:path";
import { parseAgentStep } from "./stepParser.js";
import { createLoopState } from "./loopState.js";
import { executeStep } from "./stepExecutor.js";
import { handleNoActivity } from "./protocolEnforcer.js";
import { SESSION_PHASES, isWritePhase } from "../../../../session/phases.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";

export async function runAutomationAgentLoop({
  remoteSessionId,
  rootDir,
  toolContext,
  label,
  initialResponseText,
  send,
  requireWriteFile = true,
  requireTools = false,
}) {
  const state = createLoopState({
    remoteSessionId,
    rootDir,
    toolContext,
    label,
    initialResponseText,
    send,
    requireWriteFile,
    requireTools,
  });

  state.phase = SESSION_PHASES.PLAN;
  let consecutiveParseErrors = 0;
  const MAX_PARSE_ERROR_RETRIES = 3;
  let consecutiveProse = 0;
  const MAX_PROSE_RETRIES = 3;
  let consecutiveToolPlan = 0;
  const MAX_TOOL_PLAN_RETRIES = 3;

  // ── Tool Read-Loop Detection ──────────────────────────────────────────────
  // Process Reward Model signal (Lightman et al. 2023): detect when the agent
  // reads the same file 3+ times without writing it. Repeated reads are
  // non-productive (score 0.5) and indicate the agent is stuck in a planning
  // loop. Inject a write-nudge to break the cycle.
  const fileReadCounts = new Map(); // filepath → consecutive read count (reset on write)
  let consecutiveReadLoop = 0;
  const MAX_READ_LOOP_NUDGES = 2;

  // ── Build-Write Loop Detection ────────────────────────────────────────────
  // Detect when the agent rewrites the same file 3+ times without a passing
  // build. This indicates a failed build-fix loop where the agent keeps
  // guessing at solutions rather than reading the actual error. Inject a
  // targeted "read the exact error" nudge to break the cycle.
  const fileWriteCounts = new Map(); // filepath → total write count in this loop
  let consecutiveFailedBuilds = 0;
  let writeLoopNudgeCount = 0;
  const MAX_WRITE_LOOP_NUDGES = 2;

  // ── Diagnostics Spam Detection ────────────────────────────────────────────
  // PRM signal: get_workspace_diagnostics returning SKIPPED or PASSED and being
  // called again immediately is a zero-reward action. The model sees "SKIPPED"
  // (no project config found) and calls the tool again hoping the result changes.
  // After 2 consecutive no-op diagnostics calls, inject an exit nudge so the
  // model finalizes the subtask instead of looping.
  let consecutiveDiagnosticsNoOp = 0;
  const MAX_DIAGNOSTICS_NOOP = 2;

  // ── Read-Only Write-Block Loop Detection ─────────────────────────────────
  // In read-only mode (researcher/scoper), the agent sometimes gets stuck
  // repeatedly trying to call write_file to "complete" its work. Each attempt
  // is blocked with a clear error, but the agent retries anyway. After 2
  // consecutive rounds where ALL tool calls are blocked write attempts, accept
  // the accumulated research text and exit the loop.
  const READ_ONLY_WRITE_TOOLS = new Set(["write_file", "patch_file", "apply_diff", "delete_file", "move_file"]);
  let consecutiveBlockedWrites = 0;
  const MAX_BLOCKED_WRITE_ROUNDS = 2;

  // ── Bash-Only Loop Detection (read-only + requireTools mode) ─────────────
  // In scoper/researcher phases, the model sometimes gets confused and calls
  // execute_bash with echo/exit commands instead of reading files. These bash
  // calls succeed (not blocked), so they don't trigger the write-block detector.
  // After 2 consecutive rounds where ALL tool calls are bash with no file reads,
  // break early — continuing wastes time and produces no useful scope output.
  const READ_FILE_TOOLS = new Set(["read_file", "find_file", "list_dir", "grep", "search_files"]);
  let consecutiveBashOnly = 0;
  const MAX_BASH_ONLY_ROUNDS = 2;

  for (let step = 0; step < state.maxSteps; step++) {
    if (state.aborted) break;

    // ── EMPTY_RESPONSE early exit ──────────────────────────────────────────
    // When the browser provider returns [EMPTY_RESPONSE], DeepSeek's context is
    // overloaded — sending more follow-ups in the same session won't help and
    // just burns retries. Trigger rotation immediately so the next outer retry
    // starts with a fresh session and a clean context window.
    if (String(state.responseText || "").includes("[EMPTY_RESPONSE]")) {
      log(colors.yellow(
        `  [Protocol] ${state.label}: [EMPTY_RESPONSE] received — triggering session rotation (context overflow).`,
      ));
      eventBus.emit("system_message", {
        text: `⚠️ AI returned empty response (context overflow) — resetting session`,
        type: "warning",
      });
      state.needsRotation = true;
      break;
    }

    const parsed = parseAgentStep(state.responseText);
    const normalized = String(state.responseText || "")
      .toLowerCase()
      .trim();

    if (
      state.phase === SESSION_PHASES.PLAN &&
      !parsed.hasActivity &&
      normalized.includes("planning complete")
    ) {
      break;
    }

    // ── requireTools recovery ────────────────────────────────────────────────
    // For researcher/scoper phases (requireTools: true), ANY response without
    // tool calls is a failure. Send an aggressive retry immediately — do not
    // wait for the EXECUTE phase transition that the normal no-activity logic
    // requires. Copilot365 habitually responds conversationally instead of
    // outputting tool call JSON; this recovery snaps it back on track.
    if (state.requireTools && !parsed.hasActivity && !state.madeProgress) {
      state.consecutiveNoActivity++;

      if (state.consecutiveNoActivity >= 3) {
        log(
          colors.red(
            `\n[Automation API] ${state.label}: no tool calls after 3 recovery attempts — aborting.`,
          ),
        );
        state.aborted = true;
        break;
      }

      log(
        colors.yellow(
          `  [Protocol] ${state.label}: prose response without tool calls — sending tools-required recovery (${state.consecutiveNoActivity}/3).`,
        ),
      );

      state.responseText = await state.send(
        state.remoteSessionId,
        `[TOOL CALL REQUIRED — attempt ${state.consecutiveNoActivity}/3]\n\n` +
          `Your previous response contained NO JSON tool calls. This is a pipeline failure.\n\n` +
          `You MUST output a JSON array of tool calls. Do NOT explain, do NOT ask questions, do NOT output prose.\n` +
          `Your entire response must start with "[" and contain only JSON tool objects.\n\n` +
          `Start immediately with:\n` +
          `[\n  { "tool": "list_dir", "path": "${rootDir}" }\n]\n\n` +
          `Then add more tool calls as needed. Prose = failure. Tools = success. Output tools now.`,
        `${state.label} [tools-required ${state.consecutiveNoActivity}/3]`,
      );
      continue;
    }

    // ── TASK_DONE signal — clean exit from any phase ───────────────────────────
    // The new preferred completion signal. Models output TASK_DONE when all files
    // for the current subtask are written. Detected here (before phase checks) so
    // it exits the loop regardless of phase state.
    {
      const rawText = String(state.responseText || "");
      const hasDone = /\bTASK_DONE\b/.test(rawText);
      if (hasDone && !parsed.hasActivity) {
        log(colors.dim(`  [Protocol] ${state.label}: TASK_DONE signal received — exiting loop.`));
        state.madeProgress = state.madeProgress || true;
        break;
      }
    }

    // ── PLAN phase: reasoning block without tool calls recovery ──────────────
    // isWritePhase(PLAN) === false, so the main recovery block below never fires
    // for the initial coder response. If the model outputs <think>/<tool-plan> with
    // no JSON array in PLAN phase, the loop spins silently until maxSteps. Catch it.
    // Also catches [] / TASK_DONE before any writes — the model thinks the work is
    // already done due to accumulated chat history. Force it to start writing.
    if (
      state.phase === SESSION_PHASES.PLAN &&
      state.requireWriteFile &&
      !state.requireTools &&
      !parsed.hasActivity
    ) {
      const rawText = String(state.responseText || "");
      const hasReasoningBlock = (rawText.includes("<think>") || rawText.includes("<tool-plan>")) && !rawText.includes("[{");
      if (hasReasoningBlock) {
        consecutiveToolPlan++;

        if (consecutiveToolPlan >= MAX_TOOL_PLAN_RETRIES) {
          log(
            colors.red(
              `\n[Automation API] ${state.label}: reasoning block without tool calls after ${MAX_TOOL_PLAN_RETRIES} recovery attempts (PLAN phase) — aborting.`,
            ),
          );
          state.aborted = true;
          break;
        }

        log(
          colors.yellow(
            `  [Protocol] ${state.label}: reasoning block with no JSON tool calls in PLAN phase — requesting continuation (${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}).`,
          ),
        );

        state.responseText = await state.send(
          state.remoteSessionId,
          `[TOOL CALLS MISSING — attempt ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]\n\n` +
            `Your reasoning block was received but you did NOT follow it with any JSON tool calls.\n` +
            `No files were read or written.\n\n` +
            `Output the tool call array NOW (use real paths under ${state.rootDir}):\n` +
            `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]`,
          `${state.label} [toolplan-recovery ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]`,
        );
        state.consecutiveNoActivity = 0;
        continue;
      } else if (!parsed.parseError) {
        // Got [] (empty done-signal) or plain prose with no plan tag.
        // This usually means accumulated chat history made the model think the
        // current subtask is already finished. Force it to begin writing.
        consecutiveToolPlan++;

        if (consecutiveToolPlan >= MAX_TOOL_PLAN_RETRIES) {
          log(
            colors.red(
              `\n[Automation API] ${state.label}: no tool calls after ${MAX_TOOL_PLAN_RETRIES} recovery attempts (PLAN phase) — aborting.`,
            ),
          );
          state.aborted = true;
          break;
        }

        log(
          colors.yellow(
            `  [Protocol] ${state.label}: PLAN phase returned no tool calls (empty or prose) — forcing subtask start (${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}).`,
          ),
        );

        state.responseText = await state.send(
          state.remoteSessionId,
          `[SUBTASK START REQUIRED — attempt ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]\n\n` +
            `Your response contained no tool calls. The current subtask has NOT been started yet — no files have been written.\n\n` +
            `You MUST call write_file or patch_file NOW to begin implementing the subtask.\n` +
            `Use the REAL file path under ${state.rootDir}:\n` +
            `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]\n\n` +
            `Replace "src/filename.js" with the actual file you need to create. Do NOT output [] or prose.`,
          `${state.label} [subtask-start ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]`,
        );
        state.consecutiveNoActivity = 0;
        continue;
      }
    }

    if (parsed.hasActivity) {
      if (state.phase !== SESSION_PHASES.EXECUTE) {
        state.phase = SESSION_PHASES.EXECUTE;
      }
      // Reset on every successful tool call — not just the first one.
      // Without this, parse errors accumulate permanently across a long session:
      // 3 errors during research + 1 during scoping = 4 total → premature break.
      consecutiveParseErrors = 0;
      consecutiveToolPlan = 0;

      // ── Read-loop tracking (update BEFORE executeStep) ──────────────────
      // Track which files are being read repeatedly without writes. We update
      // counts here (from the tool calls the agent is about to make) so we can
      // check for the nudge condition immediately after the step executes.
      if (state.requireWriteFile && !state.requireTools) {
        for (const tc of parsed.toolCalls || []) {
          const toolName = (tc.tool || tc.toolName || "").toLowerCase();
          const fp = tc.args?.path || tc.input?.path || "";
          if (!fp) continue;
          if (toolName === "read_file") {
            fileReadCounts.set(fp, (fileReadCounts.get(fp) || 0) + 1);
          } else if (/^(write_file|patch_file|apply_diff|delete_file|move_file)$/.test(toolName)) {
            fileReadCounts.delete(fp);
            consecutiveReadLoop = 0; // reset on any write
            // Track write counts for build-write loop detection
            fileWriteCounts.set(fp, (fileWriteCounts.get(fp) || 0) + 1);
          }
        }
      }
    }

    if (!parsed.hasActivity && isWritePhase(state.phase)) {
      if (parsed.parseError) {
        // If we already wrote a file, the model is likely summarizing its work rather than
        // issuing more tool calls. Exit cleanly — no need to burn retries on a done subtask.
        if (state.madeProgress) {
          break;
        }

        consecutiveParseErrors++;
        if (consecutiveParseErrors > MAX_PARSE_ERROR_RETRIES) {
          // Give up — repeated attempts to produce valid JSON have failed.
          break;
        }

        // Choose a hint that matches what actually went wrong.
        const rawText = String(state.responseText || "");
        const isReadOnly = state.toolContext?.readOnly;
        const hasBracket = rawText.includes("[") && rawText.includes("]");
        const looksLikeProse = !hasBracket && !rawText.includes("{");
        const looksLikeCode =
          !rawText.includes("{") ||
          rawText.trimStart().startsWith("//") ||
          rawText.trimStart().startsWith("using ") ||
          rawText.trimStart().startsWith("import ") ||
          rawText.trimStart().startsWith("public ") ||
          rawText.trimStart().startsWith("class ");

        const hint = isReadOnly
          ? `You are in a read-only research/scoping phase. If you have finished exploring, respond with an empty array:\n` +
            `\`\`\`json\n[]\n\`\`\`\n\n` +
            `If you still have more files to read, respond with a JSON array of read-only tool calls:\n` +
            `\`\`\`json\n[\n  { "tool": "read_file", "path": "${state.rootDir}/src/filename.js" }\n]\n\`\`\`\n\n` +
            `Do NOT output prose — use \`\`\`json\n[]\n\`\`\` if done.`
          : looksLikeProse
          ? `Your response was plain text with no JSON. You MUST output ONLY a JSON array starting with [ and ending with ].\n\n` +
            `If your subtask is complete, output:\n[\n  { "tool": "execute_bash", "command": "echo done" }\n]\n\n` +
            `If you need to write a file, output:\n` +
            `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.ts", "content": "your content here" }\n]\n\n` +
            `NEVER output explanatory prose. Respond with JSON only.`
          : looksLikeCode
          ? `Your response appears to be raw code or plain text rather than a JSON tool call array.\n\n` +
            `You MUST respond with a JSON array of tool objects, not raw code.\n` +
            `Use a REAL path under ${state.rootDir}. Example:\n` +
            `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]\n\n` +
            `Put the actual file content inside the "content" string — do not write it out directly.`
          : `This is most commonly caused by unescaped double quotes inside a string value. ` +
            `All " characters inside a JSON string must be written as \\". ` +
            `For example, a search_block containing JSON content must look like:\n` +
            `"search_block": "    \\"silverstripe/recipe-cms\\": \\"^5.4\\""\n\n` +
            `Please re-output your tool call array with properly escaped JSON.`;

        state.responseText = await state.send(
          state.remoteSessionId,
          `[PARSE ERROR] Your tool call JSON could not be parsed: ${parsed.parseError}\n\n${hint}`,
          `${state.label} [parse-error recovery ${consecutiveParseErrors}/${MAX_PARSE_ERROR_RETRIES}]`,
        );
        state.consecutiveNoActivity = 0;
        continue;
      }

      consecutiveParseErrors = 0;

      // ── reasoning block without tool calls recovery ───────────────────────
      // Models sometimes output <think>/<tool-plan> without following with JSON.
      // Detect and recover. Not gated by !madeProgress — can happen any time.
      {
        const rawText = String(state.responseText || "");
        if ((rawText.includes("<think>") || rawText.includes("<tool-plan>")) && !rawText.includes("[{")) {
          consecutiveToolPlan++;

          if (consecutiveToolPlan >= MAX_TOOL_PLAN_RETRIES) {
            log(
              colors.red(
                `\n[Automation API] ${state.label}: reasoning block without tool calls after ${MAX_TOOL_PLAN_RETRIES} recovery attempts — aborting.`,
              ),
            );
            state.aborted = true;
            break;
          }

          log(
            colors.yellow(
              `  [Protocol] ${state.label}: reasoning block with no JSON tool calls — requesting continuation (${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}).`,
            ),
          );

          state.responseText = await state.send(
            state.remoteSessionId,
            `[TOOL CALLS MISSING — attempt ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]\n\n` +
              `Your reasoning block was received, but you did NOT follow it with any JSON tool calls.\n` +
              `No files were read or written.\n\n` +
              `Output the JSON tool call array NOW. Use real paths under ${state.rootDir}:\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]`,
            `${state.label} [toolplan-recovery ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }
      consecutiveToolPlan = 0;

      // ── Prose-detection recovery (coder / requireWriteFile mode) ───────────
      // When the coder outputs raw C# / markdown instead of a JSON tool call
      // array, parseToolCalls returns hasActivity=false AND parseError=null
      // (because the response contains no "[{" JSON structure to attempt).
      // Without this guard the turn falls silently through to handleNoActivity,
      // which aborts after 3 counts and marks the turn as a stall.
      //
      // This mirrors the requireTools recovery block (lines 56-87) but targets
      // requireWriteFile-mode (coder role) and looks for code/prose signatures
      // rather than the blanket "no tool calls" check.
      if (state.requireWriteFile && !state.requireTools && !state.madeProgress) {
        const rawText = String(state.responseText || "");
        const looksLikeProse =
          rawText.includes("```") ||
          rawText.trimStart().startsWith("using ") ||
          rawText.trimStart().startsWith("public ") ||
          rawText.trimStart().startsWith("class ") ||
          rawText.trimStart().startsWith("namespace ") ||
          rawText.trimStart().startsWith("import ") ||
          rawText.trimStart().startsWith("export ") ||
          rawText.trimStart().startsWith("interface ") ||
          rawText.trimStart().startsWith("type ") ||
          rawText.trimStart().startsWith("//") ||
          rawText.trimStart().startsWith("/*") ||
          /^(private|protected|internal|static|override|virtual)\s/m.test(rawText) ||
          /^(export\s+)?(const|function|class)\s+[A-Z]/m.test(rawText) ||
          /^(export\s+)?(type|interface)\s+\w/m.test(rawText) ||
          // Long response (> 500 chars) with zero tool calls is almost certainly prose
          (rawText.length > 500 && !rawText.includes("[{"));

        if (looksLikeProse) {
          consecutiveProse++;

          if (consecutiveProse >= MAX_PROSE_RETRIES) {
            log(
              colors.red(
                `\n[Automation API] ${state.label}: prose output after ${MAX_PROSE_RETRIES} recovery attempts — aborting.`,
              ),
            );
            state.aborted = true;
            break;
          }

          log(
            colors.yellow(
              `  [Protocol] ${state.label}: coder output prose instead of tool calls — sending write_file recovery (${consecutiveProse}/${MAX_PROSE_RETRIES}).`,
            ),
          );

          state.responseText = await state.send(
            state.remoteSessionId,
            `[WRITE_FILE REQUIRED — attempt ${consecutiveProse}/${MAX_PROSE_RETRIES}]\n\n` +
              `Your previous response contained file content as prose text (markdown code blocks or raw code). ` +
              `This is a pipeline failure — prose is DISCARDED and no file was written to disk.\n\n` +
              `You MUST call write_file or patch_file with the file content as the "content" argument.\n` +
              `Use the REAL path of the file you want to create (under ${state.rootDir}):\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]\n\n` +
              `Do NOT explain. Output ONLY the JSON tool call array.`,
            `${state.label} [prose-recovery ${consecutiveProse}/${MAX_PROSE_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      consecutiveProse = 0;

      const retry = await handleNoActivity(state);
      if (!retry) break;
      continue;
    }

    if (parsed.hasActivity) {
      // ── Blocked-write loop detection (read-only mode) ─────────────────────
      // Researcher/scoper keep calling write_file after being blocked. When ALL
      // tool calls in a round are write tools that will be blocked, count the
      // round. On the first occurrence, send a targeted "don't write" nudge.
      // On the second, break and accept the current research output.
      if (state.toolContext?.readOnly && state.requireTools) {
        const hasBashCall = parsed.jsonToolCalls.some((tc) =>
          (tc.tool || tc.name || "").toLowerCase() === "execute_bash",
        );
        const hasFileRead = parsed.jsonToolCalls.some((tc) =>
          READ_FILE_TOOLS.has((tc.tool || tc.name || "").toLowerCase()),
        );
        if (hasBashCall && !hasFileRead) {
          consecutiveBashOnly++;
          if (consecutiveBashOnly >= MAX_BASH_ONLY_ROUNDS) {
            log(
              colors.yellow(
                `  [Protocol] ${state.label}: ${consecutiveBashOnly} consecutive bash-only rounds in read-only mode — aborting (no file reads detected).`,
              ),
            );
            state.aborted = true;
            break;
          }
          log(
            colors.yellow(
              `  [Protocol] ${state.label}: bash-only round ${consecutiveBashOnly}/${MAX_BASH_ONLY_ROUNDS} in scoper — no read_file calls detected.`,
            ),
          );
        } else {
          consecutiveBashOnly = 0;
        }
      }

      if (state.toolContext?.readOnly) {
        const allBlocked =
          parsed.jsonToolCalls.length > 0 &&
          parsed.jsonToolCalls.every((tc) =>
            READ_ONLY_WRITE_TOOLS.has((tc.tool || tc.name || "").toLowerCase()),
          );
        if (allBlocked) {
          consecutiveBlockedWrites++;
          if (consecutiveBlockedWrites >= MAX_BLOCKED_WRITE_ROUNDS) {
            log(
              colors.yellow(
                `  [Protocol] ${state.label}: ${consecutiveBlockedWrites} consecutive blocked-write rounds in read-only mode — accepting current output and exiting loop.`,
              ),
            );
            break;
          }
          // First occurrence: execute so the agent sees the blocked result,
          // then inject an explicit "output as text" nudge before continuing.
          await executeStep(state, parsed, step);
          state.responseText = await state.send(
            state.remoteSessionId,
            `[READ-ONLY REMINDER]\n\n` +
              `write_file and patch_file are BLOCKED in the research/scoping phase. ` +
              `You cannot write files here — the coder will do that later.\n\n` +
              `Your job is to OUTPUT YOUR FINDINGS AS TEXT in your response. ` +
              `Do NOT call write_file again. Instead, respond with your findings in plain text, ` +
              `or call read-only tools (read_file, list_dir, grep, find_file) if you still need to explore.`,
            `${state.label} [read-only nudge ${consecutiveBlockedWrites}/${MAX_BLOCKED_WRITE_ROUNDS}]`,
          );
          consecutiveParseErrors = 0;
          continue;
        } else {
          consecutiveBlockedWrites = 0;
        }
      }

      // ── Wrong-tool detection in coder mode (BEFORE executeStep) ──────────────
      // In requireWriteFile (coder) mode, all tool calls should eventually be
      // write_file/patch_file. If the model uses unrecognized tools like
      // docs_write_page or message instead, redirect it immediately.
      if (state.requireWriteFile && !state.requireTools && !state.madeProgress) {
        const VALID_CODER_TOOLS = new Set([
          "write_file", "patch_file", "apply_diff", "delete_file", "move_file",
          "read_file", "list_dir", "find_file", "grep", "search_files", "outline_file",
          "execute_bash", "run_npm", "run_yarn", "run_pnpm",
          "run_sake", "run_composer", "http_request",
        ]);
        const unknownTools = parsed.jsonToolCalls
          .map((tc) => (tc.tool || tc.name || "").toLowerCase())
          .filter((n) => n && !VALID_CODER_TOOLS.has(n));
        if (unknownTools.length > 0 && unknownTools.length < parsed.jsonToolCalls.length) {
          // Mixed: some valid + some invalid — valid tools will execute, invalid will fail at dispatcher
          log(colors.yellow(`  [Protocol] ${state.label}: coder mixed valid and unknown tools (${unknownTools.join(", ")}) — unknown tools will be rejected by dispatcher.`));
        }
        if (unknownTools.length > 0 && unknownTools.length === parsed.jsonToolCalls.length) {
          consecutiveProse++;
          if (consecutiveProse >= MAX_PROSE_RETRIES) {
            log(colors.red(`\n[Automation API] ${state.label}: wrong tools used ${MAX_PROSE_RETRIES} times — aborting.`));
            state.aborted = true;
            break;
          }
          log(colors.yellow(`  [Protocol] ${state.label}: coder used wrong tools (${unknownTools.join(", ")}) — redirecting to write_file (${consecutiveProse}/${MAX_PROSE_RETRIES}).`));

          // Give a tool-specific hint if the unknown tool name suggests a common mistake.
          const isShellLikeTool = unknownTools.some(t =>
            /^(run_npm|run_yarn|run_pnpm|run_jest|run_mocha|npm|yarn|shell|bash_cmd|cmd|terminal|run_command|run_script|execute|exec_bash)$/.test(t)
          );
          const shellHint = isShellLikeTool
            ? `\n\nFor running shell commands (npm install, npm test, etc.), use execute_bash:\n` +
              `[\n  { "tool": "execute_bash", "command": "npm install" }\n]`
            : `\n\nUse the REAL path of the file you need to create/modify (under ${state.rootDir}):\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]`;

          state.responseText = await state.send(
            state.remoteSessionId,
            `[WRONG TOOL — attempt ${consecutiveProse}/${MAX_PROSE_RETRIES}]\n\n` +
              `You called "${unknownTools.join('", "')}" which is not a valid tool. ` +
              `Valid tools are: write_file, patch_file, read_file, list_dir, find_file, grep, execute_bash, apply_diff, delete_file.` +
              shellHint +
              `\n\nDo NOT invent tool names. Use only the tools listed above.`,
            `${state.label} [wrong-tool ${consecutiveProse}/${MAX_PROSE_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      // ── Placeholder-path detection (BEFORE executeStep) ─────────────────────
      // If the model uses a wrong/placeholder path (e.g. /abs/path, your-file.jsx,
      // relative paths, or any path outside the project root), intercept and correct.
      {
        const isWrongPath = (p) => {
          if (!p) return false;
          // Must be an absolute path under rootDir (or one of the allowed dirs)
          if (!p.startsWith("/")) return true; // relative path
          if (state.rootDir && !p.startsWith(state.rootDir)) return true; // outside project
          return false;
        };
        // Only check write_file/patch_file calls — reads may legitimately point elsewhere
        const writeToolNames = new Set(["write_file", "patch_file"]);
        const writeCalls = parsed.jsonToolCalls.filter(tc =>
          writeToolNames.has(tc.tool || tc.name || "")
        );
        const allPlaceholder =
          writeCalls.length > 0 &&
          writeCalls.every((tc) => {
            const p = tc.path || tc.args?.path || tc.input?.path || "";
            return isWrongPath(p);
          });
        if (allPlaceholder) {
          consecutiveProse++;
          if (consecutiveProse >= MAX_PROSE_RETRIES) {
            log(colors.red(`\n[Automation API] ${state.label}: placeholder paths repeated ${MAX_PROSE_RETRIES} times — aborting.`));
            state.aborted = true;
            break;
          }
          const badPath = (writeCalls[0]?.path || writeCalls[0]?.args?.path || "?");
          log(colors.yellow(`  [Protocol] ${state.label}: write_file path "${badPath}" is outside project — injecting correction (${consecutiveProse}/${MAX_PROSE_RETRIES}).`));
          state.responseText = await state.send(
            state.remoteSessionId,
            `[WRONG PATH — attempt ${consecutiveProse}/${MAX_PROSE_RETRIES}]\n\n` +
              `You used "${badPath}" which is not under the project root.\n` +
              `The actual project is at: ${state.rootDir}\n\n` +
              `All file paths MUST start with ${state.rootDir}, for example:\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/types.ts", "content": "..." }\n]\n\n` +
              `Use ONLY absolute paths that start with ${state.rootDir}.`,
            `${state.label} [placeholder-path ${consecutiveProse}/${MAX_PROSE_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      await executeStep(state, parsed, step);

      // ── Diagnostics Spam Nudge (check AFTER executeStep) ──────────────────
      // After running the step, check if the last tool call was get_workspace_diagnostics
      // and the result was SKIPPED or PASSED (a no-op). If so, nudge the model to move on.
      if (state.requireWriteFile && !state.requireTools) {
        const hasDiagnosticsCall = parsed.jsonToolCalls.some(
          (tc) => (tc.tool || tc.name || "").toLowerCase() === "get_workspace_diagnostics"
        );
        if (hasDiagnosticsCall) {
          const lastResult = state.lastToolResults?.find?.(
            (r) => /DIAGNOSTICS (SKIPPED|PASSED)/i.test(r || "")
          ) || (typeof state.lastToolResult === "string" && /DIAGNOSTICS (SKIPPED|PASSED)/i.test(state.lastToolResult) ? state.lastToolResult : null);

          // Check via the response text that came back — it will contain the SKIPPED/PASSED message
          const responseHasNoOp = /DIAGNOSTICS (SKIPPED|PASSED)/i.test(state.responseText || "");
          if (responseHasNoOp || lastResult) {
            consecutiveDiagnosticsNoOp++;
            if (consecutiveDiagnosticsNoOp >= MAX_DIAGNOSTICS_NOOP) {
              consecutiveDiagnosticsNoOp = 0;
              log(colors.yellow(
                `  [Protocol] ${state.label}: diagnostics returned SKIPPED/PASSED ${MAX_DIAGNOSTICS_NOOP}+ times — injecting finalize nudge.`,
              ));
              state.responseText = await state.send(
                state.remoteSessionId,
                `[DIAGNOSTICS COMPLETE — FINALIZE NOW]\n\n` +
                  `get_workspace_diagnostics has already confirmed no errors. ` +
                  `Calling it again will return the same result.\n\n` +
                  `You MUST finalize this subtask now:\n` +
                  `1. If there are more files to write for this subtask, write them immediately with write_file.\n` +
                  `2. If all files have been written, output: TASK_DONE\n\n` +
                  `Do NOT call get_workspace_diagnostics again.`,
                `${state.label} [diagnostics-finalize]`,
              );
              state.consecutiveNoActivity = 0;
              continue;
            }
          } else {
            consecutiveDiagnosticsNoOp = 0;
          }
        } else {
          consecutiveDiagnosticsNoOp = 0;
        }
      }

      // ── Read-loop nudge (check AFTER executeStep) ─────────────────────────
      // If a file has been read 3+ times without a write, inject a targeted
      // write-nudge. This fires at most MAX_READ_LOOP_NUDGES times per session
      // to avoid looping if the model genuinely cannot determine what to write.
      if (state.requireWriteFile && !state.requireTools && consecutiveReadLoop < MAX_READ_LOOP_NUDGES) {
        const loopedFiles = [...fileReadCounts.entries()].filter(([, n]) => n >= 3);
        if (loopedFiles.length > 0) {
          consecutiveReadLoop++;
          const listStr = loopedFiles
            .map(([f, n]) => `  "${path.basename(f)}" (read ${n}x without writing)`)
            .join("\n");
          log(colors.yellow(
            `  [Protocol] ${state.label}: read-without-write loop (${loopedFiles.length} file(s)) — injecting write nudge (${consecutiveReadLoop}/${MAX_READ_LOOP_NUDGES}).`,
          ));
          state.responseText = await state.send(
            state.remoteSessionId,
            `[READ-LOOP DETECTED — write nudge ${consecutiveReadLoop}/${MAX_READ_LOOP_NUDGES}]\n\n` +
              `You have read the following file(s) multiple times without writing them:\n${listStr}\n\n` +
              `Reading more does NOT make progress — you already have the file contents.\n` +
              `You MUST call write_file or patch_file NOW:\n` +
              `[\n  { "tool": "write_file", "path": "<file path>", "content": "<complete content>" }\n]\n\n` +
              `Do NOT read any file again. Write the change immediately.`,
            `${state.label} [read-loop ${consecutiveReadLoop}/${MAX_READ_LOOP_NUDGES}]`,
          );
          loopedFiles.forEach(([f]) => fileReadCounts.delete(f)); // reset after nudge
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      // ── Build-Write Loop nudge (check AFTER executeStep) ──────────────────
      // If the agent rewrites the same file 3+ times AND a build command ran
      // and failed in this loop, it's stuck in a guess-and-rewrite cycle.
      // Inject a targeted "read the EXACT error" message to break it.
      if (state.requireWriteFile && !state.requireTools && writeLoopNudgeCount < MAX_WRITE_LOOP_NUDGES) {
        // Track build outcomes from the response text
        const hasBuildCall = (parsed.jsonToolCalls || []).some((tc) => {
          const cmd = tc.args?.command || tc.input?.command || "";
          return (tc.tool || tc.name || "").toLowerCase() === "execute_bash" &&
            /npm run build|tsc\b/.test(cmd);
        });
        if (hasBuildCall) {
          const buildPassed = !/(?:error TS\d|Error:|FAILED|✗|× )/.test(state.responseText || "");
          if (buildPassed) {
            consecutiveFailedBuilds = 0;
            fileWriteCounts.clear(); // successful build resets the write-loop counter
          } else {
            consecutiveFailedBuilds++;
          }
        }

        const loopedWrites = [...fileWriteCounts.entries()].filter(([, n]) => n >= 3);
        if (loopedWrites.length > 0 && consecutiveFailedBuilds >= 2) {
          writeLoopNudgeCount++;
          consecutiveFailedBuilds = 0;
          loopedWrites.forEach(([f]) => fileWriteCounts.set(f, 0)); // partial reset
          const fileList = loopedWrites
            .map(([f, n]) => `  "${path.basename(f)}" (written ${n}x)`)
            .join("\n");
          log(colors.yellow(
            `  [Protocol] ${state.label}: build-write loop detected (${loopedWrites.length} file(s)) — injecting targeted build-error nudge (${writeLoopNudgeCount}/${MAX_WRITE_LOOP_NUDGES}).`,
          ));
          state.responseText = await state.send(
            state.remoteSessionId,
            `[BUILD-WRITE LOOP DETECTED — nudge ${writeLoopNudgeCount}/${MAX_WRITE_LOOP_NUDGES}]\n\n` +
              `You have rewritten the following file(s) multiple times but the build is still failing:\n${fileList}\n\n` +
              `Rewriting the entire file repeatedly does NOT fix type errors — you need to target the EXACT error.\n\n` +
              `REQUIRED APPROACH:\n` +
              `1. Run: [{"tool":"execute_bash","command":"npm run build 2>&1 | head -30"}]\n` +
              `2. READ the output — find the EXACT error line (e.g. "error TS2339: Property 'X' does not exist")\n` +
              `3. Use patch_file to fix ONLY the specific line(s) that caused the error\n` +
              `4. Do NOT rewrite the entire file — use the smallest possible patch\n\n` +
              `Common TypeScript errors in strict Vite projects:\n` +
              `• TS2339: Property does not exist → check interface/type definition matches usage\n` +
              `• TS7006: Parameter implicitly has 'any' → add type annotation\n` +
              `• TS6133: Declared but never read → remove unused variables (noUnusedLocals is ON)\n` +
              `• TS6192: All imports unused → remove the import statement\n` +
              `• TS2305: Module has no exported member → check the export name in the source file`,
            `${state.label} [build-write-loop ${writeLoopNudgeCount}/${MAX_WRITE_LOOP_NUDGES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }
    }
  }

  state.phase = SESSION_PHASES.COMPLETE;
  return state.result();
}
