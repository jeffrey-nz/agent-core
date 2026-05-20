/**
 * patchReviewerNode.js — Implementation Diff Reviewer
 *
 * Runs AFTER the coder and BEFORE the verifier.
 * Catches implementation bugs that are INVISIBLE to the HTTP 200 smoke test
 * but are guaranteed to cause semantic failures in production.
 *
 * Root cause addressed (session 04302011):
 *   The coder added a conditional Elemental rendering block to Page.ss but
 *   left the old unconditional `$Content` line untouched above it. Result:
 *   Content ALWAYS rendered, then Elemental conditionally below it.
 *   The smoke test returned HTTP 200 (page loaded fine), so the verifier PASSed.
 *   The feature appeared to work until manual inspection revealed dual rendering.
 *
 * Checks performed (deterministic, no AI latency):
 *
 *   1. TEMPLATE DUAL-RENDERING (.ss, .html, .erb, .twig)
 *      Scans modified template files for the pattern:
 *      "unconditional $Content/Body outside any <% if %> block" AND
 *      "conditional $ElementalArea inside a <% if %> block"
 *      → If both found: FAIL with exact line numbers
 *
 *   2. YAML CLASS NAME QUOTING (.yml, .yaml)
 *      Checks for PHP namespace class names wrapped in single quotes.
 *      'DNADesign\Elemental\...' = wrong (two literal backslashes in PHP)
 *      DNADesign\Elemental\...  = correct (unquoted, single backslash)
 *      → If single-quoted namespaces found: FAIL with exact line
 *
 *   3. STUB / EMPTY FILES
 *      Checks that modified files have meaningful content (not just whitespace
 *      or a few lines that suggest the coder wrote a placeholder rather than
 *      the real implementation).
 *      → If < 100 non-whitespace chars: FAIL with prompt to complete
 *
 *   4. DOUBLE JSON ENCODING (.js, .ts, .svelte, .jsx, .tsx)
 *      Detects variables built from JSON.stringify/serialize* calls that are then
 *      wrapped in JSON.stringify again. This double-encodes the data, causing
 *      downstream PHP json_decode($entry) to receive a PHP array instead of a string.
 *      Root cause: Export.svelte used JSON.stringify(selectedDeptObjects) instead of
 *      JSON.stringify(departmentValues) — departmentValues was already an array of strings.
 *      → If double-encoding pattern found: FAIL with line number and fix instructions
 *
 *   5. JAVASCRIPT SYNTAX CHECK (.js, .mjs, .cjs)
 *      Runs `node --check <file>` on modified JS files. Catches syntax errors that Node.js
 *      would throw at require/import time: unclosed block comments, invalid expressions like
 *      `2dir` instead of `2*dir`, missing template literal backticks, etc.
 *      → If node --check exits non-zero: FAIL with the exact error message
 *
 *   5b. PHP SYNTAX CHECK (.php)
 *      Runs `php -l <file>` on modified PHP files. Catches parse errors before the
 *      HTTP smoke test hits them and produces a less-actionable HTTP 500.
 *
 *  5bb. PYTHON SYNTAX CHECK (.py)
 *      Runs `python3 -m py_compile <file>` on modified Python files. Catches
 *      IndentationError, SyntaxError, and invalid token errors at diff-review time.
 *
 *  5bc. PYTHON DUPLICATE DEF/CLASS CHECK (.py)
 *      Detects the "growing file" failure in Python: coder appends a patched
 *      function/class without removing the original top-level definition.
 *      Python silently uses the last definition — the earlier one is dead code.
 *      → If any top-level def/class name appears twice: FAIL
 *
 *  5bd. PYTHON EMPTY TEST FILE CHECK (test_*.py / *_test.py)
 *      A test file that defines no `def test_` functions will have pytest report
 *      "collected 0 items" and exit 0 — a false-passing test run.
 *      Catches placeholder test files and test files where all tests were accidentally
 *      deleted or the coder forgot to write the actual test functions.
 *      → If a Python test file has no test functions: FAIL with fix instructions
 *
 *   5c. RUBY SYNTAX CHECK (.rb)
 *      Runs `ruby -c <file>` on modified Ruby files. Catches parse errors (missing
 *      "end", unclosed strings, method syntax errors) at diff-review time.
 *
 *  5cc. RUBY DUPLICATE DEF CHECK (.rb)
 *      Detects the "growing file" failure in Ruby: coder appends a patched method
 *      without removing the original top-level definition. Ruby silently uses the
 *      last definition — the earlier one is dead code.
 *      → If any top-level def name appears twice: FAIL
 *
 *  5cd. RUBY EMPTY SPEC FILE CHECK (*_spec.rb)
 *      An RSpec spec file with no `it`, `specify`, or `example` blocks has RSpec
 *      report "0 examples, 0 failures" and exit 0 — a false-passing test run.
 *      Catches placeholder spec files where the coder forgot to write actual tests.
 *      → If a spec file has no example blocks: FAIL with fix instructions
 *
 *   5d. MISSING EXPORT CHECK (.ts, .tsx, .js, .jsx)
 *      PascalCase filenames (ChessBoard.tsx) are almost always React components.
 *      A component file with no `export` keyword is dead code — nothing can import it.
 *      → If no `export` found in a PascalCase component file: FAIL with fix instructions
 *
 *   5e. DUPLICATE FUNCTION/CONST CHECK (.js, .mjs, .cjs, .ts, .tsx, .jsx)
 *      Detects the "growing file" failure: coder appends a patched function without
 *      removing the original, leaving two definitions of the same name.
 *      → If any function/const name appears twice in the same file: FAIL
 *
 *   6. IMPLEMENTATION NOTE MISMATCH (delete/remove instructions not followed)
 *
 *   7. CROSS-FILE HTML-JS ID CONSISTENCY (.js, .ts, .jsx, .tsx, .cjs)
 *      Scans all HTML files in the project for id="X" attributes, then checks
 *      that every document.getElementById("X") call in modified JS files
 *      references an ID that actually exists in the HTML.
 *      → If JS references an ID not found in any HTML file: FAIL
 *
 *   8. CROSS-FILE HTML-CSS ID CONSISTENCY (.css)
 *      Same HTML scan, applied to CSS #id selectors. Catches selectors like
 *      #game-root when the HTML element is id="game", or #header when HTML
 *      has id="game-header".
 *      → If CSS targets an ID not found in any HTML file: FAIL
 *
 *  8a. CSS/SCSS BRACE BALANCE (.css, .scss, .sass)
 *      Counts opening { vs closing } after stripping comments. An unmatched
 *      brace silently drops all subsequent styles — the HTTP smoke test passes
 *      (200 OK) but the page looks broken.
 *      → If brace counts differ: FAIL with missing/extra count
 *
 *      If the subtask's implementation_note says "DELETE", "REMOVE", or "must be deleted"
 *      for a specific line, reads the target file and checks if that pattern still exists.
 *      → If the old pattern is still present: FAIL with exact line reference
 *
 *  10. GIT CONFLICT MARKERS (any text file)
 *      Detects unresolved merge conflict markers: <<<<<<< HEAD, =======, >>>>>>> branch.
 *      These make files unparseable and cause immediate syntax/runtime errors.
 *      → If conflict markers found: FAIL with exact line numbers
 *
 *  11. ESM / COMMONJS MISMATCH (.mjs, .cjs, .js, .jsx)
 *      .mjs files using require() → ReferenceError at runtime (ESM-only).
 *      .cjs files using static import → SyntaxError (CommonJS-only).
 *      .js files in a "type":"module" package using require() → ReferenceError.
 *      → If mismatch detected: FAIL with fix instructions
 *
 *  12. YAML SYNTAX CHECK (.yml, .yaml)
 *      Parses modified YAML files with js-yaml. Catches bad indentation, unclosed
 *      strings, duplicate keys at the same level, and other structural errors.
 *      → If parse fails: FAIL with the exact line number and fix advice
 *
 *  13. JSON SYNTAX CHECK (.json)
 *      Parses modified JSON files with JSON.parse(). Catches trailing commas,
 *      missing commas, unquoted keys, JS-style comments, and single-quoted strings.
 *      → If parse fails: FAIL with the SyntaxError message and fix advice
 *
 *  14. GO BUILD + VET CHECK (project-level, runs once if any .go files were modified)
 *      Runs `go build ./...` to catch compile errors (undefined names, type mismatches,
 *      missing imports) that per-file regex checks cannot find.
 *      If build succeeds, also runs `go vet ./...` to catch semantic issues: wrong
 *      Printf format strings, mutex copying, unreachable code, etc.
 *      → If build fails and go is installed: FAIL with go build output
 *      → If vet fails: FAIL with go vet output
 *
 *  15. GO TEST FILE NAMING (.go files that contain func Test… but don't end in _test.go)
 *      Go only runs tests in files ending with `_test.go`. A file named `test_foo.go`
 *      or `calculator_test_helpers.go` that defines `func TestFoo(t *testing.T)` will
 *      compile as regular package code but its tests are NEVER executed by `go test`.
 *      The build passes, `go test ./...` reports "ok" with 0 tests, giving false confidence.
 *      → If test functions found in a non-_test.go file: FAIL with rename instructions
 *
 *  16. CROSS-FILE PYTHON IMPORT CHECK (project-level, runs if any .py files modified)
 *      For every `from <localmodule> import <Name>` in a modified .py file, verifies
 *      that <localmodule>.py actually defines <Name>. py_compile accepts a bad import
 *      (it's valid syntax) — the error only surfaces at runtime/pytest as ImportError
 *      (pytest exit 2). Catching it here names the exact missing symbol AND lists what
 *      the module does export, which a raw "ImportError" traceback does not.
 *      → If an imported name is missing from a local module: FAIL with both halves
 *
 * Position in graph: coder → patchReviewer → [OK] verifier
 *                                           → [FAIL] coder
 *
 * Retry safety: after MAX_PATCH_REVIEW_RETRIES, pass through to verifier so
 * the verifier's own retry cap handles the final escalation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";
import { MAX_VERIFIER_RETRIES } from "#config/pipeline.js";
import { execAsync } from "#utils/exec.js";
import yaml from "js-yaml";

const PERSONA = personaMeta("patchReviewer");

// After this many patchReview failures on the same subtask, pass to verifier.
// This prevents patchReviewer from creating its own infinite loop separate
// from verifier's retry cap.
const MAX_PATCH_REVIEW_RETRIES = 2;

// ── Template dual-render detection ──────────────────────────────────────────

/**
 * Parse a SilverStripe/generic template and detect dual-rendering.
 *
 * Returns an array of issue objects: { type, line, description }
 */
