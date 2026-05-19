import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { categorizeFiles } from "./validators/utils.js";
import { checkSyntax } from "./validators/syntax.js";
import { checkStaticAnalysis } from "./validators/staticAnalysis.js";
import { checkTests } from "./validators/tests.js";
import { checkHttpSmoke } from "./validators/httpSmoke.js";
import { startDevServer, killDevServer } from "./validators/devServer.js";
import { checkVisualVerify } from "./validators/visualVerify.js";

export async function runAdvancedValidator(projectDir, modifiedFilesAbs) {
  const categorized = categorizeFiles(modifiedFilesAbs);
  const errors = [];

  errors.push(...(await checkSyntax(projectDir, categorized)));

  errors.push(...(await checkStaticAnalysis(projectDir, categorized)));

  errors.push(...(await checkTests(projectDir, categorized)));

  // HTTP smoke test: curl localhost after any template/PHP/config change to
  // catch PHP warnings that produce HTTP 200 but inject error text into the page.
  // Only runs when static analysis passes — no point testing a broken build.
  if (errors.length === 0) {
    errors.push(...(await checkHttpSmoke(projectDir, modifiedFilesAbs)));
  }

  // Dev server + visual verification: only when the change is likely to affect what
  // the app looks like. Runs when either:
  //   a) An entry-point file was modified (App.tsx, main.tsx, index.tsx etc.), or
  //   b) A top-level app CSS file was modified (App.css, index.css, main.css) — these
  //      are always imported by the entry point and changes affect the whole UI.
  // Skipping on component-only or logic-only subtasks avoids false positives when
  // the component hasn't been wired into the app yet.
  const hasUiChanges = modifiedFilesAbs.some((f) =>
    /\.(jsx|tsx|css|html|svg)$/.test(f),
  );
  const ENTRY_POINT_RE = /(?:^|\/)(?:App|main|index)\.[jt]sx?$/i;
  const TOP_LEVEL_CSS_RE = /(?:^|\/)(?:App|main|index|global|styles?)\.css$/i;
  const hasEntryPointChange = modifiedFilesAbs.some(
    (f) => ENTRY_POINT_RE.test(f) || TOP_LEVEL_CSS_RE.test(f),
  );
  if (errors.length === 0 && hasUiChanges && hasEntryPointChange) {
    let devServerResult = null;
    try {
      devServerResult = await startDevServer(projectDir);
      if (devServerResult) {
        errors.push(...(await checkVisualVerify(projectDir, devServerResult)));
      }
    } finally {
      if (devServerResult?.pid) await killDevServer(devServerResult.pid);
    }
  }

  if (errors.length > 0) {
    log(
      colors.red(
        `\n  [Verifier] ✘ Blocked! ${errors.length} deterministic error(s) detected:`,
      ),
    );
    // Surface the first 3 errors (truncated) so users can see WHY the verifier blocked.
    // The full errors are still passed back to the coder in the next turn.
    for (let i = 0; i < Math.min(errors.length, 3); i++) {
      const err = errors[i];
      const summary = typeof err === "string" ? err.slice(0, 400) : JSON.stringify(err).slice(0, 400);
      log(colors.red(`    ${i + 1}. ${summary.split("\n")[0]}`));
    }
    if (errors.length > 3) {
      log(colors.dim(`    ... and ${errors.length - 3} more`));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
