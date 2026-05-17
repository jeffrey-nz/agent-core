const COPILOT_365_PROVIDER = "copilot365";
const COPILOT_PERSONAL_PROVIDER = "copilot";

// Build tool schema with actual rootDir paths so the model doesn't invent placeholders.
function buildCoreTools(rootDir) {
  const p = rootDir || "/project";
  return `read_file      | {"tool":"read_file","path":"${p}/src/file.ts"}
list_dir       | {"tool":"list_dir","path":"${p}"}
find_file      | {"tool":"find_file","name":"*.ts"}  or  {"tool":"find_file","path":"${p}/src"}
grep           | {"tool":"grep","pattern":"<regex>","path":"${p}/src"}
outline_file   | {"tool":"outline_file","path":"${p}/src/file.ts"}
write_file     | {"tool":"write_file","path":"${p}/src/MyFile.tsx","content":"<full file content>"}
patch_file     | {"tool":"patch_file","path":"${p}/src/file.ts","search_block":"<exact old text>","replace_block":"<new text>"}
apply_diff     | {"tool":"apply_diff","diff_content":"--- a/rel\\n+++ b/rel\\n@@ ... @@\\n-old\\n+new"}
delete_file    | {"tool":"delete_file","path":"${p}/src/file.ts"}
execute_bash   | {"tool":"execute_bash","command":"<cmd>"}`;
}

const EXTENDED_TOOLS = `
http_request         | {"tool":"http_request","url":"...","method":"GET"}
run_npm              | {"tool":"run_npm","command":"install"}
git_push             | {"tool":"git_push"}
git_branch           | {"tool":"git_branch","name":"feature/my-branch"}
github_create_issue  | {"tool":"github_create_issue","title":"Bug: ...","labels":["bug"]}
github_update_issue  | {"tool":"github_update_issue","issue_number":42,"comment":"Fixed"}
github_get_issues    | {"tool":"github_get_issues"}
docs_write_page      | {"tool":"docs_write_page","page":"Architecture","content":"# ..."}
github_move_card     | {"tool":"github_move_card","issue_number":42,"column":"Done"}
github_trigger_workflow | {"tool":"github_trigger_workflow","workflow":"deploy.yml"}
run_composer         | {"tool":"run_composer","command":"update -W"}
run_phpunit          | {"tool":"run_phpunit"}`;

function buildReadOnlyTools(rootDir) {
  const p = rootDir || "/project";
  return `read_file    | [{"tool":"read_file","path":"${p}/src/file.ts"}]
list_dir     | [{"tool":"list_dir","path":"${p}"}]
find_file    | [{"tool":"find_file","name":"*.ts"}]
grep         | [{"tool":"grep","pattern":"...","path":"${p}/src"}]
outline_file | [{"tool":"outline_file","path":"${p}/src/file.ts"}]`;
}

