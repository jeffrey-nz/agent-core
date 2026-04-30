import fs from "node:fs/promises";
import path from "node:path";
import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { MAX_FILE_SIZE_BYTES } from "../utils.js";
import { checkReadSafety } from "./read/guards.js";
import { readWindow } from "./read/windowReader.js";

export async function handleReadFile(input, { rootDir, ignore, allowedDirs = [] }) {
  const fileRelPath = input.path;
  const absPath = path.resolve(rootDir, fileRelPath);

  if (input.start_line) {
    const startLine = input.start_line;
    const endLine = input.end_line ?? startLine + 100;
    const spinner = createSpinner(
      colors.dim(
        `  - Reading window: ${fileRelPath} (Lines ${startLine}-${endLine})`,
      ),
    ).start();

    const safetyErr = checkReadSafety(rootDir, fileRelPath, ignore, spinner, allowedDirs);
    if (safetyErr) {
      spinner.fail(colors.dim(`  - Blocked: ${fileRelPath}`));
      return `<window path="${fileRelPath}">\n${safetyErr}\n</window>\n\n`;
    }

    try {
      const snippet = await readWindow(absPath, startLine, endLine);
      spinner.succeed(
        colors.dim(
          `  - Read window: ${fileRelPath} (Lines ${startLine}-${endLine})`,
        ),
      );
      return `<window path="${fileRelPath}">\nLines ${startLine} to ${endLine}:\n\`\`\`\n${snippet}\n\`\`\`\n</window>\n\n`;
    } catch (err) {
      spinner.fail(`Read error: ${fileRelPath}`);
      return `<window path="${fileRelPath}">\n[ERROR: ${err.message}]\n</window>\n\n`;
    }
  }

  const spinner = createSpinner(
    colors.dim(`  - Reading full file: ${fileRelPath}`),
  ).start();
  const safetyErr = checkReadSafety(rootDir, fileRelPath, ignore, spinner, allowedDirs);
  if (safetyErr) {
    spinner.fail(colors.dim(`  - Blocked: ${fileRelPath}`));
    return `<file path="${fileRelPath}">${safetyErr}</file>\n\n`;
  }

  try {
    const stats = await fs.stat(absPath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      spinner.fail(`File exceeds max size: ${fileRelPath}`);
      return `<file path="${fileRelPath}">[ERROR: File too large for full read. Use start_line/end_line.]</file>\n\n`;
    }

    const content = await fs.readFile(absPath, "utf8");

    spinner.succeed(colors.dim(`  - Read full file: ${fileRelPath}`));
    return `<file path="${fileRelPath}">\n${content}\n</file>\n\n`;
  } catch (err) {
    spinner.fail(`File not found: ${fileRelPath}`);
    return `<file path="${fileRelPath}">[ERROR: File not found or unreadable]</file>\n\n`;
  }
}
