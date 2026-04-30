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

  // Dev server + AI visual verification: React/Vite projects only.
  // Spins up `npm run dev`, screenshots the running app, and asks Claude Vision
  // to check for broken styles, missing board coloring, invisible pieces, etc.
  // The try/finally guarantees the dev server is killed even if vision throws.
  if (errors.length === 0) {
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
        `\n  [Verifier] ✘ Blocked! Deterministic errors or failing tests detected.`,
      ),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