export function buildAutomationPromptText({
  messages,
  rootDir,
  dirTree,
  interactionMode = null,
  requireWriteFile = true,
  providerName = null,
  allowedDirs = [],
}) {
  const isScoping = interactionMode === "scoping";
  const isDebugging = interactionMode === "debugging";
  const isReadOnly = interactionMode === "readOnly";
  const isCopilot365 = providerName === COPILOT_365_PROVIDER;
  const isCopilotPersonal = providerName === COPILOT_PERSONAL_PROVIDER;

  const allAllowed = Array.from(
    new Set([rootDir, ...allowedDirs].filter(Boolean)),
  );
  const isMultiDir = allAllowed.length > 1;

  const pathsRule = isMultiDir
    ? `Paths MUST be absolute and start with one of:\n${allAllowed.map((d) => `  - ${d}`).join("\n")}`
    : `Paths MUST be absolute and start with ${rootDir}`;

  const fullPrompt = messages
    .map((m) => {
      let content = m.content;

      if (m.role === "system" && rootDir && !isScoping) {
        if (isDebugging || isReadOnly) {
          content += `

Project root: ${rootDir}

TOOLS (read-only — do NOT write files or run bash):
${buildReadOnlyTools(rootDir)}

Output tool calls as a single JSON array. ${pathsRule}. Do NOT modify files.`;
        } else {
          const diagnosticsTool = isCopilot365
            ? ""
            : `get_workspace_diagnostics | {"tool":"get_workspace_diagnostics"}\n`;

          if (isCopilotPersonal) {
            // Copilot Personal refuses JSON tool-call arrays and interprets "write_file"
            // as a file-system execution it cannot perform. Use the <<<FILE:>>> delimiter
            // format instead — StructuredOutputParser Strategy 7 extracts these blocks.
            content += `

Project root: ${rootDir}

## FILE OUTPUT FORMAT

To create or modify a file, use this EXACT format:
<<<FILE: ${rootDir}/path/to/filename.ext>>>
complete file content here
<<<END FILE>>>

Example — creating index.html:
<<<FILE: ${rootDir}/index.html>>>
<!DOCTYPE html>
<html lang="en">
<body>Hello World</body>
</html>
<<<END FILE>>>

Write ALL required files by repeating this pattern. After all files, output: TASK_DONE

## RULES
- ${pathsRule}
- Do NOT output JSON arrays. Do NOT use write_file syntax. Use <<<FILE:>>> blocks ONLY.
- Include complete file content — never placeholder comments or "..." truncations.
- For a new project: write ALL files immediately, do not wait.
${dirTree ? `\nDIRECTORY LISTING:\n${dirTree}` : ""}`;
          } else {
            const isDeepSeek = providerName === "deepseek";
            if (isDeepSeek) {
              // DeepSeek-specific BATCH EXECUTION PROTOCOL:
              // 1. Must wrap JSON in ```json blocks (aligns with FORMAT REQUIREMENT).
              // 2. No example JSON paths/content — DeepSeek copies placeholder values literally.
              content += `

Project root: ${rootDir}

## TOOL SCHEMA
${buildCoreTools(rootDir)}
${diagnosticsTool}${EXTENDED_TOOLS}

## BATCH EXECUTION PROTOCOL

Output ALL tool calls in ONE JSON array, wrapped in a \`\`\`json code block.
Use write_file with the ACTUAL file path and the COMPLETE file content.

When all files for the current task are written, output: TASK_DONE

## RULES
- ${pathsRule}
- ALWAYS wrap the JSON array in a \`\`\`json code block — never output raw JSON
- Put the COMPLETE file content in the "content" field — never truncate or use placeholders
- Write to the ACTUAL file paths listed in your subtask — not example paths from this prompt
- ALL tool calls in ONE array per response — never split into multiple arrays
- For a read-then-write task: batch the reads first, get results, then batch the writes
- Never use execute_bash to write file contents — use write_file
- Never modify vendor/, node_modules/, or .git/
- Always read a file before patching it (patch_file requires exact search_block match)
${dirTree ? `\nDIRECTORY LISTING:\n${dirTree}` : ""}

${content.includes("NEW_PROJECT MODE") || content.includes("NEW PROJECT MODE")
  ? "⚡ NEW PROJECT: Write ALL files immediately. Do NOT list_dir or read_file first — nothing exists yet."
  : ""}`;
            } else {
              content += `

Project root: ${rootDir}

## TOOL SCHEMA
${buildCoreTools(rootDir)}
${diagnosticsTool}${EXTENDED_TOOLS}

## BATCH EXECUTION PROTOCOL

Think before acting. Before your tool calls, output a reasoning block:
<think>
Task: what this response must accomplish
Files to write: [list every file]
Read first: [list files that must be read before writing, or "none"]
</think>

Then output ALL tool calls for this response in ONE JSON array:
[
  {"tool":"write_file","path":"${rootDir}/src/ComponentA.tsx","content":"...full content..."},
  {"tool":"write_file","path":"${rootDir}/src/ComponentB.tsx","content":"...full content..."},
  {"tool":"write_file","path":"${rootDir}/src/utils.ts","content":"...full content..."}
]

When all files for the current task are written, output: TASK_DONE

## RULES
- ${pathsRule}
- ALL tool calls in ONE array per response — never split into multiple arrays
- Do NOT wrap the array in markdown code fences
- For a task requiring 5 files: write all 5 in ONE array
- For a read-then-write task: batch the reads first, get results, then batch the writes
- Never use execute_bash to write file contents — use write_file
- Never modify vendor/, node_modules/, or .git/
- Always read a file before patching it (patch_file requires exact search_block match)
${dirTree ? `\nDIRECTORY LISTING:\n${dirTree}` : ""}

${content.includes("NEW_PROJECT MODE") || content.includes("NEW PROJECT MODE")
  ? "⚡ NEW PROJECT: Write ALL files immediately. Do NOT list_dir or read_file first — nothing exists yet."
  : ""}`;
            }
          }
        }
      }

      // For scoping mode (e.g. nuclear retry), omit the [ROLE] prefix and --- separator.
      // DeepSeek echoes messages that start with [USER] or [SYSTEM] markers — using raw
      // content prevents the echo and lets DeepSeek treat the message as a task to complete.
      if (isScoping) return content;
      return `[${String(m.role || "user").toUpperCase()}]\n${content}`;
    })
    .join(isScoping ? "\n\n" : "\n\n---\n\n");

  if (fullPrompt.length > 80000 && providerName === "deepseek") {
    return compactPromptForDeepSeek(fullPrompt);
  }
  return fullPrompt;
}

function compactPromptForDeepSeek(prompt) {
  let compacted = prompt;

  // Pass 1: truncate large file-content blocks (tool results > 3000 chars)
  compacted = compacted.replace(
    /(content of [^\n]{0,100}\n)([\s\S]{3000,}?)(\n---|\n\[)/g,
    (match, header, body, tail) => {
      if (body.length > 3000) {
        return header + body.slice(0, 1500) + "\n...[truncated for context efficiency]...\n" + body.slice(-200) + tail;
      }
      return match;
    }
  );

  // Pass 2: if still > 80K, truncate large [TOOL RESULT] blocks
  if (compacted.length > 80000) {
    compacted = compacted.replace(
      /(\[TOOL RESULT\][^\n]*\n)([\s\S]{2000,}?)(\n\n---)/g,
      (match, header, body, tail) => {
        if (body.length > 2000) {
          return header + body.slice(0, 1000) + "\n...[file content truncated]...\n" + body.slice(-200) + tail;
        }
        return match;
      }
    );
  }

  return compacted;
}
