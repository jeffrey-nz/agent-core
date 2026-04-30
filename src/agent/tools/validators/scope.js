import path from "node:path";

const PATH_TOOLS = [
  "read_file",
  "write_file",
  "patch_file",
  "list_dir",
  "find_file",
  "delete_file",
  "move_file",
  "search_codebase",
  "grep",
  "revert_file",
];

export function validateScope(name, input, { focusDir, projectDir, refDir }) {
  const notes = [];

  if (focusDir && PATH_TOOLS.includes(name)) {
    const pathsToCheck = [
      { key: "path", value: input.path },
      { key: "source", value: input.source },
      { key: "destination", value: input.destination },
    ].filter((item) => Boolean(item.value));

    for (const item of pathsToCheck) {
      let p = item.value;

      if (p === "." || p === "./") {
        p = focusDir || projectDir;
        input[item.key] = p;
      }

      const resolvedP = path.resolve(focusDir || projectDir, p);
      const resolvedProjectDir = path.resolve(projectDir);

      if (refDir && resolvedP.startsWith(path.resolve(refDir))) continue;
      if (focusDir && resolvedP.startsWith(path.resolve(focusDir))) continue;

      if (resolvedP.startsWith(resolvedProjectDir)) {
        if (
          focusDir &&
          resolvedP !== path.resolve(focusDir) &&
          !resolvedP.startsWith(path.resolve(focusDir) + path.sep)
        ) {
          notes.push(
            `[SCOPE NOTE] "${p}" is outside your focus directory "${focusDir}" ` +
              `but within the project root "${projectDir}". Proceeding — confirm this is intentional.`,
          );
        }
      } else {
        return {
          error: `[SCOPE ERROR] "${p}" resolves to "${resolvedP}", which is outside the project root "${projectDir}". You must only work within ${projectDir}. Use ABSOLUTE paths only. HINT: If you must access external files, create an in-scope symlink via execute_bash first.`,
          notes,
        };
      }
    }
  }

  return { error: null, notes };
}
