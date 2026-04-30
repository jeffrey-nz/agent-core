import path from "node:path";
import fs from "node:fs/promises";

export async function checkJsonSyntax(projectDir, jsonFiles) {
  const errors = [];
  for (const absPath of jsonFiles) {
    try {
      const content = await fs.readFile(absPath, "utf8");
      JSON.parse(content);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      errors.push(
        `JSON Syntax Error in ${path.relative(projectDir, absPath)}:\n${err.message}`,
      );
    }
  }
  return errors;
}
