import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { categorizeFiles } from "./validators/utils.js";
import { checkSyntax } from "./validators/syntax.js";
import { checkStaticAnalysis } from "./validators/staticAnalysis.js";
import { checkTests } from "./validators/tests.js";
import { checkHttpSmoke } from "./validators/httpSmoke.js";

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
