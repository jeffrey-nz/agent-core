import path from "node:path";
import { execAsync } from "#utils/exec.js";

export async function checkRubySyntax(projectDir, rubyFiles) {
  const errors = [];
  if (!rubyFiles || rubyFiles.length === 0) return errors;

  for (const relPath of rubyFiles) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
    const res = await execAsync(`ruby -c ${JSON.stringify(absPath)} 2>&1`);
    if (res.status !== 0) {
      const output = (res.stdout || res.stderr || "").trim();
      if (/command not found|No such file|not found/i.test(output)) continue;
      if (output.length > 0) {
        errors.push(
          `Ruby syntax error in ${relPath}:\n\n${output}\n\n` +
          `Common causes: missing "end" keyword, unclosed string/heredoc, mismatched do/end blocks.`,
        );
      }
    }
  }

  return errors;
}
