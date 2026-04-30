import { executeAnyTool } from "../toolExecutor.js";

export async function getDirectoryListing({ rootDir, toolContext }) {
  if (!rootDir) return "";

  try {
    const out = await executeAnyTool(
      "list_dir",
      { path: rootDir },
      toolContext,
    );
    return String(out ?? "");
  } catch (e) {
    return `[Could not list directory: ${e.message}]`;
  }
}
