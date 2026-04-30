import { dispatchTool } from "../../agent/tools/localDispatcher.js";

const TOOL_ALIASES = {
  list_files: "list_dir",
  list_directory: "list_dir",
  search_files: "find_file",
  search_file: "find_file",
  search_codebase: "grep",
  search_content: "grep",
  search_in_file: "grep",
  read: "read_file",
  write: "write_file",
  edit_file: "patch_file",
  bash: "execute_bash",
  run_bash: "execute_bash",
  execute_command: "execute_bash",
  run_shell_command: "execute_bash",
  shell: "execute_bash",
};

export async function executeAnyTool(name, params, context) {
  const resolvedName = TOOL_ALIASES[name] ?? name;
  try {
    const result = await dispatchTool(resolvedName, params, context);

    if (result !== undefined) {
      return typeof result === "string" ? result : (result.text ?? String(result));
    }

    return `[ERROR] Unknown tool: ${resolvedName}`;
  } catch (err) {
    return `[ERROR] Tool execution failed: ${err.message}`;
  }
}
