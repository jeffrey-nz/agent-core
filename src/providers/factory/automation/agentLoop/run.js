import path from "node:path";
import { parseAgentStep } from "./stepParser.js";
import { createLoopState } from "./loopState.js";
import { executeStep } from "./stepExecutor.js";
import { handleNoActivity } from "./protocolEnforcer.js";
import { SESSION_PHASES, isWritePhase } from "../../../../session/phases.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

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

    // ── PLAN phase: <tool-plan> without tool calls recovery ─────────────────────
    // isWritePhase(PLAN) === false, so the main recovery block below never fires
    // for the initial coder response. If the model outputs <tool-plan> with no JSON
    // array in PLAN phase, the loop spins silently until maxSteps. Catch it here.
    // Also catches [] (empty "done" signal) and plain prose — the model outputting
    // [] in PLAN phase means it thinks the work is already done (due to accumulated
    // chat history). Force it to start writing immediately.
    if (
      state.phase === SESSION_PHASES.PLAN &&
      state.requireWriteFile &&
      !state.requireTools &&
      !parsed.hasActivity
    ) {
      const rawText = String(state.responseText || "");
      if (rawText.includes("<tool-plan>") && !rawText.includes("[{")) {
        consecutiveToolPlan++;

        if (consecutiveToolPlan >= MAX_TOOL_PLAN_RETRIES) {
          log(
            colors.red(
              `\n[Automation API] ${state.label}: <tool-plan> without tool calls after ${MAX_TOOL_PLAN_RETRIES} recovery attempts (PLAN phase) — aborting.`,
            ),
          );
          state.aborted = true;
          break;
        }

        log(
          colors.yellow(
            `  [Protocol] ${state.label}: <tool-plan> tag with no JSON tool calls in PLAN phase — requesting continuation (${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}).`,
          ),
        );

        state.responseText = await state.send(
          state.remoteSessionId,
          `[TOOL CALLS MISSING — attempt ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]\n\n` +
            `Your <tool-plan> block was received and logged, but you did NOT follow it with any JSON tool calls.\n` +
            `The plan has NOT been executed — no files were read or written.\n\n` +
            `Continue IMMEDIATELY with the JSON tool call array that executes the first steps of your plan.\n` +
            `Do NOT repeat the <tool-plan> tag. Output only the tool calls (use real paths under ${state.rootDir}):\n` +
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
          }
        }
      }
    }

    if (!parsed.hasActivity && isWritePhase(state.phase)) {
      if (parsed.parseError) {
        consecutiveParseErrors++;
        if (consecutiveParseErrors > MAX_PARSE_ERROR_RETRIES) {
          // Give up — repeated attempts to produce valid JSON have failed.
          break;
        }

        // Choose a hint that matches what actually went wrong.
        const rawText = String(state.responseText || "");
        const isReadOnly = state.toolContext?.readOnly;
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

      // ── <tool-plan> without execution recovery ─────────────────────────────
      // The coder protocol instructs models to output <tool-plan>...</tool-plan>
      // FOLLOWED immediately by a JSON tool call array. When a model outputs ONLY
      // the plan tag (no "[{" JSON array), detect it here and ask it to continue.
      // Not gated by !madeProgress — plan-without-execution can happen at any
      // point in the session, not just before the first tool call.
      {
        const rawText = String(state.responseText || "");
        if (rawText.includes("<tool-plan>") && !rawText.includes("[{")) {
          consecutiveToolPlan++;

          if (consecutiveToolPlan >= MAX_TOOL_PLAN_RETRIES) {
            log(
              colors.red(
                `\n[Automation API] ${state.label}: <tool-plan> without tool calls after ${MAX_TOOL_PLAN_RETRIES} recovery attempts — aborting.`,
              ),
            );
            state.aborted = true;
            break;
          }

          log(
            colors.yellow(
              `  [Protocol] ${state.label}: <tool-plan> tag with no JSON tool calls — requesting continuation (${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}).`,
            ),
          );

          state.responseText = await state.send(
            state.remoteSessionId,
            `[TOOL CALLS MISSING — attempt ${consecutiveToolPlan}/${MAX_TOOL_PLAN_RETRIES}]\n\n` +
              `Your <tool-plan> block was received and logged, but you did NOT follow it with any JSON tool calls.\n` +
              `The plan has NOT been executed — no files were read or written.\n\n` +
              `Continue IMMEDIATELY with the JSON tool call array that executes the first steps of your plan.\n` +
              `Do NOT repeat the <tool-plan> tag. Use real paths under ${state.rootDir}:\n` +
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
          rawText.trimStart().startsWith("//") ||
          /^(private|protected|internal|static|override|virtual)\s/m.test(rawText);

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
          "execute_bash", "run_sake", "run_composer", "http_request",
        ]);
        const unknownTools = parsed.jsonToolCalls
          .map((tc) => (tc.tool || tc.name || "").toLowerCase())
          .filter((n) => n && !VALID_CODER_TOOLS.has(n));
        if (unknownTools.length > 0 && unknownTools.length === parsed.jsonToolCalls.length) {
          consecutiveProse++;
          if (consecutiveProse >= MAX_PROSE_RETRIES) {
            log(colors.red(`\n[Automation API] ${state.label}: wrong tools used ${MAX_PROSE_RETRIES} times — aborting.`));
            state.aborted = true;
            break;
          }
          log(colors.yellow(`  [Protocol] ${state.label}: coder used wrong tools (${unknownTools.join(", ")}) — redirecting to write_file (${consecutiveProse}/${MAX_PROSE_RETRIES}).`));
          state.responseText = await state.send(
            state.remoteSessionId,
            `[WRONG TOOL — attempt ${consecutiveProse}/${MAX_PROSE_RETRIES}]\n\n` +
              `You called "${unknownTools.join('", "')}" which is not a valid coder tool. ` +
              `This is a code-writing phase — you MUST use write_file or patch_file to create or modify source files.\n\n` +
              `Use the REAL path of the file you need to create/modify (under ${state.rootDir}):\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/filename.js", "content": "..." }\n]\n\n` +
              `Do NOT use documentation or messaging tools. Write the actual source code files.`,
            `${state.label} [wrong-tool ${consecutiveProse}/${MAX_PROSE_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      // ── Placeholder-path detection (BEFORE executeStep) ─────────────────────
      // If the model copies the example path from a recovery hint (e.g. /abs/path)
      // instead of using the real project path, intercept it here and inject a
      // correction rather than executing then blocking at the dispatcher level.
      {
        const PLACEHOLDER_RE = /^\/abs\//;
        const allPlaceholder =
          parsed.jsonToolCalls.length > 0 &&
          parsed.jsonToolCalls.every((tc) => {
            const p = tc.path || tc.args?.path || tc.input?.path || "";
            return PLACEHOLDER_RE.test(p);
          });
        if (allPlaceholder) {
          consecutiveProse++;
          if (consecutiveProse >= MAX_PROSE_RETRIES) {
            log(colors.red(`\n[Automation API] ${state.label}: placeholder paths repeated ${MAX_PROSE_RETRIES} times — aborting.`));
            state.aborted = true;
            break;
          }
          log(colors.yellow(`  [Protocol] ${state.label}: all tool calls use placeholder /abs/ path — injecting correction (${consecutiveProse}/${MAX_PROSE_RETRIES}).`));
          state.responseText = await state.send(
            state.remoteSessionId,
            `[WRONG PATH — attempt ${consecutiveProse}/${MAX_PROSE_RETRIES}]\n\n` +
              `You used "/abs/path/..." which is a documentation placeholder, not a real file path.\n` +
              `The actual project is at: ${state.rootDir}\n\n` +
              `Replace the path with a real file path under ${state.rootDir}, for example:\n` +
              `[\n  { "tool": "write_file", "path": "${state.rootDir}/src/Calculator.jsx", "content": "..." }\n]\n\n` +
              `Do NOT use /abs/path. Use the real project path shown above.`,
            `${state.label} [placeholder-path ${consecutiveProse}/${MAX_PROSE_RETRIES}]`,
          );
          state.consecutiveNoActivity = 0;
          continue;
        }
      }

      await executeStep(state, parsed, step);

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
    }
  }

  state.phase = SESSION_PHASES.COMPLETE;
  return state.result();
}
