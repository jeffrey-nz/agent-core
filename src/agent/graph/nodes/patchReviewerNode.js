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
 *      If the subtask's implementation_note says "DELETE", "REMOVE", or "must be deleted"
 *      for a specific line, reads the target file and checks if that pattern still exists.
 *      → If the old pattern is still present: FAIL with exact line reference
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

  // Clear per-subtask HTML ID cache so a fresh HTML scan happens each time
  globalThis.__patchReviewHtmlIds = null;

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
    const tripleDotPlaceholder = /^\s*\.\.\.(full content|existing content|existing code|rest of file|rest of code|previous content|original code)\.\.\.\s*$/im;
    if (stubCommentPattern.test(content) || stubCssPattern.test(content) || tripleDotPlaceholder.test(content)) {
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

    // 7. Cross-file HTML-JS ID consistency — catch getElementById("X") calls
    //    where no HTML element in the project has id="X".
    //    Loaded lazily so the HTML walk only runs once per patchReviewer pass.
    if (/\.(m?js|cjs|jsx|tsx|ts)$/i.test(ext)) {
      if (!globalThis.__patchReviewHtmlIds) {
        globalThis.__patchReviewHtmlIds = await collectHtmlIds(projectDir);
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
      }
      const htmlIds = globalThis.__patchReviewHtmlIds;
      if (htmlIds.size > 0) {
        const cssIdIssues = analyzeCssIdRefs(content, filename, htmlIds);
        for (const issue of cssIdIssues) {
          allIssues.push({ file: relPath, ...issue });
        }
      }
    }

    // 6. Implementation note deletion check
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
