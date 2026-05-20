import path from "node:path";
import { readFile } from "node:fs/promises";
import { execAsync } from "#utils/exec.js";

/**
 * Detects a file that was written but cut off mid-stream. The tell-tale signs:
 * the last non-empty line opens a block (ends with ':') with no body, OR an
 * obviously incomplete final line. ChatGPT in particular truncates long
 * multi-file responses — the file START is well-formed but the body is missing.
 */
function looksTruncated(content) {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1].trim();
  // Last line opens a block but nothing follows it
  if (/[:]\s*$/.test(last) && /^(def |class |if |elif |else|for |while |with |try|except|finally)\b/.test(last)) {
    return true;
  }
  // Last line ends with an open bracket / operator / comma — clearly mid-expression
  if (/[([{,+\-*/=]\s*$/.test(last)) return true;
  return false;
}

export async function checkPythonSyntax(projectDir, pyFiles) {
  const errors = [];
  if (!pyFiles || pyFiles.length === 0) return errors;

  for (const relPath of pyFiles) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
    const res = await execAsync(`python3 -m py_compile ${JSON.stringify(absPath)} 2>&1`);
    const output = (res.stdout || res.stderr || "").trim();
    if (res.status !== 0 && output.length > 0) {
      if (/command not found|No such file/i.test(output)) continue;
      if (/SyntaxError:|IndentationError:|invalid syntax|unexpected indent|EOL while|EOF while/i.test(output)) {
        // Truncation check: an "expected an indented block" error on a short file
        // whose last line opens a block almost always means the write was cut off.
        let truncationNote = "";
        try {
          const content = await readFile(absPath, "utf8");
          if (looksTruncated(content) || (/expected an indented block/i.test(output) && content.split("\n").length < 15)) {
            truncationNote =
              `\n\n⚠️ THIS FILE IS TRUNCATED — your previous response was cut off before the file was complete ` +
              `(it has only ${content.split("\n").length} lines and ends mid-block). This is NOT a small indentation typo.\n` +
              `FIX: Re-write the ENTIRE ${path.basename(relPath)} from scratch as ONE complete file. ` +
              `Keep the implementation focused and concise so the whole file fits in a single response. ` +
              `Do not write a long prose explanation before the file — output the file content immediately.`;
          }
        } catch { /* unreadable — skip truncation check */ }
        errors.push(
          `Python syntax error in ${relPath}:\n\n${output}\n\n` +
          `Common causes: bad indentation, missing colon after if/def/class, unclosed bracket or string.` +
          truncationNote,
        );
      }
    }
  }

  return errors;
}
