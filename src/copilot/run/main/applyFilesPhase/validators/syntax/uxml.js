import fs from "node:fs/promises";
import path from "node:path";

/**
 * Lightweight structural check for Unity UXML files.
 * UXML is XML-based — a valid file must open with an XML declaration
 * (<?xml) or one of Unity UI Toolkit's known root elements.
 * We don't attempt full XML parsing; just check the file starts correctly.
 */
export async function checkUxmlSyntax(projectDir, uxmlFiles) {
  const errors = [];
  if (!uxmlFiles || uxmlFiles.length === 0) return errors;

  for (const absPath of uxmlFiles) {
    let content;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch (err) {
      errors.push(
        `UXML Error in ${path.relative(projectDir, absPath)}: Could not read file — ${err.message}`,
      );
      continue;
    }

    const trimmed = content.trim();
    const validStart =
      trimmed.startsWith("<?xml") ||
      trimmed.startsWith("<ui:UXML") ||
      trimmed.startsWith("<engine:") ||
      trimmed.startsWith("<UXML");

    if (!validStart) {
      errors.push(
        `UXML Error in ${path.relative(projectDir, absPath)}: File does not appear to be valid UXML. ` +
          `Expected to start with <?xml ...?> or <ui:UXML ...>, got: "${trimmed.slice(0, 60)}"`,
      );
    }
  }

  return errors;
}
