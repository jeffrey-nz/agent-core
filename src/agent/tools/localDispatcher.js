/**
 * Local tool dispatcher - routes tool calls directly to the appropriate
 * executor without going through the MCP stdio protocol.
 */
import { executeFilesystemTool } from "./filesystem/executor.js";
import { executeSearchTool } from "./search.js";
import { executeShellTool } from "./shell.js";
import { executeDatabaseTool } from "./database/executor.js";
import { executeHttpTool } from "./http.js";
import { executePhpTool } from "./php/executor.js";
import { executeDiagnosticsTool } from "./diagnostics/executor.js";
import { executeGitTool } from "./git.js";
import { executeGithubTool } from "./github/executor.js";
import { executeMemoryTool } from "./memory.js";
import { executeBrowserTool } from "./browser.js";

const FILESYSTEM_TOOLS = new Set([
  "read_file",
  "write_file",
  "patch_file",
  "apply_diff",
  "list_dir",
  "find_file",
  "delete_file",
  "move_file",
  "revert_file",
  "outline_file",
]);

const SEARCH_TOOLS = new Set(["search_codebase", "grep"]);

const SHELL_TOOLS = new Set(["execute_bash", "run_npm"]);

const DATABASE_TOOLS = new Set(["query_database"]);

const HTTP_TOOLS = new Set(["http_request"]);

const PHP_TOOLS = new Set([
  "run_composer",
  "run_composer_fork",
  "run_phpunit",
  "run_sake",
  "php_lint",
  "check_package_version",
]);

const DIAGNOSTICS_TOOLS = new Set(["get_workspace_diagnostics"]);

const GIT_TOOLS = new Set(["git_inspect", "git_commit", "git_push", "git_branch", "git_diff"]);

const GITHUB_TOOLS = new Set([
  "github_create_issue",
  "github_update_issue",
  "github_get_issues",
  "docs_write_page",
  "github_move_card",
  "github_trigger_workflow",
]);

const MEMORY_TOOLS = new Set(["memory_save", "memory_list", "memory_delete"]);

const BROWSER_TOOLS = new Set([
  "screenshot_url",
  "inspect_page",
  "start_dev_server",
  "stop_dev_server",
  "list_dev_servers",
  "get_dev_server_logs",
  "evaluate_js",
  "click_element",
  "wait_for_selector",
]);

// Tools that mutate state - blocked when context.readOnly is true.
const WRITE_TOOLS = new Set([
  "write_file",
  "patch_file",
  "apply_diff",
  "delete_file",
  "move_file",
  "revert_file",
  "git_commit",
]);

import { withRetry } from "./retryWrapper.js";
import { validateToolResult } from "./validation.js";

/** Extract a short one-line summary from a multi-line error string. */
function _extractErrorSummary(text) {
  if (!text) return "";
  // Strip leading "[ERROR...]" tag prefix
  const stripped = String(text).replace(/^\[ERROR[^\]]*\]\s*/i, "").trim();
  // Take first non-empty line up to 120 chars
  const firstLine = stripped.split("\n").map(l => l.trim()).find(l => l.length > 0) || stripped;
  return firstLine.slice(0, 120);
}