function analyzeTemplate(content, filename) {
  const issues = [];
  const lines = content.split("\n");

  // Track conditional nesting depth
  let conditionalDepth = 0;
  const unconditionalContentLines = [];
  const conditionalElementalLines = [];
  const unconditionalElementalLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Count conditional opens/closes (SilverStripe template syntax)
    const ifOpens = (line.match(/<%-?\s*if\s/gi) || []).length;
    const ifCloses = (line.match(/<%-?\s*end_if\s*-?%>/gi) || []).length;

    const prevDepth = conditionalDepth;
    conditionalDepth = Math.max(0, conditionalDepth + ifOpens - ifCloses);

    // Check for unconditional $Content (not inside any <% if %>)
    // Only flag if the $Content is the primary content of the line, not in a comment
    if (
      !/<%--/.test(line) && // not inside a comment
      /\$Content\b/.test(line) &&
      prevDepth === 0 && // was unconditional when this line was entered
      !/<%-?\s*if\s/.test(line) // not an if-line itself (e.g. <% if $Content %>)
    ) {
      unconditionalContentLines.push(lineNo);
    }

    // Check for $ElementalArea inside a conditional
    if (/\$ElementalArea\b/i.test(line) && conditionalDepth > 0) {
      conditionalElementalLines.push(lineNo);
    }
    if (/\$ElementalArea\b/i.test(line) && conditionalDepth === 0) {
      unconditionalElementalLines.push(lineNo);
    }
  }

  // Dual-rendering: unconditional $Content + conditional $ElementalArea
  if (unconditionalContentLines.length > 0 && conditionalElementalLines.length > 0) {
    issues.push({
      type: "DUAL_RENDERING",
      description:
        `Template has DUAL RENDERING: unconditional $Content on line(s) ${unconditionalContentLines.join(", ")} ` +
        `will ALWAYS render, AND conditional $ElementalArea on line(s) ${conditionalElementalLines.join(", ")} ` +
        `will render for pages with elements.\n` +
        `FIX: Remove the unconditional $Content line(s) entirely — keep ONLY the conditional block:\n` +
        `  <% if $ElementalArea && $ElementalArea.Elements.Count %>\n` +
        `    $ElementalArea\n` +
        `  <% else_if $Content %>\n` +
        `    $Content\n` +
        `  <% end_if %>`,
      lines: unconditionalContentLines,
    });
  }

  // Unconditional ElementalArea (missing the conditional guard)
  if (unconditionalElementalLines.length > 0 && conditionalElementalLines.length === 0) {
    // Only flag if $Content is also present unconditionally (definite dual-render)
    if (unconditionalContentLines.length > 0) {
      issues.push({
        type: "DUAL_RENDERING_BOTH_UNCONDITIONAL",
        description:
          `Both $Content (line ${unconditionalContentLines.join(", ")}) and $ElementalArea ` +
          `(line ${unconditionalElementalLines.join(", ")}) are unconditional — both will always render.\n` +
          `FIX: Wrap both inside a conditional: <% if $ElementalArea %> ... <% else_if $Content %> ... <% end_if %>`,
        lines: [...unconditionalContentLines, ...unconditionalElementalLines],
      });
    }
  }

  return issues;
}

// ── YAML class name quoting detection ────────────────────────────────────────

/**
 * Check a YAML file for single-quoted PHP namespace class names.
 * These cause a double-backslash runtime error in SilverStripe.
 */
function analyzeYaml(content) {
  const issues = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Pattern: single-quoted string containing backslash-separated namespace
    // e.g. '- ''DNADesign\Elemental\...'
    if (/'[A-Za-z]+\\[A-Za-z]/.test(line)) {
      issues.push({
        type: "YAML_SINGLE_QUOTED_CLASS",
        description:
          `Line ${i + 1}: PHP class name is wrapped in single quotes: ${line.trim()}\n` +
          `Single-quoted YAML strings pass double backslashes to PHP, causing "references nonexistent \\ClassName" errors.\n` +
          `FIX: Remove the single quotes — class names MUST be unquoted in YAML extensions: lists.`,
        lines: [i + 1],
      });
    }
  }

  return issues;
}

// ── Stub file detection ───────────────────────────────────────────────────────

/**
 * Check if a file is suspiciously short (likely a stub rather than a real implementation).
 */
function isStubFile(content, filename) {
  const nonWhitespace = content.replace(/\s/g, "").length;
  // Only flag code files with actual content expected.
  // IMPORTANT: exclude .yml/.yaml — valid config files can be intentionally short
  // (e.g. a 3-line errorpage.yml). Applying a char-count threshold to YAML creates
  // false positives on correct minimal config files and burns patchReviewer retries.
  const isCodeFile = /\.(php|ss|js|ts|py|rb|java|cs|go)$/i.test(filename);
  if (!isCodeFile) return false;
  return nonWhitespace < 80;
}

// ── Double JSON encoding detection ───────────────────────────────────────────

/**
 * Detect variables that hold pre-serialized JSON strings being wrapped in
 * JSON.stringify again (double-encoding).
 *
 * Root cause addressed: Export.svelte sent JSON.stringify(selectedDeptObjects)
 * instead of JSON.stringify(departmentValues). The departmentValues array already
 * contained JSON strings; re-wrapping caused PHP's json_decode($entry) to receive
 * a PHP array instead of a string, producing a fatal type error.
 */
