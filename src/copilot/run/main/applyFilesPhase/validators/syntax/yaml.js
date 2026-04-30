import fs from "node:fs/promises";
import path from "node:path";

/**
 * Validates YAML files for common SilverStripe Injector configuration errors.
 *
 * Two checks are performed:
 *
 * 1. Wrong `calls:` format — SilverStripe's Injector expects each entry under
 *    calls: to be:   myLabel: [methodName, ['%$ServiceName']]
 *    NOT:            methodName:
 *                      - ['%$...']
 *    The wrong (block-sequence) format throws:
 *      InvalidArgumentException: 1st element of a 'calls' entry should be a string
 *
 * 2. Double backslashes in service references — single-quoted YAML strings do
 *    not process escape sequences, so '%$Ns\\\\Class' becomes the four-character
 *    sequence \\, not a PHP namespace separator. Must use '%$Ns\\Class'.
 */
export async function checkYamlSyntax(projectDir, yamlFiles) {
  const errors = [];

  for (const absPath of yamlFiles) {
    const relPath = path.relative(projectDir, absPath);
    let content;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }

    // ── Check 1: Wrong calls: block-sequence format ───────────────────────
    // Matches:   calls:\n  <indent><key>:\n  <indent>  - ...
    // The value under the label key is a YAML block sequence (starts with -),
    // which parses as a nested array — SilverStripe expects a flat 2-element
    // array [methodName, [args]] as the value.
    const wrongCallsRe = /calls:\s*\n([ \t]+)([^\s#:\n][^:\n]*):\s*\n\1[ \t]+-[ \t]/g;
    let m;
    while ((m = wrongCallsRe.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      const badKey = m[2].trim();
      errors.push(
        `SilverStripe Injector Error in ${relPath} (near line ${lineNum}): ` +
          `Invalid 'calls' entry — "${badKey}" has a block-sequence value (starts with -) which ` +
          `causes: InvalidArgumentException: 1st element of a 'calls' entry should be a string.\n` +
          `WRONG:   calls:\n           ${badKey}:\n             - ['%$ServiceName']\n` +
          `CORRECT: calls:\n           myLabel: [${badKey}, ['%$ServiceName']]`,
      );
    }

    // ── Check 2: Double backslashes in service references ─────────────────
    // In single-quoted YAML, \\ is two literal backslash chars, producing
    // an invalid PHP namespace like Ns\\Class instead of Ns\Class.
    const doubleSlashRe = /['"]%\$[^'"]*\\\\[^'"]*['"]/g;
    while ((m = doubleSlashRe.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      errors.push(
        `SilverStripe Config Error in ${relPath} (near line ${lineNum}): ` +
          `Service reference contains double backslashes (\\\\) — use single backslashes (\\) ` +
          `for PHP namespace separators in YAML service refs. Found: ${m[0]}`,
      );
    }

    // ── Check 3: Service definitions outside Injector block ───────────────
    // Detects top-level YAML keys that look like PHP class names with calls:/
    // constructor:/class: children but are NOT under SilverStripe\Core\Injector\Injector:
    // This is a heuristic — only flag if the key contains a backslash (looks like
    // a PHP class) and has a 'class:' or 'constructor:' child at the same indent.
    const topLevelServiceRe =
      /^(SilverStripe\\[A-Za-z\\]+|Psr\\[A-Za-z\\]+|Monolog\\[A-Za-z\\]+):\s*\n([ \t]+)(class:|constructor:|calls:)/gm;
    while ((m = topLevelServiceRe.exec(content)) !== null) {
      // Skip if preceded by "Injector:\n" context — check the 300 chars before
      const before = content.slice(Math.max(0, m.index - 300), m.index);
      if (
        before.match(
          /SilverStripe\\Core\\Injector\\Injector:\s*\n(\s+[^\n]+\n)*\s*$/,
        )
      ) {
        continue;
      }
      const lineNum = content.slice(0, m.index).split("\n").length;
      errors.push(
        `SilverStripe Config Warning in ${relPath} (near line ${lineNum}): ` +
          `"${m[1]}" appears to be a service definition at the top level of the YAML file. ` +
          `Service definitions (class:, constructor:, calls:) must be nested under ` +
          `SilverStripe\\Core\\Injector\\Injector: to be registered with the Injector.`,
      );
    }
  }

  return errors;
}
