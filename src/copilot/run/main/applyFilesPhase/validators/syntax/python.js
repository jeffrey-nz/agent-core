import path from "node:path";
import { execAsync } from "#utils/exec.js";

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
        errors.push(
          `Python syntax error in ${relPath}:\n\n${output}\n\n` +
          `Common causes: bad indentation, missing colon after if/def/class, unclosed bracket or string.`,
        );
      }
    }
  }

  return errors;
}