function analyzeDoubleEncoding(content) {
  const issues = [];
  const serializedVars = new Set();

  // Find vars assigned from JSON.stringify(...) or serialize*(...)
  const assignRe = /(?:const|let|var)\s+(\w+)\s*=[^;]*(?:JSON\.stringify|serialize[A-Z]\w*)\s*\(/g;
  let m;
  while ((m = assignRe.exec(content)) !== null) {
    serializedVars.add(m[1]);
  }

  // Find arrays populated via .push(JSON.stringify(...)) or .push(serialize*(...))
  const pushRe = /(\w+)\.push\s*\(\s*(?:JSON\.stringify|serialize[A-Z]\w*)\s*\(/g;
  while ((m = pushRe.exec(content)) !== null) {
    serializedVars.add(m[1]);
  }

  // Flag JSON.stringify(serializedVar) — wrapping already-serialized arrays
  for (const varName of serializedVars) {
    const doubleRe = new RegExp(`JSON\\.stringify\\s*\\(\\s*${varName}\\s*[,)]`, "g");
    while ((m = doubleRe.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      issues.push({
        type: "DOUBLE_JSON_ENCODING",
        description:
          `Line ~${lineNo}: \`JSON.stringify(${varName})\` — but \`${varName}\` appears to already ` +
          `contain serialized JSON strings (built via JSON.stringify or serialize* functions).\n` +
          `This double-encodes the data: downstream consumers (e.g. PHP json_decode($entry)) ` +
          `will receive a PHP array instead of a string, causing a type error.\n` +
          `FIX: Pass the raw array of string values directly — do not wrap in JSON.stringify again.`,
        lines: [lineNo],
      });
    }
  }

  return issues;
}

// ── Implementation note "delete" check ───────────────────────────────────────

/**
 * Extract patterns that the implementation_note says should be DELETED.
 * Looks for: "DELETE line N: `pattern`", "REMOVE: `pattern`", "must be deleted: `pattern`"
 * Returns array of { pattern, context } objects.
 */
function extractDeletionRequirements(implementationNote) {
  if (!implementationNote) return [];

  const deletionRe = /(?:DELETE|REMOVE|MUST BE DELETED)[^\n`"]*[`"]([^`"]{3,120})[`"]/gi;
  const matches = [...implementationNote.matchAll(deletionRe)];

  return matches
    .map((m) => m[1]?.trim())
    .filter(Boolean)
    .filter((p) => p.length >= 4); // ignore trivially short patterns
}

// ── Cross-file ID consistency check ──────────────────────────────────────────

/**
 * Collect all id="X" attribute values from every HTML file in the project.
 * Returns a Set of string IDs.
 */
async function collectHtmlIds(projectDir) {
  const ids = new Set();
  let htmlFiles = [];
  try {
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.html?$/i.test(e.name)) htmlFiles.push(full);
      }
    };
    await walk(projectDir);
  } catch { /* non-fatal */ }

  for (const f of htmlFiles) {
    try {
      const src = await fs.readFile(f, "utf8");
      const re = /\bid\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(src)) !== null) ids.add(m[1].trim());
    } catch { /* skip unreadable */ }
  }
  return ids;
}

/**
 * Collect all id="X" attribute values from .ss template files in the project.
 * SilverStripe projects define IDs in .ss templates, not .html files, so this
 * is called after collectHtmlIds to supplement the ID set.
 */
async function collectSsTemplateIds(projectDir, ids) {
  const walk = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "vendor") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.ss$/i.test(e.name)) {
          try {
            const src = await fs.readFile(full, "utf8");
            const re = /\bid\s*=\s*["']([^"']+)["']/gi;
            let m;
            while ((m = re.exec(src)) !== null) ids.add(m[1].trim());
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* non-fatal */ }
  };
  await walk(projectDir);
}

/**
 * Check a JS file for document.getElementById("X") calls whose ID is not
 * present in any HTML file in the project. Handles simple string literals;
 * skips dynamic/computed IDs (e.g. "tableau-" + i → prefix "tableau-" is
 * matched against any HTML id that starts with that prefix).
 *
 * Returns an array of issue objects.
 */
function analyzeJsIdRefs(content, filename, htmlIds) {
  if (htmlIds.size === 0) return []; // no HTML to compare against
  const issues = [];

  // Match: getElementById("literal") or getElementById('literal')
  const literalRe = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = literalRe.exec(content)) !== null) {
    const id = m[1];
    if (!htmlIds.has(id)) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      issues.push({
        type: "JS_MISSING_HTML_ID",
        description:
          `Line ${lineNo}: \`getElementById("${id}")\` — but no HTML element has \`id="${id}"\`.\n` +
          `Either add \`id="${id}"\` to the correct HTML element, or fix the ID string to match the HTML.\n` +
          `HTML ids found: ${[...htmlIds].join(", ")}`,
      });
    }
  }

  // Match: querySelector('#literal') or querySelectorAll('#literal')
  // Only flag when the selector is a plain #id (not a compound like '#foo .bar')
  const qsIdRe = /querySelectorAll?\(\s*["']#([\w-]+)["']\s*\)/g;
  while ((m = qsIdRe.exec(content)) !== null) {
    const id = m[1];
    if (!htmlIds.has(id)) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      issues.push({
        type: "JS_MISSING_HTML_ID",
        description:
          `Line ${lineNo}: \`querySelector("#${id}")\` — but no HTML element has \`id="${id}"\`.\n` +
          `Either add \`id="${id}"\` to the correct HTML element, or fix the selector to match the HTML.\n` +
          `HTML ids found: ${[...htmlIds].join(", ")}`,
      });
    }
  }

  // Match: getElementById("prefix-" + expr) — check that at least one HTML id
  // exists with that prefix followed by a digit (e.g. "tableau-0", "foundation-0").
  // Ignores non-numeric suffixes like "foundation-spades" which is a different
  // naming scheme and would cause a false negative if allowed to match.
  const prefixRe = /getElementById\(\s*["']([^"']+)['"]\s*\+/g;
  while ((m = prefixRe.exec(content)) !== null) {
    const prefix = m[1];
    const anyNumericMatch = [...htmlIds].some(id => {
      if (!id.startsWith(prefix)) return false;
      const rest = id.slice(prefix.length);
      return /^\d/.test(rest); // expect numeric suffix (e.g. "tableau-0")
    });
    if (!anyNumericMatch) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      const similar = [...htmlIds].filter(id => id.startsWith(prefix.split("-")[0]));
      const hint = similar.length
        ? `\nHTML ids with similar prefix: ${similar.join(", ")}`
        : `\nHTML ids found: ${[...htmlIds].join(", ")}`;
      issues.push({
        type: "JS_MISSING_HTML_ID_PREFIX",
        description:
          `Line ${lineNo}: \`getElementById("${prefix}" + ...)\` — but no HTML element has an id like "${prefix}0", "${prefix}1", etc.\n` +
          `Either add elements with numeric ids like \`id="${prefix}0"\`, \`id="${prefix}1"\`, or fix the prefix string.` +
          hint,
      });
    }
  }

  return issues;
}

/**
 * Check a CSS file for #id selectors whose ID is not present in any HTML
 * file. Returns an array of issue objects.
 */
function analyzeCssIdRefs(content, filename, htmlIds) {
  if (htmlIds.size === 0) return [];
  const issues = [];

  // Match top-level #id selectors (not inside strings or url() calls)
  // Simple heuristic: lines starting with or containing #word { or #word,
  const re = /(?:^|[,\s{])#([\w-]+)\s*[{,>~+\s]/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (!htmlIds.has(id)) {
      const lineNo = content.slice(0, m.index).split("\n").length;
      issues.push({
        type: "CSS_MISSING_HTML_ID",
        description:
          `Line ${lineNo}: CSS selector \`#${id}\` — but no HTML element has \`id="${id}"\`.\n` +
          `Either add \`id="${id}"\` to the correct HTML element, or rename the selector to match the HTML.\n` +
          `HTML ids found: ${[...htmlIds].join(", ")}`,
      });
    }
  }

  return issues;
}

// ── Main node ─────────────────────────────────────────────────────────────────

export async function patchReviewerNode(state) {
  // Skip on retry if we've already sent back too many times
  const patchRetries = state.patchReviewRetryCount ?? 0;
  if (patchRetries >= MAX_PATCH_REVIEW_RETRIES) {
    log(colors.dim(`  [PatchReview] Retry cap (${patchRetries}) reached — passing to verifier`));
    return { patchReviewFeedback: "OK" };
  }

  // Skip when the coder turn itself failed (coderFailed=true means stale modifiedFiles)
  if (state.coderFailed) {
    return { patchReviewFeedback: "OK" };
  }

  // Skip when nuclear wrote the file directly for a limited-output provider (e.g. DeepSeek).
  // The coder cannot implement patch feedback for this provider type — the nuclear result
  // is as good as it gets, so let the verifier judge it directly.
  if (state.nuclearExtracted) {
    log(colors.dim(`  [PatchReview] Nuclear extraction — skipping review for limited-output provider`));
    return { patchReviewFeedback: "OK" };
  }

  // Skip if there are no modified files to review
  const modifiedFiles = state.modifiedFiles || [];
  if (modifiedFiles.length === 0) {
    return { patchReviewFeedback: "OK" };
  }

  // Near the verifier retry cap — don't add another layer of rejection, pass through
  const coderRetries = state.coderRetryCount ?? 0;
  if (coderRetries >= MAX_VERIFIER_RETRIES - 1) {
    log(colors.dim(`  [PatchReview] Near retry cap (${coderRetries}) — passing to verifier`));
    return { patchReviewFeedback: "OK" };
  }

  const currentSubtask = state.subtasks?.[state.currentSubtaskIndex];
  const currentTask = currentSubtask?.task || "";

  // Skip acceptance tests and investigation tasks — they don't write files
  if (/^ACCEPTANCE TEST:/i.test(currentTask) || /^REVIEW:/i.test(currentTask)) {
    return { patchReviewFeedback: "OK" };
  }

  log(colors.dim("  [Graph] -> 🔬 Running Patch Reviewer..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: `Reviewing ${modifiedFiles.length} modified file(s) for implementation correctness`,
  });

  const projectDir = state.projectDir || "";
  const implementationNote = currentSubtask?.implementationNote || currentSubtask?.implementation_note || "";
  const deletionRequirements = extractDeletionRequirements(implementationNote);

  // Clear per-subtask caches so each review pass starts fresh
  globalThis.__patchReviewHtmlIds = null;
  globalThis.__patchReviewPkgType = null;

  const allIssues = [];

  for (const relPath of modifiedFiles.slice(0, 8)) {
    // Reject placeholder paths like "path/to/file.ext", "...", or "filename.ext"
    const normalizedRel = relPath.replace(/\\/g, "/");
    const isPlaceholderPath =
      /^path\/to\//i.test(normalizedRel) ||
      /\/path\/to\//i.test(normalizedRel) ||
      /^\.\.\./.test(normalizedRel) ||
      /^[^/]+\.(ext|example|placeholder)$/i.test(path.basename(normalizedRel));
    if (isPlaceholderPath) {
      allIssues.push({
        file: relPath,
        type: "PLACEHOLDER_PATH",
        description:
          `File written to a placeholder path "${relPath}" — this is a template example, not a real project path.\n` +
          `Determine the correct file path in the project and write to that location instead.`,
      });
      continue;
    }

    const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
    const filename = path.basename(relPath);
    const ext = path.extname(relPath).toLowerCase();

    let content = null;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      // File might not exist yet (deleted, wrong path) — skip
      continue;
    }

    // 1. Stub file check
    if (isStubFile(content, filename)) {
      allIssues.push({
        file: relPath,
        type: "STUB_FILE",
        description:
          `File appears to be a stub or placeholder (${content.replace(/\s/g, "").length} non-whitespace chars).\n` +
          `The file may not contain the full implementation. Verify it is complete.`,
      });
    }

    // 1b. Stub comment pattern — coder wrote placeholder text like
    //     "// Existing logic would normally be defined above this comment"
    //     instead of actual code. Catch this explicitly since such files
    //     can be hundreds of lines of real-looking stubs.
    const stubCommentPattern = /\/\/\s*(existing|previous|original|prior)\s+\w+.*(would|normally|should|already).*(be|is|are)\s+(defined|present|above|here|in\s+place)/i;
    const stubCssPattern = /\/\*\s*(existing|previous|original|prior)\s+\w+.*(would|normally|should|already).*(be|is|are)\s+(defined|present|above|here|in\s+place)/i;
    // Also catch "...full content..." / "...existing code..." triple-dot placeholders
    // written by Copilot when it hits context limits and can't write the actual file.
    const tripleDotPlaceholder = /^\s*\.\.\.(full file content|full content|existing content|existing code|rest of file|rest of code|previous content|original code)\.\.\.\s*$/im;
    // Catch nuclear retry template placeholders copied verbatim: "YOUR COMPLETE X CODE HERE", "<insert ... here>"
    const nuclearPlaceholder = /^(YOUR COMPLETE \w+ CODE HERE|<insert complete .+ here>)$/im;
    if (stubCommentPattern.test(content) || stubCssPattern.test(content) || tripleDotPlaceholder.test(content) || nuclearPlaceholder.test(content)) {
      allIssues.push({
        file: relPath,
        type: "STUB_COMMENT",
        description:
          `File contains a placeholder ("...full content..." or stub comment) instead of actual code.\n` +
          `You MUST write the COMPLETE file content — not a placeholder referencing the existing code.\n` +
          `The existing file content is NOT automatically included. You must write every line explicitly.\n` +
          `Read the current file first to see what's there, then rewrite it completely with your additions.`,
      });
    }

    // 2. Template dual-rendering check (.ss, .html, .erb, .twig)
    if (/\.(ss|html|erb|twig)$/i.test(ext)) {
      const templateIssues = analyzeTemplate(content, filename);
      for (const issue of templateIssues) {
        allIssues.push({ file: relPath, ...issue });
      }
    }

    // 3. YAML single-quoted class names
    if (/\.(yml|yaml)$/i.test(ext)) {
      const yamlIssues = analyzeYaml(content);
      for (const issue of yamlIssues) {
        allIssues.push({ file: relPath, ...issue });
      }
    }

    // 4. Double JSON encoding check (.js, .ts, .svelte, .jsx, .tsx)
    if (/\.(js|ts|svelte|jsx|tsx)$/i.test(ext)) {
      const encodingIssues = analyzeDoubleEncoding(content);
      for (const issue of encodingIssues) {
        allIssues.push({ file: relPath, ...issue });
      }
    }

    // 5. JavaScript syntax check — run `node --check` on plain JS files
    // Catches parse-time errors (unclosed comments, invalid expressions, missing
    // backticks in template literals) that no regex heuristic can reliably find.
    if (/\.(m?js|cjs)$/i.test(ext) && !relPath.includes("node_modules")) {
      const syntaxResult = await execAsync(`node --check ${JSON.stringify(absPath)}`);
      if (syntaxResult.status !== 0) {
        const errText = (syntaxResult.stderr || syntaxResult.stdout || "").trim();
        // Detect stripped template literal backticks: SyntaxError involving `${`
        const strippedBacktick = /Unexpected token '\{'/.test(errText) || /\$\{/.test(errText);
        const backtickWarning = strippedBacktick
          ? `\n\nCRITICAL — Template literal backticks are stripped by this environment.\n` +
            `DO NOT use template literals (backtick strings). Use string concatenation instead:\n` +
            `  WRONG:  id: \`card-\${rank}_of_\${suit}\`\n` +
            `  RIGHT:  id: 'card-' + rank + '_of_' + suit\n` +
            `Replace ALL template literals in the file with string concatenation.`
          : "";
        allIssues.push({
          file: relPath,
          type: "JS_SYNTAX_ERROR",
          description:
            `JavaScript syntax error detected by \`node --check\`:\n\n${errText}${backtickWarning}\n\n` +
            `Fix the syntax error(s) above using write_file before this subtask can pass.`,
        });
      }
    }

    // 5b. PHP syntax check — run `php -l` on modified PHP files.
    // Catches parse errors (missing semicolons, mismatched braces, invalid tokens)
    // before the HTTP smoke test can hit them and produce a less actionable 500.
    if (/\.php$/i.test(ext) && !relPath.includes("vendor/")) {
      const phpResult = await execAsync(`php -l ${JSON.stringify(absPath)}`);
      if (phpResult.status !== 0) {
        const errText = (phpResult.stdout || phpResult.stderr || "").trim();
        // Only report when output contains actual PHP error messages.
        // Only report when output contains actual PHP error messages.
        // Skip if php is not installed ("command not found").
        if (!/command not found|No such file|not found/i.test(errText) && errText.length > 0) {
          allIssues.push({
            file: relPath,
            type: "PHP_SYNTAX_ERROR",
            description:
              `PHP syntax error detected by \`php -l\`:\n\n${errText}\n\n` +
              `Fix the syntax error(s) above using write_file or patch_file before this subtask can pass.`,
          });
        }
      }
    }

    // 5bb. Python syntax check — run `python3 -m py_compile` on modified .py files.
    // Catches IndentationError, SyntaxError, and invalid token errors before they
    // surface at runtime as a cryptic ImportError or traceback.
    if (/\.py$/i.test(ext) && !relPath.includes("/.venv/") && !relPath.includes("/site-packages/")) {
      const pyResult = await execAsync(`python3 -m py_compile ${JSON.stringify(absPath)} 2>&1`);
      if (pyResult.status !== 0) {
        const errText = (pyResult.stdout || pyResult.stderr || "").trim();
        // Only report when the output contains actual Python error messages.
        // Silently skip if python3 is not installed (errText will say "command not found").
        if (/SyntaxError:|IndentationError:|py_compile|invalid syntax|unexpected indent|EOL while|EOF while|line \d|^\s*\^/im.test(errText)) {
          allIssues.push({
            file: relPath,
            type: "PYTHON_SYNTAX_ERROR",
            description:
              `Python syntax error detected by \`python3 -m py_compile\`:\n\n${errText}\n\n` +
              `Fix the syntax error(s) above before this subtask can pass.\n` +
              `Common causes: bad indentation, missing colon after if/def/class, unclosed bracket or string.`,
          });
        }
      }
    }

    // 5bc. Python duplicate def/class check — catches "growing file" regression in .py files.
    //      Happens when the coder appends a fixed function without removing the original.
    //      Two top-level definitions of the same name cause the second to silently shadow
    //      the first (Python doesn't error on redefinition).
    if (/\.py$/i.test(ext) && !relPath.includes("/.venv/") && !relPath.includes("/site-packages/")) {
      const pyNames = [];
      // Only match top-level defs/classes (no leading indentation) to avoid false
      // positives from methods inside different classes with the same name.
      const pyFuncRe = /^def\s+([A-Za-z_]\w*)\s*[(:]/gm;
      const pyClassRe = /^class\s+([A-Za-z_]\w*)\s*[:(]/gm;
      let pm;
      while ((pm = pyFuncRe.exec(content)) !== null) pyNames.push(pm[1]);
      while ((pm = pyClassRe.exec(content)) !== null) pyNames.push(pm[1]);
      const pySeen = new Set();
      const pyDupes = new Set();
      for (const n of pyNames) {
        if (pySeen.has(n)) pyDupes.add(n);
        else pySeen.add(n);
      }
      if (pyDupes.size > 0) {
        const dupeList = [...pyDupes].join(", ");
        allIssues.push({
          file: relPath,
          type: "PYTHON_DUPLICATE_DEF",
          description:
            `File "${relPath}" defines these top-level names more than once: ${dupeList}\n\n` +
            `This usually happens when a patched version was appended without removing the original.\n` +
            `Python silently uses the LAST definition, so the earlier version is dead code.\n\n` +
            `FIX: Use patch_file to REPLACE the old definition with the new one — do not append a second copy.\n` +
            `Search the file for each duplicate name and delete all but the correct (final) version.`,
        });
      }
    }

    // 5bd. Python empty test file check — catches test files that define no test functions.
    //      pytest exits 0 and reports "collected 0 items" for such files, giving false
    //      confidence that the test suite ran correctly when it actually ran nothing.
    const isPyTestFile = /\.py$/i.test(ext) &&
      (/(?:^|[\\/])test_[^/\\]+\.py$/i.test(relPath) || /[^/\\]+_test\.py$/i.test(relPath) ||
       /[\\/](?:tests?|test_suite)[\\/]/i.test(relPath));
    if (isPyTestFile && !relPath.includes("/.venv/") && !relPath.includes("/site-packages/")) {
      // A test function must start with "def test_" (pytest convention).
      // Also accept class-based tests: methods starting with "def test_" inside a class.
      const hasTestFn = /^\s*def\s+test_/m.test(content);
      if (!hasTestFn) {
        allIssues.push({
          file: relPath,
          type: "PYTHON_EMPTY_TEST_FILE",
          description:
            `Test file "${relPath}" contains no test functions (no \`def test_*\` found).\n\n` +
            `pytest will report "collected 0 items" and exit 0 — the test suite appears to pass ` +
            `but is running NOTHING.\n\n` +
            `Common causes:\n` +
            `  - The test function was accidentally deleted or never written\n` +
            `  - Methods were named incorrectly (e.g. \`def check_foo\` instead of \`def test_foo\`)\n` +
            `  - Test class has no methods starting with \`test_\`\n\n` +
            `FIX: Add at least one test function matching \`def test_<name>(...):\` to this file.\n` +
            `Every test assertion must live inside a function that starts with "test_".`,
        });
      }
    }

    // 5c. Ruby syntax check — run `ruby -c` on modified .rb files.
    // Catches parse errors (unexpected end, unterminated string, syntax error)
    // before they surface at runtime as a SyntaxError from the Ruby interpreter.
    if (/\.rb$/i.test(ext) && !relPath.includes("/vendor/") && !relPath.includes("/gems/")) {
      const rubyResult = await execAsync(`ruby -c ${JSON.stringify(absPath)} 2>&1`);
      if (rubyResult.status !== 0) {
        const errText = (rubyResult.stdout || rubyResult.stderr || "").trim();
        // Only report when output contains actual Ruby error messages.
        // Skip if ruby is not installed ("command not found").
        if (!/command not found|No such file|not found/i.test(errText) && errText.length > 0) {
          allIssues.push({
            file: relPath,
            type: "RUBY_SYNTAX_ERROR",
            description:
              `Ruby syntax error detected by \`ruby -c\`:\n\n${errText}\n\n` +
              `Fix the syntax error(s) above using write_file or patch_file before this subtask can pass.\n` +
              `Common causes: missing "end" keyword, unclosed string/heredoc, mismatched do/end blocks.`,
          });
        }
      }
    }

    // 5cc. Ruby duplicate def check — catches "growing file" regression in .rb files.
    //      Happens when the coder appends a fixed method without removing the original.
    //      Ruby silently uses the LAST definition, so earlier versions become dead code.
    //      Only checks top-level (no indentation) methods to avoid false positives from
    //      same-named methods in different classes or modules.
    if (/\.rb$/i.test(ext) && !relPath.includes("/vendor/") && !relPath.includes("/gems/")) {
      const rbNames = [];
      // Match top-level instance methods: `def method_name`
      // and top-level class methods: `def self.method_name`
      const rbDefRe = /^def\s+(?:self\.)?([a-z_][a-zA-Z0-9_?!]*)/gm;
      let rm;
      while ((rm = rbDefRe.exec(content)) !== null) rbNames.push(rm[1]);
      const rbSeen = new Set();
      const rbDupes = new Set();
      for (const n of rbNames) {
        if (rbSeen.has(n)) rbDupes.add(n);
        else rbSeen.add(n);
      }
      if (rbDupes.size > 0) {
        const dupeList = [...rbDupes].join(", ");
        allIssues.push({
          file: relPath,
          type: "RUBY_DUPLICATE_DEF",
          description:
            `File "${relPath}" defines these top-level methods more than once: ${dupeList}\n\n` +
            `This usually happens when a patched version was appended without removing the original.\n` +
            `Ruby silently uses the LAST definition, so the earlier version is dead code.\n\n` +
            `FIX: Use patch_file to REPLACE the old method with the new one — do not append a second copy.\n` +
            `Search the file for each duplicate method name and delete all but the correct (final) version.`,
        });
      }
    }

    // 5cd. Ruby empty spec file check — catches RSpec files that define no examples.
    //      RSpec exits 0 with "0 examples, 0 failures" for spec files with no `it` blocks,
    //      giving false confidence that the test suite ran. Catches placeholder specs.
    const isRubySpecFile = /\.rb$/i.test(ext) &&
      (filename.endsWith("_spec.rb") || relPath.includes("/spec/"));
    if (isRubySpecFile && !relPath.includes("/vendor/") && !relPath.includes("/gems/")) {
      // RSpec example blocks: it, specify, example (plus xit/xspecify for pending)
      const hasExample = /^\s*(?:x?it|x?specify|x?example)\s*[(\s'"]/m.test(content);
      if (!hasExample) {
        allIssues.push({
          file: relPath,
          type: "RUBY_EMPTY_SPEC_FILE",
          description:
            `Spec file "${relPath}" contains no RSpec examples (no \`it\`, \`specify\`, or \`example\` blocks).\n\n` +
            `RSpec will report "0 examples, 0 failures" and exit 0 — the test suite appears to pass ` +
            `but is running NOTHING.\n\n` +
            `Common causes:\n` +
            `  - The \`it\` block was never written (only a \`describe\`/\`context\` shell exists)\n` +
            `  - Tests were named incorrectly (e.g. \`test\` instead of \`it\`)\n` +
            `  - File is a placeholder that was never completed\n\n` +
            `FIX: Add at least one \`it 'description' do ... end\` block inside a describe/context block.\n` +
            `Every RSpec assertion must live inside an \`it\` (or \`specify\`/\`example\`) block.`,
        });
      }
    }

    // 5d. Missing export check — PascalCase component files without any exports.
    //     PascalCase filenames (ChessBoard.tsx, GameStatus.tsx) are almost always
    //     React components. A file that defines no export can't be imported by App.tsx.
    //     Root cause: burned 742s in one session before check.js revealed the missing `export`.
    if (/\.(tsx?|jsx?)$/i.test(ext)) {
      const baseFilename = path.basename(filename, path.extname(filename));
      const isPascalCase = /^[A-Z][a-zA-Z0-9]*$/.test(baseFilename);
      const isTestFile = /\.(test|spec)\.[^.]+$/.test(filename);
      const isEntryFile = /^(index|main|app|vite\.config|tailwind\.config|jest\.config|eslint\.config)$/i.test(baseFilename);
      if (isPascalCase && !isTestFile && !isEntryFile && !/\bexport\b/.test(content)) {
        allIssues.push({
          file: relPath,
          type: "MISSING_EXPORT",
          description:
            `Component file "${relPath}" defines no exports.\n\n` +
            `PascalCase component files MUST export at least one symbol so they can be imported by App.tsx or parent components.\n\n` +
            `Add "export" before the definition:\n` +
            `  export function ${baseFilename}() { ... }\n` +
            `  // or\n` +
            `  export default function ${baseFilename}() { ... }\n\n` +
            `Without an export, this file is dead code — nothing can import it.`,
        });
      }
    }

    // 5d. Duplicate function/const definition check — catches "growing file" regression.
    //     Happens when the coder appends a fixed function without removing the original.
    //     Two definitions of the same function cause bundler errors or silent runtime bugs.
    if (/\.(m?js|cjs|jsx|tsx|ts)$/i.test(ext)) {
      // Match named function declarations and named arrow-function const assignments
      const funcNames = [];
      const funcDeclRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm;
      const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(?/gm;
      let m2;
      while ((m2 = funcDeclRe.exec(content)) !== null) funcNames.push(m2[1]);
      while ((m2 = arrowRe.exec(content)) !== null) funcNames.push(m2[1]);
      const seen = new Set();
      const dupes = new Set();
      for (const n of funcNames) {
        if (seen.has(n)) dupes.add(n);
        else seen.add(n);
      }
      if (dupes.size > 0) {
        const dupeList = [...dupes].join(", ");
        allIssues.push({
          file: relPath,
          type: "DUPLICATE_FUNCTION",
          description:
            `File "${relPath}" defines these names more than once: ${dupeList}\n\n` +
            `This usually happens when a patched version was appended without removing the original.\n` +
            `Having two definitions of the same function causes bundler errors or uses the wrong version silently.\n\n` +
            `FIX: Use patch_file to REPLACE the old definition with the new one — do not append a second copy.\n` +
            `Search the file for each duplicate name and delete all but the correct version.`,
        });
      }
    }

    // 6. TypeScript file in a non-TypeScript project — catches .ts/.tsx files
    //    written to a project with no tsconfig.json or package.json (vanilla HTML/JS).
    //    The browser cannot execute TypeScript directly; without a bundler it is dead code.
    if (/\.(ts|tsx)$/i.test(ext) && projectDir) {
      const hasTsConfig = await fs.access(path.join(projectDir, "tsconfig.json")).then(() => true).catch(() => false);
      const hasPkg = await fs.access(path.join(projectDir, "package.json")).then(() => true).catch(() => false);
      if (!hasTsConfig && !hasPkg) {
        allIssues.push({
          file: relPath,
          type: "TS_IN_VANILLA_PROJECT",
          description:
            `TypeScript file "${relPath}" written to a vanilla HTML/JS project — no tsconfig.json or package.json found.\n` +
            `Browsers cannot execute TypeScript directly. This file will never be loaded.\n` +
            `Use plain JavaScript (.js) instead: implement the logic directly in the existing .js file(s).`,
        });
      }
    }

    // 7. Cross-file HTML-JS ID consistency — catch getElementById("X") and
    //    querySelector('#X') calls where no HTML element has id="X".
    //    Loaded lazily so the HTML/.ss walk only runs once per patchReviewer pass.
    if (/\.(m?js|cjs|jsx|tsx|ts)$/i.test(ext)) {
      if (!globalThis.__patchReviewHtmlIds) {
        globalThis.__patchReviewHtmlIds = await collectHtmlIds(projectDir);
        // Also pull IDs from SilverStripe .ss templates which define most HTML structure
        await collectSsTemplateIds(projectDir, globalThis.__patchReviewHtmlIds);
      }
      const htmlIds = globalThis.__patchReviewHtmlIds;
      if (htmlIds.size > 0) {
        const idIssues = analyzeJsIdRefs(content, filename, htmlIds);
        for (const issue of idIssues) {
          allIssues.push({ file: relPath, ...issue });
        }
      }
    }

    // 8. Cross-file HTML-CSS ID consistency — catch #id selectors in CSS
    //    where no HTML element in the project has that id.
    if (/\.css$/i.test(ext)) {
      if (!globalThis.__patchReviewHtmlIds) {
        globalThis.__patchReviewHtmlIds = await collectHtmlIds(projectDir);
        await collectSsTemplateIds(projectDir, globalThis.__patchReviewHtmlIds);
      }
      const htmlIds = globalThis.__patchReviewHtmlIds;
      if (htmlIds.size > 0) {
        const cssIdIssues = analyzeCssIdRefs(content, filename, htmlIds);
        for (const issue of cssIdIssues) {
          allIssues.push({ file: relPath, ...issue });
        }
      }
    }

    // 8a. CSS/SCSS brace-balance check — catches unmatched { } pairs before visual
    //     verification. An unclosed rule silently drops all subsequent styles; the HTTP
    //     smoke test returns 200 but the page looks broken.
    if (/\.(css|scss|sass)$/i.test(ext)) {
      // Strip comments before counting (block comments may contain braces)
      const strippedCss = content
        .replace(/\/\*[\s\S]*?\*\//g, "")   // /* block comments */
        .replace(/\/\/[^\n]*/g, "");         // // line comments (SCSS/Sass)
      const opens  = (strippedCss.match(/\{/g) || []).length;
      const closes = (strippedCss.match(/\}/g) || []).length;
      if (opens !== closes) {
        const diff = opens - closes;
        allIssues.push({
          file: relPath,
          type: "CSS_BRACE_IMBALANCE",
          description:
            `CSS/SCSS brace imbalance in "${relPath}": ` +
            `${opens} opening { vs ${closes} closing } (${diff > 0 ? `${diff} unclosed` : `${-diff} extra`}).\n\n` +
            `An unmatched brace causes all subsequent rules to be silently ignored.\n` +
            `Common cause: missing closing } after the last rule block, or an extra } ` +
            `leftover from a deleted block.\n\n` +
            `FIX: Count blocks manually — every opening { for a rule, @media, @keyframes, or ` +
            `.selector must have a matching }. Run through the file top-to-bottom.`,
        });
      }
    }

    // 13. JSON syntax check — validate .json files with JSON.parse().
    //     Skip machine-generated lock files and .jsonl streaming files.
    if (
      ext === ".json" &&
      !filename.endsWith("-lock.json") &&
      !filename.endsWith(".lock.json") &&
      filename !== "package-lock.json" &&
      filename !== "yarn.lock" &&
      filename !== "pnpm-lock.yaml"
    ) {
      try {
        JSON.parse(content);
      } catch (jsonErr) {
        allIssues.push({
          file: relPath,
          type: "JSON_SYNTAX_ERROR",
          description:
            `JSON syntax error in "${relPath}":\n\n  ${jsonErr.message || "Parse failed"}\n\n` +
            `Common AI mistakes in JSON:\n` +
            `  - Trailing comma after last element: [1, 2, 3,] or {"a": 1,}\n` +
            `  - Missing comma between items: {"a": 1 "b": 2}\n` +
            `  - Unquoted keys: {name: "value"} → must be {"name": "value"}\n` +
            `  - JavaScript-style comments: // or /* */ (not valid in JSON)\n` +
            `  - Single-quoted strings: 'value' → must be "value"\n` +
            `Fix the JSON and re-run to verify.`,
        });
      }
    }

    // 12. YAML syntax check — parse with js-yaml to catch structural errors.
    //     Skip the SilverStripe-specific check (#2) scope; this is a general syntax gate.
    //     Exclude lock files and node_modules-adjacent YAML that tends to have edge cases.
    if (/\.(yml|yaml)$/i.test(ext) && !relPath.includes("node_modules") && !relPath.endsWith(".lock")) {
      try {
        yaml.load(content, { json: false });
      } catch (yamlErr) {
        const lineHint = yamlErr.mark ? ` (line ${yamlErr.mark.line + 1})` : "";
        allIssues.push({
          file: relPath,
          type: "YAML_SYNTAX_ERROR",
          description:
            `YAML syntax error in "${relPath}"${lineHint}:\n\n  ${yamlErr.message?.split("\n")[0] || yamlErr.reason || "Parse failed"}\n\n` +
            `Common causes:\n` +
            `  - Wrong indentation (YAML uses spaces, never tabs)\n` +
            `  - Missing space after colon: key:value → must be key: value\n` +
            `  - Unclosed string or multi-line block scalar\n` +
            `  - Duplicate key at the same nesting level\n` +
            `Fix the YAML structure, then verify by checking the indentation carefully.`,
        });
      }
    }

    // 10. Git conflict markers — unresolved <<<<<<< / ======= / >>>>>>> left in file
    const conflictMatch = content.match(/^(<{7}[^\n]*|={7}|>{7}[^\n]*)/m);
    if (conflictMatch) {
      const markerLine = content.slice(0, content.indexOf(conflictMatch[0])).split("\n").length;
      allIssues.push({
        file: relPath,
        type: "GIT_CONFLICT_MARKERS",
        description:
          `File "${relPath}" contains unresolved git conflict markers starting at line ${markerLine}:\n\n` +
          `  ${conflictMatch[0].slice(0, 80)}\n\n` +
          `These markers make the file unparseable. You MUST resolve the conflict by choosing one version:\n` +
          `  1. Use patch_file to delete the conflict markers AND one of the two conflicting blocks.\n` +
          `  2. Keep ONLY the lines between <<<<<<< HEAD ... ======= (your changes), OR\n` +
          `     keep ONLY the lines between ======= ... >>>>>>> (the incoming changes).\n` +
          `  3. Remove ALL three marker lines (<<<<<<< HEAD, =======, >>>>>>>).`,
      });
    }

    // 11. ESM / CommonJS module mismatch
    //     .mjs files are always ESM — require() is not available.
    //     .cjs files are always CommonJS — static import is not available.
    //     .js files in a "type":"module" package are ESM — require() will crash at runtime.
    if (/\.(mjs|cjs|js|jsx|ts|tsx)$/i.test(ext)) {
      const isMjs = ext === ".mjs";
      const isCjs = ext === ".cjs";

      if (isMjs) {
        // Detect bare require( calls (not inside comments or strings — best-effort)
        const reqMatch = content.match(/(?:^|[^/\w])require\s*\(/m);
        if (reqMatch) {
          const lineNo = content.slice(0, content.indexOf(reqMatch[0].trim().startsWith("r") ? reqMatch[0] : reqMatch[0].slice(1))).split("\n").length;
          allIssues.push({
            file: relPath,
            type: "CJS_IN_ESM_FILE",
            description:
              `File "${relPath}" has a .mjs extension (ESM module) but uses CommonJS \`require()\`.\n` +
              `\`require\` is NOT available in .mjs files — it will throw ReferenceError at runtime.\n` +
              `FIX: Replace \`require('...')\` with \`import ... from '...'\` (or use dynamic \`import('...')\` for conditional loads).`,
          });
        }
      } else if (isCjs) {
        // Static import syntax is invalid in .cjs files
        const importMatch = content.match(/^import\s+[\w*{]/m);
        if (importMatch) {
          allIssues.push({
            file: relPath,
            type: "ESM_IN_CJS_FILE",
            description:
              `File "${relPath}" has a .cjs extension (CommonJS module) but uses ESM \`import ... from\` syntax.\n` +
              `Static \`import\` is NOT valid in .cjs files — Node.js will throw a SyntaxError.\n` +
              `FIX: Replace \`import X from '...'\` with \`const X = require('...')\`.`,
          });
        }
      } else if (/\.(js|jsx)$/i.test(ext) && projectDir) {
        // For .js files check if the project declares "type":"module" in package.json
        if (!globalThis.__patchReviewPkgType) {
          try {
            const pkgRaw = await fs.readFile(path.join(projectDir, "package.json"), "utf8");
            globalThis.__patchReviewPkgType = JSON.parse(pkgRaw).type || "commonjs";
          } catch {
            globalThis.__patchReviewPkgType = "commonjs";
          }
        }
        if (globalThis.__patchReviewPkgType === "module") {
          const reqMatch = content.match(/(?:^|[^/\w])require\s*\(/m);
          if (reqMatch) {
            allIssues.push({
              file: relPath,
              type: "CJS_IN_ESM_PROJECT",
              description:
                `File "${relPath}" uses \`require()\` but this project has "type":"module" in package.json (ESM mode).\n` +
                `\`require\` is NOT available in ESM projects by default — it will throw ReferenceError at runtime.\n` +
                `FIX: Replace \`require('...')\` with \`import ... from '...'\` at the top of the file.\n` +
                `If CommonJS is genuinely needed, use \`import { createRequire } from 'module'; const require = createRequire(import.meta.url);\``,
            });
          }
        }
      }
    }

    // 15. Go test file naming check — catches test functions in files that won't be run.
    //     Go only treats files ending in _test.go as test files. A coder who writes
    //     func TestFoo(t *testing.T) in test_calculator.go or calculator_helpers.go
    //     will see `go test ./...` report "ok (cached)" with 0 tests — the tests are
    //     compiled as normal package code and silently never executed.
    if (/\.go$/i.test(ext) && !filename.endsWith("_test.go")) {
      const goTestFnRe = /^func\s+(Test[A-Z]\w*)\s*\(\s*t\s+\*testing\.T\s*\)/m;
      const goTestMatch = goTestFnRe.exec(content);
      if (goTestMatch) {
        const base = path.basename(filename, ".go");
        const suggestedName = base.replace(/^test_/, "") + "_test.go";
        allIssues.push({
          file: relPath,
          type: "GO_TEST_FILE_MISNAMED",
          description:
            `File "${relPath}" contains Go test functions (e.g. ${goTestMatch[1]}) but does NOT end in "_test.go".\n\n` +
            `Go only runs tests in files named "*_test.go". Any func Test… in this file is compiled ` +
            `as regular package code and will NEVER be executed by \`go test\`.\n\n` +
            `FIX: Rename the file to end with "_test.go", e.g. "${suggestedName}".\n` +
            `  - Use execute_bash("mv ${relPath} ${path.join(path.dirname(relPath), suggestedName)}")\n` +
            `  - The package declaration at the top should be "package <pkg>_test" (external test) ` +
            `or "package <pkg>" (internal test), matching your other test files.\n\n` +
            `After renaming, re-run: go test ./...`,
        });
      }
    }

    // 9. Implementation note deletion check
    if (deletionRequirements.length > 0) {
      for (const pattern of deletionRequirements) {
        // Escape the pattern for use as a simple string search
        const patternClean = pattern.replace(/[$\\.+*?^{}()|[\]]/g, (c) => `\\${c}`);
        try {
          const stillPresent = new RegExp(patternClean, "i").test(content);
          if (stillPresent) {
            allIssues.push({
              file: relPath,
              type: "DELETION_NOT_APPLIED",
              description:
                `The implementation plan required this content to be DELETED but it is still present in the file:\n` +
                `  Pattern: \`${pattern}\`\n` +
                `FIX: Use patch_file to remove this exact content from ${relPath}.`,
            });
          }
        } catch {
          // Regex compilation failed — skip this pattern
        }
      }
    }
  }

  // Cross-file Python import check — catches `from <localmodule> import <Name>`
  // where <localmodule>.py exists in the project but does not define <Name>.
  // py_compile accepts this (valid syntax); the failure only appears at import
  // time as ImportError (pytest exit 2). A raw traceback does not tell the coder
  // what the module DOES export — this check does, so the fix is unambiguous.
  const pyFilesForImportCheck = modifiedFiles.filter(
    (f) => /\.py$/i.test(f) && !f.includes("/.venv/") && !f.includes("/site-packages/"),
  );
  if (pyFilesForImportCheck.length > 0 && projectDir) {
    const moduleExportsCache = new Map();
    const getModuleExports = async (modName) => {
      if (moduleExportsCache.has(modName)) return moduleExportsCache.get(modName);
      const modPath = path.join(projectDir, modName.replace(/\./g, "/") + ".py");
      let exports = null;
      try {
        const src = await fs.readFile(modPath, "utf8");
        exports = new Set();
        for (const m of src.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) exports.add(m[1]);
        for (const m of src.matchAll(/^class\s+([A-Za-z_]\w*)/gm)) exports.add(m[1]);
        // top-level assignments: NAME = ...  /  NAME: type = ...
        for (const m of src.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=[^=]/gm)) exports.add(m[1]);
        // re-exports: from X import Y  (Y becomes importable from this module)
        for (const m of src.matchAll(/^from\s+\S+\s+import\s+(.+)$/gm)) {
          for (const part of m[1].split(",")) {
            const nm = part.trim().replace(/[()]/g, "").split(/\s+as\s+/).pop().trim();
            if (nm && nm !== "*") exports.add(nm);
          }
        }
        // import X / import X as Y
        for (const m of src.matchAll(/^import\s+(.+)$/gm)) {
          for (const part of m[1].split(",")) {
            const seg = part.trim();
            const nm = /\s+as\s+/.test(seg) ? seg.split(/\s+as\s+/).pop().trim() : seg.split(".")[0].trim();
            if (nm) exports.add(nm);
          }
        }
      } catch {
        exports = null; // not a local module (stdlib / third-party) — skip
      }
      moduleExportsCache.set(modName, exports);
      return exports;
    };

    for (const relPath of pyFilesForImportCheck) {
      const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
      let src;
      try { src = await fs.readFile(absPath, "utf8"); } catch { continue; }
      const importRe = /^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/gm;
      let im;
      while ((im = importRe.exec(src)) !== null) {
        const modName = im[1];
        const importClause = im[2].trim();
        if (importClause === "*" || importClause.startsWith("*")) continue;
        const exports = await getModuleExports(modName);
        if (!exports) continue; // not a local project module
        const names = importClause.replace(/[()]/g, "").split(",")
          .map((p) => p.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        const missing = names.filter((n) => !exports.has(n));
        if (missing.length > 0) {
          const avail = [...exports].slice(0, 25).join(", ");
          allIssues.push({
            file: relPath,
            type: "PYTHON_CROSS_FILE_IMPORT",
            description:
              `${path.basename(relPath)} does \`from ${modName} import ${missing.join(", ")}\`, ` +
              `but ${modName}.py does NOT define ${missing.length > 1 ? "those names" : "that name"}.\n` +
              `This passes py_compile (valid syntax) but fails at import time with ImportError — pytest reports exit 2.\n\n` +
              `${modName}.py currently exports: ${avail || "(nothing at top level)"}\n\n` +
              `FIX: either (a) add ${missing.join(", ")} to ${modName}.py, OR ` +
              `(b) change the import in ${path.basename(relPath)} to a name ${modName}.py actually exports. ` +
              `Pick ONE and apply it — do not just re-run the tests.`,
          });
        }
      }
    }
  }

  // Project-level Go build + vet checks — runs once if any .go files were modified.
  // go build catches compilation errors (undefined variables, type mismatches,
  // missing imports) that per-file heuristics can't detect.
  // go vet catches semantic issues in code that compiles: wrong Printf format strings,
  // unreachable code after return, mutex copying, and other common mistakes.
  const hasGoFiles = modifiedFiles.some((f) => /\.go$/i.test(f));
  if (hasGoFiles && projectDir) {
    try {
      await fs.access(path.join(projectDir, "go.mod"));
      const goResult = await execAsync("go build ./... 2>&1", { cwd: projectDir, timeout: 60000 });
      const goOut = (goResult.stdout || goResult.stderr || "").trim();
      if (/command not found|No such file/i.test(goOut)) {
        // go not installed — skip silently
      } else if (goResult.status !== 0 && goOut.length > 0) {
        allIssues.push({
          file: "(project)",
          type: "GO_BUILD_ERROR",
          description:
            `Go build failed:\n\n${goOut}\n\n` +
            `Common causes:\n` +
            `  - Undefined variable or function (check spelling and imports)\n` +
            `  - Type mismatch (check function signatures match usage)\n` +
            `  - Missing import path (run go mod tidy if a package is unknown)\n` +
            `  - Undeclared name — ensure the symbol is exported from its package\n\n` +
            `Fix all build errors above before this subtask can pass.`,
        });
      } else if (goResult.status === 0) {
        // Build succeeded — also run go vet to catch semantic issues
        const vetResult = await execAsync("go vet ./... 2>&1", { cwd: projectDir, timeout: 30000 });
        const vetOut = (vetResult.stdout || vetResult.stderr || "").trim();
        if (!/command not found|No such file/i.test(vetOut) && vetResult.status !== 0 && vetOut.length > 0) {
          allIssues.push({
            file: "(project)",
            type: "GO_VET_ERROR",
            description:
              `go vet found issues that will cause runtime bugs:\n\n${vetOut}\n\n` +
              `Common causes:\n` +
              `  - Wrong Printf/Sprintf format verb (e.g. %d for a string → "bad verb")\n` +
              `  - Mutex or sync.WaitGroup copied by value (pass pointer instead)\n` +
              `  - Unreachable code after return/break/continue\n` +
              `  - Incorrect error interface implementation\n\n` +
              `Fix all vet errors above — they compile but cause incorrect behaviour at runtime.`,
          });
        }
      }
    } catch {
      // go.mod not found or access error — skip Go check
    }
  }

  if (allIssues.length === 0) {
    log(colors.dim("  [PatchReview] ✓ All checks passed"));
    return {
      patchReviewFeedback: "OK",
      currentPersona: PERSONA.id,
    };
  }

  // Issues found — format feedback for the coder
  const issueList = allIssues
    .map((issue, i) =>
      `Issue ${i + 1} in ${issue.file} [${issue.type}]:\n${issue.description}`,
    )
    .join("\n\n---\n\n");

  const newRetryCount = coderRetries + 1;
  const newPatchRetries = patchRetries + 1;

  log(colors.red(
    `  [PatchReview] ✗ ${allIssues.length} issue(s) found — sending back to coder (patch retry ${newPatchRetries}/${MAX_PATCH_REVIEW_RETRIES})`,
  ));
  eventBus.emit("system_message", {
    text: `✗ Patch review: ${allIssues.length} implementation issue(s) detected — coder must fix before verifying`,
    type: "warning",
  });

  const atCap = newRetryCount >= MAX_VERIFIER_RETRIES;
  const capWarning = atCap
    ? `\n\n⚠️ FINAL ATTEMPT (${newRetryCount}/${MAX_VERIFIER_RETRIES}): If these issues are not fixed, this subtask will be force-skipped.`
    : "";

  return {
    patchReviewFeedback: "FAIL",
    patchReviewRetryCount: newPatchRetries,
    coderRetryCount: newRetryCount,
    currentPersona: PERSONA.id,
    messages: [
      {
        role: "user",
        content: `[PATCH REVIEWER AUTOMATED FEEDBACK]

Your implementation has ${allIssues.length} issue(s) that must be fixed BEFORE this subtask can pass verification.

${issueList}

Fix ALL of the above issues using patch_file or write_file. Then re-run any verification commands.
Do NOT declare success until these issues are resolved.${capWarning}`,
      },
    ],
  };
}
