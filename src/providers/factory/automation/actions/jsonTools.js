import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { executeAnyTool } from "../../toolExecutor.js";
import { formatToolResults } from "../../formatters.js";
import {
  hasExecutionFailure,
  extractErrorSummary,
} from "#agent/utils/executionOutputAnalysis.js";

// Tools whose output should be checked for execution failures
const EXECUTION_TOOL_NAMES = new Set([
  "run_sake",
  "run_composer",
  "run_phpunit",
  "execute_bash",
  "run_npm",
]);

// Patterns that indicate the bash command would destructively modify the filesystem.
// These are blocked entirely when the agent is in a read-only phase (researcher/scoper).
const DESTRUCTIVE_BASH_RE =
  /(?:^|[;&|]\s*)(?:rm\s|rmdir\s|mv\s|truncate\s|shred\s|dd\s|>\s*\/|tee\s)/i;

// Mutation tools that are never permitted during read-only phases.
const READ_ONLY_BLOCKED_TOOLS = new Set([
  "write_file",
  "patch_file",
  "apply_diff",
  "delete_file",
  "move_file",
  "revert_file",
  "git_commit",
]);

/**
 * Returns an error string if the tool call should be blocked in read-only mode,
 * or null if it is safe to execute.
 */
function checkReadOnlyViolation(toolName, toolParams, toolContext) {
  if (!toolContext?.readOnly) return null;

  // Block filesystem mutation tools outright.
  if (READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
    return (
      `[READ-ONLY] Tool "${toolName}" is not permitted during the research/scoping phase. ` +
      `This agent must NOT write, patch, or delete files. ` +
      `Describe the required change in your report — the implementor (coder) will apply it.`
    );
  }

  // Block destructive bash commands.
  if (toolName === "execute_bash") {
    const cmd = String(toolParams?.command || "");
    if (DESTRUCTIVE_BASH_RE.test(cmd)) {
      return (
        `[BLOCKED] Destructive command prevented during investigation phase: "${cmd.slice(0, 80)}"\n` +
        `The researcher/scoper must NOT modify or delete files. ` +
        `Use read_file, search_files, or find_file to investigate instead.`
      );
    }
  }

  return null;
}

