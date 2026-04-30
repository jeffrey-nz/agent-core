import { askLine, askValidatedLine } from "#app/ui/readline/index.js";
import { ActionableError } from "#utils/errorWithSuggestion.js";

export async function askProjectDetails(rl) {
  const parentName = await askValidatedLine(
    rl,
    "Parent Group (e.g., opcorp, demo): ",
    (val) => val.trim() ? null : "Parent group cannot be empty",
    "opcorp"
  );
  const projectName = await askValidatedLine(
    rl,
    "Project Name (e.g., form-fixes-694): ",
    (val) => val.trim() ? null : "Project name is required",
    ""
  );

  const branchName = await askLine(
    rl,
    "Git Branch (e.g., PROJECT-694) [Leave blank to skip]: ",
  );
  const rawDirs = await askLine(
    rl,
    "Target subdirectories (comma-separated, e.g., graduation, certificate-request-form): ",
  );
  const targetDirs = rawDirs
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  const promptText = await askLine(rl, "Initial Prompt / Goal:\n> ");

  return {
    parentName: parentName.trim(),
    projectName: projectName.trim(),
    branchName: branchName.trim(),
    targetDirs,
    promptText,
  };
}
