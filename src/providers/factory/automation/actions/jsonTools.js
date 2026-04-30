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
      } catch (err) {
        resultStr = `[ERROR] ${err.message}`;
        isError = true;
      }
    }

    if (EXECUTION_TOOL_NAMES.has(toolName) && hasExecutionFailure(resultStr)) {
      executionErrors.push({
        tool: toolName,
        summary: extractErrorSummary(resultStr),
      });
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
