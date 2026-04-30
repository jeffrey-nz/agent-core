const COPILOT_365_PROVIDER = "copilot365";

export function buildAutomationPromptText({
  messages,
  rootDir,
  dirTree,
  interactionMode = null,
  requireWriteFile = true,
  providerName = null,
  allowedDirs = [],
}) {
  // "scoping" = single-turn conversational response (planValidator/critic) — no tool protocol.
  // "debugging" / "readOnly" = multi-turn read-only agent — read-only tool list appended.
  // anything else = full write-capable agent protocol.
  const isScoping = interactionMode === "scoping";
  const isDebugging = interactionMode === "debugging";
  const isReadOnly = interactionMode === "readOnly";
  const isCopilot365 = providerName === COPILOT_365_PROVIDER;

  // Build the canonical list of permitted root prefixes.
  const allAllowed = Array.from(
    new Set([rootDir, ...allowedDirs].filter(Boolean)),
  );
  const isMultiDir = allAllowed.length > 1;

  const pathsRule = isMultiDir
    ? `Paths MUST be absolute and start with one of:\n${allAllowed.map((d) => `  - ${d}`).join("\n")}`
    : `Paths MUST be absolute and start with ${rootDir}`;

  return messages
    .map((m) => {
      let content = m.content;

      if (m.role === "system" && rootDir && !isScoping) {
        if (isDebugging || isReadOnly) {
          // Compact read-only protocol for analyst/debugger/scoper/researcher turns.
          // No write tools, no execute_bash — prevents the model from calling echo/exit
          // instead of reading files.
          content += `

Project root: ${rootDir}

TOOLS (read-only — do NOT write files or run bash commands):
- read_file    : [{ "tool": "read_file", "path": "/abs/path" }]
- list_dir     : [{ "tool": "list_dir", "path": "/abs/path" }]
- find_file    : [{ "tool": "find_file", "name": "*.php" }]
- grep         : [{ "tool": "grep", "pattern": "...", "path": "/abs/path" }]
- outline_file : [{ "tool": "outline_file", "path": "/abs/path" }]

Output tool calls as a single JSON array. ${pathsRule}. Do NOT modify files.`;
        } else {
          const diagnosticsTool = isCopilot365
            ? ""
            : `- get_workspace_diagnostics : { "tool": "get_workspace_diagnostics" }\n`;
          const diagnosticsRule = isCopilot365
            ? ""
            : `- Run get_workspace_diagnostics after writing code to catch errors\n`;

          content += `

Project root: ${rootDir}

AGENTIC FILE PROTOCOL:
You MUST interact with the filesystem exclusively via the JSON tool call format below.
Do NOT output raw text file contents. Only use JSON tool calls.

AVAILABLE TOOLS (use these exact names):
- read_file       : { "tool": "read_file", "path": "/abs/path" }
- list_dir        : { "tool": "list_dir", "path": "/abs/path" }
- find_file       : { "tool": "find_file", "name": "*.php" } or { "tool": "find_file", "path": "/abs/dir" } (name optional — omit to list all files in path)
- write_file      : { "tool": "write_file", "path": "/abs/path", "content": "..." }
- patch_file      : { "tool": "patch_file", "path": "/abs/path", "search_block": "old", "replace_block": "new" }
- apply_diff      : { "tool": "apply_diff", "diff_content": "--- a/rel/path\n+++ b/rel/path\n@@ ... @@\n-old\n+new" }
- delete_file     : { "tool": "delete_file", "path": "/abs/path" }
- execute_bash    : { "tool": "execute_bash", "command": "..." }
- grep            : { "tool": "grep", "pattern": "...", "path": "/abs/path" }
- outline_file    : { "tool": "outline_file", "path": "/abs/path" }
${diagnosticsTool}- http_request    : { "tool": "http_request", "url": "...", "method": "GET" }
- run_composer    : { "tool": "run_composer", "command": "update -W" }
- run_phpunit     : { "tool": "run_phpunit" }
- run_npm         : { "tool": "run_npm", "command": "install" }
- git_push        : { "tool": "git_push" }
- git_branch      : { "tool": "git_branch", "name": "feature/my-branch" }
- github_create_issue   : { "tool": "github_create_issue", "title": "Bug: ...", "labels": ["bug"] }
- github_update_issue   : { "tool": "github_update_issue", "issue_number": 42, "comment": "Fixed in this session" }
- github_get_issues     : { "tool": "github_get_issues" }
- docs_write_page       : { "tool": "docs_write_page", "page": "Architecture", "content": "# Architecture\n..." }
- github_move_card      : { "tool": "github_move_card", "issue_number": 42, "column": "Done" }
- github_trigger_workflow : { "tool": "github_trigger_workflow", "workflow": "deploy.yml" }

TOOL CALL FORMAT — output ALL calls in ONE single JSON array (never split into multiple arrays or code blocks):
[
  { "tool": "list_dir", "path": "${rootDir}" },
  { "tool": "read_file", "path": "/abs/path/to/file.ext" }
]
CRITICAL: Every tool call in your response MUST be inside this single array. Do NOT wrap in markdown code fences. Do NOT output separate arrays.

CRITICAL RULES:
- ${pathsRule}
- Always read a file before editing it
- NEVER use write_file, patch_file, apply_diff, delete_file, or move_file on any path containing vendor/, node_modules/, or .git/
${diagnosticsRule}
${dirTree ? `DIRECTORY LISTING:\n${dirTree}` : ""}

Start with \`list_dir\` or \`read_file\` to understand the codebase before making changes.`;
        }
      }

      return `[${String(m.role || "user").toUpperCase()}]\n${content}`;
    })
    .join("\n\n---\n\n");
}
