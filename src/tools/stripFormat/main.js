import fg from "fast-glob";
import { parseArgs } from "#tools/stripFormat/args.js";
import { DEFAULT_IGNORES, TARGET_GLOBS } from "#tools/stripFormat/constants.js";
import { processFile } from "#tools/stripFormat/processFile.js";
import { run } from "#tools/stripFormat/run.js";

export async function main() {
  const { root, dryRun, keepDirectives } = parseArgs(process.argv);

  console.log(`\n[strip-and-format] root: ${root}`);
  console.log(`[strip-and-format] dryRun: ${dryRun}`);
  console.log(`[strip-and-format] keepDirectives: ${keepDirectives}\n`);

  const files = await fg(TARGET_GLOBS, {
    cwd: root,
    ignore: DEFAULT_IGNORES,
    dot: true,
  });

  let changedCount = 0;

  for (const file of files) {
    try {
      const res = await processFile(root, file, { dryRun, keepDirectives });
      if (res.changed) {
        changedCount++;
        if (dryRun) console.log(`[DRY] would update: ${file}`);
        else console.log(`updated: ${file}`);
      }
    } catch (err) {
      console.warn(`warn: failed ${file}: ${err?.message || err}`);
    }
  }

  console.log(
    `\n[strip-and-format] comment stripping complete. changed files: ${changedCount}`,
  );

  if (dryRun) {
    console.log("[strip-and-format] dry-run: skipping prettier --write");
    return;
  }

  console.log(
    `\n[strip-and-format] running: npx prettier ${root} --write --ignore-unknown`,
  );

  try {
    await run("npx", ["prettier", root, "--write", "--ignore-unknown"], {
      cwd: root,
    });
    console.log("\n[strip-and-format] done.\n");
  } catch (err) {
    console.error(`\n❌ [strip-and-format] Prettier failed: ${err.message}`);
  }
}