export async function dispatchTool(name, args, context) {
  // Enforce read-only mode - any mutation attempt is rejected here so the AI
  // gets a clear, actionable error regardless of which execution path it came
  // from (SDK or automation-API).
  if (context?.readOnly === true && WRITE_TOOLS.has(name)) {
    const msg =
      `[READ-ONLY] Tool "${name}" is not permitted during the research/scoping phase. ` +
      `This agent must NOT write, patch, or delete files. ` +
      `Record your finding in the report - the implementor will apply the change.`;
    return { ok: false, error: msg, text: msg };
  }

  // Reject writes to literal placeholder paths that the model echoes from prompt examples.
  if ((name === "write_file" || name === "patch_file" || name === "apply_diff") && args?.path) {
    const p = args.path;
    if (
      p === "/abs/path" || p === "/abs/path/file.cs" || /^\/abs\//.test(p) ||
      p === "/path/to/file" || /^\/absolute\//.test(p) ||
      p.includes("/path/to/your/") || p === "/absolute/path/to/file"
    ) {
      const msg = `[ERROR] write_file called with placeholder path "${p}". This is a template example, not an actual path. You MUST use the real absolute path of the file in the project (e.g. the path shown in the subtask "files" list or retrieved via list_directory).`;
      console.warn(`[Dispatcher] Blocked placeholder write to: ${p}`);
      return { ok: false, error: msg, text: msg };
    }
  }

  // Guard: filesystem and search tools require a valid rootDir
  if ((FILESYSTEM_TOOLS.has(name) || SEARCH_TOOLS.has(name)) && !context?.rootDir) {
    const msg = `[ERROR] Tool "${name}" requires a rootDir but none was provided in the execution context.`;
    console.error(`[Dispatcher] Missing rootDir for ${SEARCH_TOOLS.has(name) ? "search" : "filesystem"} tool: ${name}`);
    return { ok: false, error: msg, text: msg };
  }

  // Determine which executor to use
  let executor;
  if (FILESYSTEM_TOOLS.has(name)) {
    executor = () => executeFilesystemTool(name, args, context);
  } else if (SEARCH_TOOLS.has(name)) {
    executor = () => executeSearchTool(name, args, context);
  } else if (SHELL_TOOLS.has(name)) {
    executor = () => executeShellTool(name, args, context);
  } else if (DATABASE_TOOLS.has(name)) {
    executor = () => executeDatabaseTool(name, args, context);
  } else if (HTTP_TOOLS.has(name)) {
    executor = () => executeHttpTool(name, args, context);
  } else if (PHP_TOOLS.has(name)) {
    executor = () => executePhpTool(name, args, context);
  } else if (DIAGNOSTICS_TOOLS.has(name)) {
    executor = () => executeDiagnosticsTool(args, context);
  } else if (GIT_TOOLS.has(name)) {
    executor = () => executeGitTool(name, args, context);
  } else if (GITHUB_TOOLS.has(name)) {
    executor = () => executeGithubTool(name, args, context);
  } else if (MEMORY_TOOLS.has(name)) {
    executor = () => executeMemoryTool(name, args, context);
  } else if (BROWSER_TOOLS.has(name)) {
    executor = () => executeBrowserTool(name, args, context);
  } else {
    // Suggest similar tool names to help the AI recover from typos
    const all = [
      ...FILESYSTEM_TOOLS, ...SEARCH_TOOLS, ...SHELL_TOOLS, ...DATABASE_TOOLS,
      ...HTTP_TOOLS, ...PHP_TOOLS, ...DIAGNOSTICS_TOOLS, ...GIT_TOOLS,
      ...GITHUB_TOOLS, ...MEMORY_TOOLS, ...BROWSER_TOOLS,
    ];
    const similar = all.filter(t => t.includes(name.split("_")[0]) || name.includes(t.split("_")[0])).slice(0, 3);
    const hint = similar.length ? ` Did you mean: ${similar.join(", ")}?` : "";
    const msg = `[ERROR] Unknown tool: "${name}".${hint}`;
    return { ok: false, error: msg, text: msg };
  }

  // Wrap executor with retry logic for transient failures
  let result = await withRetry(executor, { toolName: name });

  // Normalize: tool handlers written before the validation layer return plain
  // strings (e.g. "<file path='...'>content</file>") rather than structured
  // objects. Wrap them so the validation layer receives a consistent shape
  // while the original text content is preserved for the AI to read.
  if (typeof result === "string") {
    const isError = result.trimStart().startsWith("[ERROR]");
    result = {
      ok: !isError,
      text: result,
      ...(isError ? { error: result.trim(), errorSummary: _extractErrorSummary(result) } : {}),
    };
  }

  // Attach errorSummary to structured error results that don't already have one
  if (result && !result.ok && result.error && !result.errorSummary) {
    result.errorSummary = _extractErrorSummary(result.error);
  }

  // Validate the result against expected schema
  const validation = validateToolResult(name, result, context);
  if (!validation.valid) {
    console.warn(`[Validation] Tool "${name}" returned invalid result: ${validation.error}`);
    return {
      ok: false,
      error: `Validation failed: ${validation.error}`,
      text: `[VALIDATION ERROR] ${validation.error}`
    };
  }

  return result;
}
