import process from "node:process";
import { bundleDirectoryToText } from "#lib/bundleText.js";
import { parseArgs } from "./args.js";
import { forceCopyToClipboard } from "./clipboard.js";
import { colors } from "#app/ui/colors.js";

export async function main() {
  const { root, targetDir, maxBytes } = parseArgs(process.argv);

  process.stdout.write(`\n${colors.cyan("📦 Bundling:")} ${targetDir}\n`);

  const { text, stats } = await bundleDirectoryToText(targetDir, {
    maxBytes,
  });

  if (!text.trim()) {
    throw new Error(
      "Nothing to copy (all files skipped as binary or excluded).",
    );
  }

  try {
    forceCopyToClipboard(text);
    process.stdout.write(
      `\n${colors.green("✅ Copied to Clipboard!")}\n` +
        `   Root:          ${root}\n` +
        `   Target:        ${targetDir}\n` +
        `   Files bundled: ${stats.included}\n` +
        `   Files skipped: ${stats.skipped}\n` +
        `   Payload Size:  ${Math.round(stats.totalBytes / 1024)} KiB` +
        (stats.truncated
          ? colors.red(" (TRUNCATED - Hit Max Bytes Limit)")
          : "") +
        `\n\n`,
    );
  } catch (e) {
    process.stderr.write(
      `\n${colors.red("❌ Clipboard copy failed!")}\n   Reason: ${String(e?.message || e)}\n\n`,
    );
    process.exitCode = 1;
  }
}