function relativizePath(p, rootDir) {
  if (!p || !rootDir) return p;
  const prefix = rootDir.endsWith("/") ? rootDir : rootDir + "/";
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function makeParamsSummary(name, params, rootDir) {
  if (!params) return "";
  const n = (name || "").toLowerCase();
  if (/write|patch|read|delete|move/.test(n))
    return relativizePath(
      String(params.path || params.file_path || params.source || ""),
      rootDir,
    );
  if (/bash|command|execute/.test(n))
    return String(params.command || "").slice(0, 80);
  if (/grep|search|find/.test(n))
    return relativizePath(
      String(params.pattern || params.query || params.path || ""),
      rootDir,
    );
  if (/list|dir/.test(n))
    return relativizePath(String(params.path || ""), rootDir);
  return "";
}

export async function buildJsonToolsFollowUp({
  jsonToolCalls,
  toolContext,
  toolCalls,
  executionErrors = [],
}) {
  log(
    colors.yellow(
      `\n  [Automation API] Executing ${jsonToolCalls.length} JSON tool call(s)...`,
    ),
  );

  const results = [];

  for (const tc of jsonToolCalls) {
    const toolName = tc.tool || tc.name || tc.action;

    // Build params by stripping only the fields used as tool identifiers.
    // IMPORTANT: 'name' is ONLY stripped when it was the tool identifier (tc.tool
    // is absent). When tc.tool is present, 'name' is a regular parameter (e.g.
    // find_file uses { "tool": "find_file", "name": "Page.php" }).
    const paramsRaw = { ...tc };
    delete paramsRaw.tool;
    delete paramsRaw.action;
    if (!tc.tool) delete paramsRaw.name; // name was the identifier — not a param
    const { parameters, input, ...flatParams } = paramsRaw;
    const toolParams = parameters || input || flatParams;

    log(
      colors.dim(
        `  [→ TOOL] ${toolName}(${JSON.stringify(toolParams).slice(0, 120)})`,
      ),
    );

    const callId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    eventBus.emit("tool_call_start", {
      callId,
      tool: toolName,
      paramsSummary: makeParamsSummary(
        toolName,
        toolParams,
        toolContext?.rootDir,
      ),
    });

    let resultStr;
    let isError = false;

    // Hard-block repeated no-op diagnostics calls (PRM: Lightman et al. 2023).
    // Once diagnostics has returned SKIPPED or PASSED within this tool context,
    // block subsequent calls immediately — the model must finalize instead.
    if (toolName === "get_workspace_diagnostics" && toolContext?._diagNoOpSeen) {
      resultStr =
        "[BLOCKED] get_workspace_diagnostics already returned SKIPPED/PASSED this subtask. " +
        "Calling it again returns the same result. " +
        "You MUST write remaining files now with write_file, or output [] to signal completion. " +
        "Do NOT call get_workspace_diagnostics again.";
      isError = true;
      log(colors.yellow(`  [Protocol] Blocked redundant get_workspace_diagnostics call (already no-op this subtask).`));
    } else {
      const blocked = checkReadOnlyViolation(toolName, toolParams, toolContext);
      if (blocked) {
        resultStr = blocked;
        isError = true;
        log(colors.red(`  [BLOCKED] Read-only violation prevented: ${toolName}(${String(toolParams?.command || toolParams?.path || toolParams?.file_path || "").slice(0, 60)})`));
      } else {
        try {
          const result = await executeAnyTool(toolName, toolParams, toolContext);
          resultStr = String(result ?? "[no output]");
          isError = resultStr.startsWith("[ERROR]");

          // PRM: Diagnostics spam prevention (Lightman et al. 2023 — low-reward signal).
          // When get_workspace_diagnostics returns SKIPPED or PASSED, set a flag so
          // the next call is hard-blocked rather than softly nudged.
          if (
            toolName === "get_workspace_diagnostics" &&
            /\[DIAGNOSTICS (SKIPPED|PASSED)\]/i.test(resultStr)
          ) {
            if (toolContext) toolContext._diagNoOpSeen = true;
            resultStr +=
              "\n\n[ACTION REQUIRED] Diagnostics check is complete — do NOT call get_workspace_diagnostics again. " +
              "If there are remaining files to write for this subtask, write them now with write_file. " +
              "If all required files are written, output [] to signal completion.";
          }
        } catch (err) {
          resultStr = `[ERROR] ${err.message}`;
          isError = true;
        }
      }
    }

    if (EXECUTION_TOOL_NAMES.has(toolName) && hasExecutionFailure(resultStr)) {
      executionErrors.push({
        tool: toolName,
        summary: extractErrorSummary(resultStr),
      });
    }

    // Integrity checks for .ts/.tsx writes — append warnings directly to the
    // write_file result rather than pushing fake tool entries. Injecting results
    // as separate "corruption_check"/"typescript_check" tool entries caused models
    // to attempt calling those names as real tools in the next turn.
    if (
      toolName === "write_file" &&
      !isError &&
      toolContext?.rootDir &&
      /\.(ts|tsx)$/.test(toolParams?.path || "")
    ) {
      const content = toolParams?.content || "";
      const filePath = toolParams.path;
      const relPath = filePath.startsWith(toolContext.rootDir + "/")
        ? filePath.slice(toolContext.rootDir.length + 1)
        : filePath;

      // 1. Fast in-process corruption detector — long lines with repeated identifiers.
      // Corruption (interleaved AI output streams) produces lines that are unusually
      // long because two separate lines got merged, with the same long function/class
      // name appearing 3+ times. Legitimate code rarely repeats a 12-char identifier
      // 3 times on a single line that is 200+ chars.
      const corruptLines = content.split("\n").filter((line) => {
        if (line.length < 200) return false;
        const tokens = [...line.matchAll(/\b([a-zA-Z_]\w{11,})\b/g)].map((m) => m[1]);
        const counts = {};
        tokens.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
        return Object.values(counts).some((v) => v >= 3);
      });
      if (corruptLines.length >= 2) {
        const sample = corruptLines.slice(0, 3).map((l) => `  ${l.trim().slice(0, 80)}`).join("\n");
        log(colors.red(`  [Corruption] Interleaved-line pattern detected in ${relPath} — appending warning to write_file result.`));
        resultStr += `\n\n⚠️ SYSTEM: CORRUPTION DETECTED in ${relPath} — ${corruptLines.length} lines contain duplicated/interleaved tokens.\n\nExamples:\n${sample}\n\nThe file was written but the content is corrupt. Rewrite the ENTIRE file with write_file using clean code.`;
      } else {
        // 2. TypeScript syntax check (TS1xxx parse errors only — TS2xxx need full project context).
        try {
          const { default: fsP } = await import("node:fs/promises");
          const tscBin = path.join(toolContext.rootDir, "node_modules", ".bin", "tsc");
          const nodeModulesReady = await fsP.access(tscBin).then(() => true).catch(() => false);

          if (nodeModulesReady) {
            const { execAsync } = await import("#utils/exec.js");
            const tsResult = await execAsync(
              `npx tsc --noEmit --allowJs --skipLibCheck --jsx react --target ES2020 --moduleResolution node "${relPath}" 2>&1 || true`,
              { cwd: toolContext.rootDir },
            ).catch(() => null);

            if (tsResult?.stdout?.match(/error TS1\d{3}\b/)) {
              const errorText = tsResult.stdout.slice(0, 2000);
              log(colors.yellow(`  [TypeScript] Syntax errors in ${relPath} — appending to write_file result.`));
              resultStr += `\n\n⚠️ SYSTEM: TypeScript syntax errors in ${relPath}:\n${errorText}\nRewrite the file to fix these syntax errors.`;
            }
          }
        } catch {
          // Non-fatal — TypeScript check failures are silently ignored.
        }
      }
    }

    eventBus.emit("tool_call_end", {
      callId,
      tool: toolName,
      isError,
      result: resultStr.slice(0, 300),
    });

    results.push({
      tool: toolName,
      parameters: toolParams,
      result: resultStr,
    });
    toolCalls.push(tc);
  }

  return formatToolResults(results);
}
