import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { getFileOutline } from "#lib/interactive/fs/index.js";

export async function handleOutlineFile(input, { rootDir }) {
  const spinner = createSpinner(
    colors.dim(`  - Outlining file: ${input.path}`),
  ).start();

  const res = await getFileOutline(rootDir, input.path);

  if (res.startsWith("[Error]")) {
    // Strip the "[Error] Could not outline file: " prefix so the spinner shows
    // the actual reason (e.g. "ENOENT: no such file or directory, open '...'").
    const reason = res.replace(/^\[Error\]\s*Could not outline file:\s*/, "");
    spinner.fail(colors.dim(`  - Outline failed: ${reason}`));
  } else {
    spinner.succeed(colors.dim(`  - Outlined file: ${input.path}`));
  }

  return res;
}
