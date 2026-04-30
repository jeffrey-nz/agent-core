import path from "node:path";
import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { listDirectory } from "#lib/interactive/fs/index.js";
import { isSafePath } from "../utils.js";

export async function handleListDir(input, { rootDir, allowedDirs = [] }) {
  const dir = input.path;
  const spinner = createSpinner(colors.dim(`  - Listing dir: ${dir}`)).start();

  if (!isSafePath(rootDir, dir, allowedDirs)) {
    spinner.fail(`Path out of bounds: ${dir}`);
    return `[ERROR] Path out of bounds: ${dir}\n\n`;
  }

  // listDirectory resolves targetPath relative to its rootDir argument and then
  // checks the result stays within that rootDir. When dir is an absolute path
  // outside the main project root (but already validated above via allowedDirs),
  // the internal check would wrongly reject it. Pass dir itself as the listing
  // root so the guard passes correctly.
  const resolvedDir = path.resolve(dir);
  const resolvedRoot = path.resolve(rootDir);
  const listRoot =
    resolvedDir === resolvedRoot || resolvedDir.startsWith(resolvedRoot + path.sep)
      ? rootDir
      : dir;

  const res = await listDirectory(listRoot, dir);
  spinner.succeed(colors.dim(`  - Listed dir: ${dir}`));
  return res + "\n\n";
}
