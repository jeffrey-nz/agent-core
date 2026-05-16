import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import fs from "node:fs/promises";
import path from "node:path";
import { detectProjectContext } from "#utils/detectProjectContext.js";
import { buildTddDirective } from "#utils/projectDirectives.js";
import { renderMemoryIndex } from "#memory/loader.js";
import { setDashboardState } from "#app/ui/dashboard.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";
import { updateCheckpointState } from "../checkpointBridge.js";

const PERSONA = personaMeta("projectManager");

// Pre-escape composer/npm package-version patterns that AIs embed unescaped inside JSON strings.
// Pattern: "vendor/package": "constraint" — the slash in the package name distinguishes these
// from legitimate JSON object keys (which never contain slashes in planner output).
// Must run BEFORE sanitizeJsonStrings so the resulting \" sequences are not re-closed.
function preEscapePackageVersionPatterns(text) {
  // Matches "vendor/pkg": "constraint" — captures standard composer/npm package references.
  // The [^"{}[\]\n]* value pattern avoids crossing string or structural boundaries.
  return text.replace(
    /"([@a-zA-Z][\w.-]*\/[\w][\w.-]*)"\s*:\s*"([^"{}[\]\n]*)"/g,
    '\\"$1\\": \\"$2\\"',
  );
}

// Escape double-quotes inside single-quoted code regions (PHP/YAML snippets embedded in notes).
// Handles patterns like: 'SomeClass::create("o", "Link", $this)' and 'VAR="value"'
// Uses a negative lookbehind for word characters to skip English contractions (Don't, it's).
// A contraction apostrophe is always preceded by a letter; a code-region delimiter is not.
function preEscapeQuotesInSingleQuotedCodeRegions(text) {
  return text.replace(/(?<![a-zA-Z])'([^']*)'(?![a-zA-Z])/g, (match, inner) => {
    if (!inner.includes('"')) return match;
    return "'" + inner.replace(/"/g, '\\"') + "'";
  });
}

// Repair unescaped double-quote characters inside JSON string values.
// Heuristic: a `"` is treated as an inner (unescaped) quote unless the next
// non-whitespace character is a JSON structural token (`,` `}` `]` `:`).
// Also escapes raw control chars (LF, CR, TAB) found inside strings.
//
// Key-position tracking: `:` only closes a string when the string is a JSON key
// (i.e. after `{` or `,`). Inside a value string (after `:`), a `"` followed by `:`
// is embedded content — e.g. '"silverstripe/asset-admin": "^3"' inside an
// implementation_note. Without this distinction the repair function prematurely
// closes value strings and produces un-parseable JSON.
function repairUnescapedQuotesInJson(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let nextStringIsKey = false; // true after { or , (key expected); false after : (value expected)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === "\\") { result += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) { inString = true; result += ch; continue; }
      let j = i + 1;
      while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
      const next = j < text.length ? text[j] : "";
      // `:` closes a string only when we're in key position (not inside a value string).
      if (next === "" || next === "," || next === "}" || next === "]" || (next === ":" && nextStringIsKey)) {
        inString = false; result += ch;
      } else {
        result += '\\"';
      }
      continue;
    }
    if (!inString) {
      if (ch === "{" || ch === ",") nextStringIsKey = true;
      else if (ch === ":" || ch === "[") nextStringIsKey = false;
    }
    if (inString) {
      if (code === 0x0a) { result += "\\n"; continue; }
      if (code === 0x0d) { result += "\\r"; continue; }
      if (code === 0x09) { result += "\\t"; continue; }
    }
    result += ch;
  }
  return result;
}

// Walk a JSON string character-by-character and replace literal control characters
// (0x00–0x1F) found inside string values with their proper JSON escape sequences.
// Sanitizes raw AI output before JSON.parse. Handles three classes of invalid input
// that AIs commonly produce inside JSON string values:
//   1. Bare control chars (literal newlines, tabs, etc.) — not allowed unescaped
//   2. Invalid escape sequences (\p, \C, \x, \uNON-HEX, etc.) — backslash must be doubled
//   3. \uXXXX with non-hex digits — the whole sequence would fail as invalid unicode
// Replaces both the old regex + escapeControlCharsInJsonStrings two-step approach,
// which had a correctness bug: the regex doubled backslashes but the escape function
// then treated any \<ch> as "already escaped" and un-doubled them, leaving \P in the
// output that JSON.parse still rejected.
const VALID_SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
function sanitizeJsonStrings(str) {
  let out = "";
  let inStr = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch; i++; continue;
    }
    if (ch === '"') { inStr = false; out += ch; i++; continue; }
    if (ch === '\\') {
      const next = str[i + 1];
      if (next === undefined) { out += '\\\\'; i++; continue; }
      if (VALID_SIMPLE_ESCAPES.has(next)) { out += ch + next; i += 2; continue; }
      if (next === 'u') {
        const hex = str.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += str.slice(i, i + 6); i += 6; }
        else { out += '\\\\'; i++; }
        continue;
      }
      // Invalid escape char — double the backslash so \P becomes \\P in JSON
      out += '\\\\'; i++; continue;
    }
    const code = str.charCodeAt(i);
    if (code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ── Plan Atomicity Consolidation ──────────────────────────────────────────────
// Detects plans where a logically-atomic operation has been split across multiple
// subtasks. Splits cause the patch validator to roll back the first subtask (because
// the intermediate state is a compile error) before the second can fix it.
//
// Currently handles:
//   • @Observable migration — ViewModel + ALL consuming views MUST be in one subtask
//
// When a split is detected, the affected subtasks are MERGED into a single subtask
// with a combined file list and an ATOMIC MIGRATION implementation note.
function consolidateAtomicSubtasks(subtasks, projectType) {
  // ── React/TypeScript: App.tsx wiring consolidation ──────────────────────────
  // When a hook's return signature changes (new exports added) AND a separate
  // subtask wires those exports in App.tsx, the intermediate state (new hook,
  // old App.tsx) is a TypeScript compile error. tsc --noEmit fires on the first
  // subtask before the wiring subtask can fix it, causing an infinite rollback loop.
  // Detect by finding one subtask that creates/modifies a hook AND another that
  // wires it in App.tsx, and merge them.
  if (projectType === "react" || projectType === "node" || projectType === "unknown") {
    const APP_TSX_RE = /\bApp\.(tsx?|jsx?)\b/;
    const HOOK_RE = /\b(?:use[A-Z]\w+)\.(tsx?|ts)\b|\/hooks\//;

    // Find subtasks that touch a custom hook file
    const hookSubtaskIndices = subtasks.reduce((acc, s, i) => {
      const files = (s.files || []).join(" ");
      const text = `${s.task} ${files}`;
      if (HOOK_RE.test(text) && !APP_TSX_RE.test(files)) acc.push(i);
      return acc;
    }, []);

    // Find subtasks that only touch App.tsx (wiring step)
    const appWiringIndices = subtasks.reduce((acc, s, i) => {
      const files = (s.files || []).join(" ");
      const text = `${s.task} ${files}`;
      if (APP_TSX_RE.test(text) && !HOOK_RE.test(text)) acc.push(i);
      return acc;
    }, []);

    // Only consolidate if there's exactly one hook subtask immediately followed by
    // one App.tsx wiring subtask (the classic "write hook → wire in App" split).
    if (hookSubtaskIndices.length === 1 && appWiringIndices.length === 1) {
      const hookIdx = hookSubtaskIndices[0];
      const appIdx = appWiringIndices[0];
      // Must be adjacent (hookIdx + 1 === appIdx) to be worth consolidating
      if (appIdx === hookIdx + 1) {
        const hookSub = subtasks[hookIdx];
        const appSub = subtasks[appIdx];
        const allFiles = [...new Set([...(hookSub.files || []), ...(appSub.files || [])])];
        const combinedNote =
          `⚠️ ATOMIC HOOK+WIRING — write hook changes AND App.tsx wiring in ONE pass.\n` +
          `tsc --noEmit runs after EVERY subtask; if the hook's return signature changes but App.tsx still uses the old shape, the TypeScript check fails and rolls back the hook before wiring can happen.\n\n` +
          `--- Hook subtask ---\n${hookSub.implementationNote || hookSub.task}\n\n` +
          `--- App.tsx wiring ---\n${appSub.implementationNote || appSub.task}`;

        log(colors.yellow(
          `  [Graph] -> Project Manager: detected hook+App.tsx wiring split (subtasks ${hookIdx + 1} and ${appIdx + 1}) — consolidating into one atomic subtask.`,
        ));

        const merged = {
          id: hookSub.id,
          task: `[ATOMIC] ${hookSub.task} and wire in App.tsx`,
          files: allFiles,
          lineRange: [hookSub.lineRange, appSub.lineRange].filter(Boolean).join("; "),
          implementationNote: combinedNote,
          constraints: [hookSub.constraints, appSub.constraints].filter(Boolean).join("; "),
          acceptanceCriteria: appSub.acceptanceCriteria || hookSub.acceptanceCriteria || "",
          failureCriteria: "",
        };

        const result = subtasks.filter((_, i) => i !== hookIdx && i !== appIdx);
        result.splice(hookIdx, 0, merged);
        subtasks = result.map((s, i) => ({ ...s, id: i + 1 }));
      }
    }
  }

  if (projectType !== "swift") return subtasks;

  // Regex identifying subtasks related to @Observable or ObservableObject migration
  const MIGRATION_RE = /@[Oo]bservable|[Oo]bservable[Oo]bject|@[Ss]tate[Oo]bject|@[Oo]bserved[Oo]bject|@[Bb]indable/;

  const migrationIndices = subtasks.reduce((acc, s, i) => {
    const text = `${s.task} ${s.implementationNote || ""} ${s.constraints || ""}`;
    if (MIGRATION_RE.test(text)) acc.push(i);
    return acc;
  }, []);

  // No split to fix — 0 or 1 migration subtask is fine
  if (migrationIndices.length <= 1) return subtasks;

  // Check whether the migration subtasks actually span different files
  const migSubs = migrationIndices.map((i) => subtasks[i]);
  const fileSetPerSub = migSubs.map((s) => new Set(s.files || []));
  const allSameFiles = fileSetPerSub.every((fs) => {
    for (const f of fs) { if (!fileSetPerSub[0].has(f)) return false; }
    return fs.size === fileSetPerSub[0].size;
  });
  if (allSameFiles) return subtasks; // All files already in one subtask

  log(colors.yellow(
    `  [Graph] -> Project Manager: detected @Observable migration split across ${migrationIndices.length} subtasks — consolidating into one atomic subtask.`,
  ));

  const allFiles = [...new Set(migSubs.flatMap((s) => s.files || []))];
  const allLineRanges = migSubs.map((s) => s.lineRange).filter(Boolean).join("; ");

  const combinedNote =
    `⚠️ ATOMIC @Observable MIGRATION — ALL CHANGES IN ONE WRITE_FILE ARRAY\n` +
    `The patch validator runs swiftc -typecheck after every individual tool call. ` +
    `Migrating the ViewModel first and views later produces an intermediate state ` +
    `that is a compile error — the validator rolls back the ViewModel change before ` +
    `the view updates can run. You MUST write all files in a single JSON tool call array.\n\n` +
    migSubs
      .map((s) => `--- ${s.task} ---\n${s.implementationNote || "(see scope document)"}`)
      .join("\n\n");

  const merged = {
    id: migSubs[0].id,
    task: `[ATOMIC] ${migSubs[0].task} (migrate all consuming views in same pass)`,
    files: allFiles,
    lineRange: allLineRanges,
    implementationNote: combinedNote,
    constraints: migSubs.map((s) => s.constraints).filter(Boolean).join("; "),
    acceptanceCriteria: migSubs.find((s) => s.acceptanceCriteria)?.acceptanceCriteria || "",
    failureCriteria: "",
  };

  // Rebuild subtask list: remove all migration subtasks, insert merged at first position
  const result = subtasks.filter((_, i) => !migrationIndices.includes(i));
  result.splice(migrationIndices[0], 0, merged);

  // Re-assign sequential IDs
  return result.map((s, i) => ({ ...s, id: i + 1 }));
}

export async function projectManagerNode(state, config) {
  log(colors.yellow("  [Graph] -> Running Project Manager Agent..."));

  eventBus.emit("persona_change", { ...PERSONA, description: "Breaking work into subtasks and planning execution order" });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Planning..." });

  const projectConstraints =
    state.projectConstraints ||
    detectProjectContext(state.projectDir).constraints;
  const tddSection = buildTddDirective(state.projectType);

  // Summarise which subtasks are already done (on re-runs after subtask advances).
  const completedSubtasks = (state.subtasks || []).slice(0, state.currentSubtaskIndex || 0);
  const progressNote =
    completedSubtasks.length > 0
      ? `\n[PROGRESS UPDATE - subtasks already completed]\n${completedSubtasks
          .map((s) => `  ✓ ${s.id}: ${s.task}`)
          .join("\n")}\nDo NOT re-create these subtasks. Generate only the remaining work.\n`
      : "";

  // Memory bank — surface the user's durable preferences and project facts
  // so the planner doesn't propose work that conflicts with them.
  // Only the index is rendered here (no bodies) to keep PM prompts small.
  let memoryIndexSection = "";
  try {
    const idx = await renderMemoryIndex({ projectDir: state.projectDir });
    if (idx) memoryIndexSection = `\n${idx}\n`;
  } catch {}

  let systemPrompt = `You are a Lead Project Manager and Engineering Planner.
${tddSection}
${memoryIndexSection}
${projectConstraints}

You have been given:
1. The original user task
2. A Research Report from the Researcher (overview of the codebase)
3. A Scope Document from the Scoper (verified file paths, exact line numbers, dependencies)

The Scope Document is the authoritative source. Use it to produce a precise, grounded execution plan.

${progressNote}

OUTPUT FORMAT:
You MUST output a JSON object with a "plan" string and a "subtasks" array.
Each subtask MUST include:
- "id": sequential integer
- "task": ONE-LINE action verb + object (e.g. "Add rememberMe parameter to AuthService.login() in src/auth/AuthService.ts lines 45-72")
- "files": array of exact file paths (relative to project root) verified in the Scope Document
- "line_range": the specific line range(s) to modify, as a string (e.g. "45-72" or "45-72, 110-115"). Use "new file" if creating.
- "implementation_note": a VERBATIM QUOTE or paraphrase from the Scope Document describing exactly what needs to change at those lines - current state and desired state. Must be concrete enough for the coder to write the change without reading any other file.
- "constraints": method signatures, class names, import paths, migration notes from scope

CRITICAL RULES:
- File paths SHOULD come from the Scope Document. If the Scope Document lacks specific paths, use the PROJECT FILES list (provided at the end of the scope message) or the Research Report to infer reasonable file paths — never refuse to plan just because file paths are missing from the scope
- Every subtask must specify exact file(s) in both "task" and "files"
- "implementation_note" is MANDATORY - a coder reading only this note must know exactly what to write
- Subtasks must result in concrete file changes only; keep them small and isolated

NEW PROJECT SCAFFOLD ORDERING (CRITICAL for Node.js/React/Vite projects):
If the task creates a new project from scratch, the FIRST subtask MUST write both .gitignore and README.md (they belong in the same scaffold subtask with package.json). The .gitignore MUST list node_modules/, dist/, .env, *.log, .DS_Store, coverage/, .vite/. The README.md MUST include: project name, one-line description, and commands: npm install, npm run dev, npm run build, npm test. NEVER add fake entries (keys starting with "#") to package.json dependencies — the verifier will reject them.

CSS FILE CONSOLIDATION (CRITICAL for React/Vue/Vite projects — prevents stylesheet proliferation):
- ONE CSS file per component. The Vite scaffold creates src/App.css. ALL component styles for a small/medium app go in src/App.css — do NOT plan separate Chess.css, ChessGame.css, ChessBoard.css, Pieces.css subtasks.
- NEVER plan multiple CSS-creation subtasks for the same component. If two subtasks would each touch styles, merge them so one subtask owns all styles for that component.
- When a subtask modifies a component's JSX and styles, name the existing CSS file (App.css) in the "files" list — not a new filename. Multiple css files for one app = dead code (orphaned files not imported by any JSX).
- Exception: a project with 5+ distinct screens may have one CSS per screen, all imported individually. Default for games/calculators/single-page apps: ONE CSS file (App.css).

BYTE-SIZED SUBTASK RULES (CRITICAL — enforced by the pipeline):
- Each implementation subtask MUST touch at most 3 files. If a change requires more, split it into multiple subtasks.
- Prefer 6–12 subtasks for a medium feature. More subtasks = better visibility, easier resume, less hallucination.
- For new_project tasks: maximum 7 subtasks total (consolidate related work into fewer, larger subtasks). Grouping related concerns — e.g. all game logic in one subtask, all UI components in one subtask — is preferred over creating a separate subtask for each file.
- Each subtask should be completable in one AI response. If a subtask would require writing more than 5 files, either split it into two focused subtasks or merge it with a closely related subtask so the combined scope stays under 5 files.
- NEVER write subtasks like "Implement the entire X module", "Refactor all Y files", or "Update everything in Z". These always exceed 3 files and stall the session.
- Each subtask description must fit in one sentence (≤ 20 words). If you need more words, split the subtask.
- A subtask that touches a model file and its view file is fine (2 files). Adding the controller too is the maximum (3 files). Adding tests is a fourth subtask.
- Split large refactors by logical unit: one subtask per class/component/screen. Never batch-rename across more than 3 files.
- For "update all X to use Y"-style tasks: list each affected file explicitly and create one subtask per 1–3 files.
- If the Scope Document lists an implementation order, respect it
- IMPLEMENTATION-BEFORE-TEST ORDERING (CRITICAL — prevents "Cannot find module" failures): If any subtask writes a test file that imports from a new source module that does not yet exist (e.g. \`import { add } from './calc'\` where calc.js is being created as part of this plan), the subtask that CREATES the source module MUST appear BEFORE the test subtask in the plan. NEVER place a test file creation subtask before the source file it imports — the test will always fail with "Cannot find module" and trigger an infinite retry loop. Rule: scan each test file subtask's implementationNote for import statements; if the imported path is a new file being created in this plan, ensure its creation subtask has a lower id.
- JSON ESCAPING (CRITICAL — failure causes the entire plan to be rejected and retried): Any double-quote character INSIDE a string value MUST be escaped as \". This ESPECIALLY applies to code examples in implementation_note that contain string literals. WRONG: "implementation_note": "Call emit("phase_change", {label: "Searching..."})". RIGHT: "implementation_note": "Call emit('phase_change', {label: 'Searching...'})". RULE: In implementation_note code examples, replace all double-quote characters in the code with single quotes (JS, PHP, Python all support single-quoted strings). For JSON content that must use double quotes, escape as \\". Output ONLY raw JSON — no markdown fences, no prose before the opening {.

TEMPLATE FILE CHANGES — REMOVE vs APPEND (CRITICAL — prevents dual-rendering bugs):
When a subtask modifies a template file (.ss, .html, .erb, .twig, etc.), implementation_note MUST specify BOTH:
  1. The EXACT lines/content to DELETE (old conflicting code that must be removed)
  2. The EXACT lines/content to INSERT (new code to add in its place)
Simply saying "add a conditional block" is insufficient — the coder will APPEND the new block without removing the old one, causing both old and new content to render simultaneously.
Examples of WRONG implementation_note: "Add conditional Elemental rendering"
Examples of CORRECT implementation_note: "DELETE line 8 [$Content unconditional]. REPLACE with the conditional block: [<% if $ElementalArea && $ElementalArea.Elements.Count %> ... <% else_if $Content %> ... <% end_if %>]. The unconditional $Content MUST be deleted — leaving it means both Content and Elemental render on the same page."
If the Scope Document does NOT identify which specific old lines to remove: generate a REVIEW subtask FIRST to read the template and identify the conflicting lines, before the implementation subtask.

REVIEW SUBTASKS: If the scope document includes a read-only verification step (e.g. "confirm X does not exist", "verify that Y is clean", "ensure no item-type branching"):
- Set "files": [] - no files to write
- Prefix the task string with "REVIEW: " (e.g. "REVIEW: Verify TileItem.ss contains no item-type conditional logic")
- In "implementation_note" write: "READ-ONLY - use read_file on [filename] and quote the specific lines that confirm or deny the requirement. Do not write any new file."

EXECUTION-ONLY SUBTASKS — when a subtask requires running a command and NO file changes:
- Set "files": [] — no files to write or modify
- Do NOT prefix with "ACCEPTANCE TEST:" or "REVIEW:" — use a plain task name (e.g. "Run database schema build with flush to apply Elemental relation")
- Set "implementation_note": "EXECUTE COMMAND ONLY — no file changes. Run: [exact command]."
- The verifier passes these automatically when the coder calls the right execution tool (run_sake, execute_bash, run_composer)
- Use this for: db:build, sake dev/build, composer install, npm install, cache flush, schema migrations

CMS FIELD VISIBILITY ACCEPTANCE TESTS (SilverStripe — CRITICAL — read before generating any ACCEPTANCE TEST for a getCMSFields/Elemental task):
When the task concerns making fields visible in the SilverStripe CMS admin (getCMSFields, removeByName, Elemental area in the page editor, Tab layout, etc.):
- The CMS /admin REQUIRES AUTHENTICATION — an unauthenticated http_request returns a login redirect (HTTP 302 or a login-page HTML), NOT the CMS edit screen. You CANNOT verify CMS field visibility via http_request.
- NEVER generate "ACCEPTANCE TEST: Verify CMS Page edit shows..." with http_request as the verification method. The test will ALWAYS fail because /admin redirects unauthenticated requests.
- Generate a STRUCTURAL acceptance test instead. Set:
  - "files": [] (read-only — no writes)
  - "implementation_note": "STRUCTURAL CHECK — no http_request. Run these checks: (1) execute_bash: grep -rn \"removeByName\" app/src/ — must return no matches for 'Content', 'ElementalArea', 'ElementalAreaID'. (2) read_file app/_config/extensions.yml (or the relevant config file) — confirm ElementalPageExtension is attached. (3) run_sake: db:build --flush — must exit 0 with no errors."
  - "acceptanceCriteria": "grep returns no matches for removeByName('Content') and removeByName('ElementalArea'). Extensions YAML contains DNADesign\\Elemental\\Extensions\\ElementalPageExtension unquoted. db:build --flush exits 0 with no errors."
  - "failureCriteria": "grep finds removeByName('Content') or removeByName('ElementalArea') still present. OR db:build reports an extension class error. OR extensions YAML is missing or uses wrong class name."

ACCEPTANCE TEST SUBTASKS: When the researcher's report includes a FEATURE GAP ANALYSIS with any ❌ MISSING component, you MUST include an ACCEPTANCE TEST as the final subtask:
- Prefix the task string with "ACCEPTANCE TEST: " (e.g. "ACCEPTANCE TEST: Verify elemental blocks render on the About page")
- Set "files": [] - no files to write
- Set "implementation_note": the URL to fetch (e.g. "Use http_request(url='http://localhost/about-us')")
- Set "acceptanceCriteria": exact HTML/content that proves the feature is live (e.g. "Response HTML contains class=\"elemental-area\" with at least one data-block-type attribute")
- Set "failureCriteria": what indicates the feature is broken (e.g. "PHP error page, or elemental-area absent from HTML")
- This subtask MUST come last — after all implementation and RUN COMMAND subtasks
- Without this subtask the pipeline has no mechanism to verify the feature works and will declare success based on db:build alone.
- FORBIDDEN URLs in implementation_note: never set the URL to /admin, /admin/pages, /admin/pages/edit, or any CMS admin path — these require authentication and the test will always fail. Use frontend page URLs only.

ACCEPTANCE TEST SEMANTIC CRITERIA (CRITICAL — prevents false positives from HTTP 200 alone):
- HTTP 200 is NOT acceptance — you must check for the specific feature markup in the HTML response body
- For SilverStripe Elemental template changes: acceptanceCriteria MUST verify BOTH presence AND absence:
  * PRESENCE: "Response HTML contains 'elemental-area' class AND at least one element rendered inside it"
  * ABSENCE: "Response HTML does NOT contain the old unconditional $Content output alongside elemental markup (no dual-rendering)"
  * Example full criteria: "HTML body contains class='elemental-area' with child elements (data-block-type attribute present). If both $Content AND elemental-area appear in the output, the template still has dual rendering and the test must FAIL."
- For any feature toggle (show/hide, conditional rendering): acceptanceCriteria must check for BOTH what should appear AND what should NOT appear
- The coder must explicitly quote the relevant HTML from the response to prove the criteria are met

ACCEPTANCE TEST AUTOMATION RULES (CRITICAL — violations cause infinite retry loops):
- Tests MUST be verifiable with available tools only: http_request, execute_bash, read_file, run_sake.
- NEVER require human CMS UI interaction (creating pages, editing content, adding blocks, publishing in the CMS editor). The coder has no browser — it cannot click buttons or fill forms in the CMS.
- For "does the page render without errors?": use http_request({url: BASE_URL + "/?flush=1"}) and check for HTTP 200 + no PHP/SS error in the body.
- For "does a feature exist after db:build?": use http_request to fetch the rendered page HTML and check that expected markup or class names are present, OR use read_file/execute_bash to verify the required PHP/YAML/template files contain the expected code.
- For "does a command run clean?": use run_sake or execute_bash and check exit code + output.
- If end-to-end proof absolutely requires a human (e.g. a CMS UI flow), replace with a structural check: verify required PHP/YAML/template components exist AND db:build/sake dev/build exits 0 with no errors.
- NODE.JS / TYPESCRIPT PROJECT ACCEPTANCE TESTS (CRITICAL — prevents 120-second bash hangs):
  * NEVER generate an acceptance test that starts the server (node launcher.js) and then curls an HTTP endpoint. Starting a server in the background during testing is fragile: the port may be wrong, the server may not be ready, and a curl with no --max-time hangs the bash executor for 120+ seconds before being force-killed.
  * For Node.js/TypeScript projects, the ONLY acceptable acceptance test methods are:
    1. execute_bash("npm test") or execute_bash("node --no-warnings --test") — runs the test suite
    2. execute_bash("node --check <file>") — syntax validation
    3. grep/read_file checks — structural verification that required exports/functions exist
  * If the task requires a running server to verify (e.g. HTTP routes), the acceptance test must use the ALREADY-RUNNING server (if the project documents a health endpoint in its README or config), never start a new one.
- If http_request returns HTTP 500 with a filesystem permission error ("file_put_contents(...): Permission denied", "Unable to write file", "League\\Flysystem\\UnableToWriteFile"), FIX the permissions with execute_bash (chown/chmod on the assets directory) and then retry the http_request. Report "ACCEPTANCE TEST FAILED" only AFTER attempting the permission fix. The fix command is: execute_bash("sudo chown -R www-data:www-data {projectDir}/public/assets && sudo chmod -R 775 {projectDir}/public/assets").
- GODOT / UNITY / NATIVE GAME ENGINE ACCEPTANCE TESTS (CRITICAL — Godot has no HTTP server):
  * NEVER use http_request for Godot project acceptance tests — there is no web server to ping.
  * The ONLY acceptable acceptance test for Godot is execute_bash running the Godot binary headlessly:
    1. Syntax check: execute_bash('GODOT_BIN="..."; "$GODOT_BIN" --headless --path "C:/..." --check-only --quit 2>&1') — exit 0 means no GDScript parse errors
    2. Unit tests: execute_bash('GODOT_BIN="..."; "$GODOT_BIN" --headless --path "C:/..." --scene tests/Test.tscn --quit 2>&1') — must exit 0 and print "All tests passed"
    3. Playthrough tests: same as above with tests/Playthrough.tscn
  * The acceptance test subtask "files" MUST be [] (no writes — verification only).
  * Godot paths passed to --path MUST use Windows format (C:/Users/...) not WSL format (/mnt/c/...).
  * CRITICAL: The subtask "task" field MUST be prefixed with "ACCEPTANCE TEST: " (e.g. "ACCEPTANCE TEST: Run Godot syntax check and unit tests"). The verifier uses this exact prefix to trigger headless Godot test execution — without it, only a GDScript syntax check runs and the full Test.tscn/Playthrough.tscn tests are skipped.
  * The coder's response text MUST also contain the phrase "ACCEPTANCE TEST PASSED" — the verifier uses this exact string to detect a passing acceptance test.

COMPOSER PACKAGE NAME VALIDATION (CRITICAL — prevents adding non-existent packages):
If the Research Report or Refined Research flags that a Composer package named in the original task description does NOT exist (composer show returned Package not found, or a naming mismatch was noted), you MUST:
- Do NOT generate any subtask that adds or requires that non-existent package in composer.json.
- Do NOT change a working package entry to a non-existent package name just because the task description uses a different name.
- Instead, use the package that IS actually installed (confirmed by composer show) and note the discrepancy in the plan summary.
- Example: if the task says to add silverstripe/assets-admin but research shows that package is not found while silverstripe/asset-admin 3.2.0 is installed, skip the composer.json change and note why.

SILVERSTRIPE CLASS NAME RULES (apply whenever generating SilverStripe subtasks):
- NEVER reference SilverStripe\Elemental\* class names — this namespace does NOT exist. Elemental uses: DNADesign\Elemental\*
- Correct Elemental extension class: DNADesign\Elemental\Extensions\ElementalPageExtension
- DNADesign\Elemental\Extensions\ElementalCMSMainExtension does NOT exist in current package versions — do NOT use it
- Do NOT generate a subtask to "add Elemental extensions to Page" if the Scope Document or Research Report already shows those extensions present in app/_config/*.yml — this causes 28+ rollback loops from writing a YAML that references a nonexistent class
- When the Research Report flags "⚠️ ALREADY CONFIGURED" or "⚠️ ALREADY INSTALLED" for any feature, generate subtasks only for what is MISSING, not for what already exists
- If a subtask references a PHP class in a YAML "extensions:" block, the implementation_note MUST specify: (a) the full unquoted class name (e.g. DNADesign\\Elemental\\Extensions\\ElementalPageExtension), (b) that it MUST be written UNQUOTED in the YAML (no surrounding single or double quotes). Single-quoted YAML class names with backslashes cause a double-backslash runtime error that breaks bootstrap.

SWIFT PROJECT ATOMICITY RULES (apply when generating subtasks for Swift/iOS projects):
- @Observable MIGRATION MUST BE ONE SUBTASK: If any subtask migrates a class from ObservableObject to @Observable (adds @Observable macro, removes ObservableObject conformance, removes @Published), ALL consuming views MUST be updated in the SAME subtask — not in subsequent subtasks. The patch validator runs swiftc -typecheck after every single tool call; migrating the ViewModel first produces a compile error (consuming views still use @StateObject) that rolls back the ViewModel change before the view updates can run. The coder can NEVER "get there in steps". Combine ViewModel + ALL owner views (@StateObject→@State) + ALL receiver views (@ObservedObject→@Bindable) into ONE subtask with a single "files" array containing ALL affected files.
- UIKit REMOVAL MUST BE ONE SUBTASK: If a subtask removes "import UIKit", ALL UIKit-dependent API replacements (Color(.systemBackground), UIPasteboard, UINotificationFeedbackGenerator, UIApplication, UIActivityViewController) MUST be in the SAME subtask and the same write_file call. Removing the import alone reveals the API errors; the validator rolls back the patch.

FRESH PROJECT SCAFFOLDING (CRITICAL — without this, the app can never run):
When the Research Report indicates the workspace is empty or contains no package.json, index.html, vite.config.js, or framework config files, you MUST include a SCAFFOLD subtask as the FIRST subtask before any source file subtasks. This scaffold subtask must create ALL of the following in one write_file batch:
  • package.json (with correct dependencies: react, react-dom, vite, @vitejs/plugin-react, vitest for React/Vite projects)
  • vite.config.js (configured for React with vitest test environment)
  • index.html (the HTML entry point with <div id="root">)
  • src/main.jsx (the React entry point that renders <App /> into #root)
Without a scaffold subtask, source files like App.jsx are written into a dead project that has no package.json, no dev server, and cannot run vitest for tests. The verifier falsely passes because test validation is skipped when package.json is absent.

REVIEW-ONLY PLAN PROHIBITION (CRITICAL — prevents sessions that produce zero code changes):
The projectManager RUNS ONCE and its plan is FINAL. There is NO second planning pass after REVIEW subtasks complete.
- NEVER generate a plan that consists entirely of REVIEW subtasks with no implementation subtasks — this produces zero file changes and wastes the entire session.
- REVIEW subtasks are ONLY permitted as a prelude to implementation subtasks in the SAME plan. Every REVIEW subtask must be immediately followed by at least one implementation subtask that uses its findings.
- If the Scope Document lacks specific file paths, use the Research Report to make reasonable assumptions about file locations, then write the implementation subtasks with those assumed paths. The coder can read the files to confirm before writing.
- If you find yourself writing "implementation subtasks will be generated after review completes" — STOP. You are the only PM. Generate both the review AND the implementation subtasks in this plan, now.

SELF-CHECK (apply before outputting):
For each subtask ask: "Could a coder implement this without opening any file?" If the answer is No, the implementation_note is too vague - add the specific class name, method signature, existing code snippet, or config value that resolves the ambiguity.
Final plan check: Does this plan contain at least one subtask that writes or modifies a file? If all subtasks are REVIEW, EXECUTION-ONLY, or ACCEPTANCE TEST tasks — you MUST add implementation subtasks or the session produces zero output.`;

  if (state.taskType === "new_project") {
    systemPrompt += `

NEW_PROJECT MODE — You are building a brand-new application from scratch. There is no existing codebase to analyze.
- The workspace has a bare scaffold (e.g. Vite template) — your job is to plan ALL the source files that need to be created.
- Do NOT look for existing line numbers or class names to modify — create everything new.
- The SCOPE DOCUMENT may be empty or minimal — use the INTENT ANALYSIS and ORIGINAL TASK as your primary guide.
- Plan COMPREHENSIVE coverage: every feature mentioned in the task must have a subtask that creates the code for it.
- Each subtask should create a coherent set of related files (e.g. "Create chess engine types and board logic", "Create piece move generators", etc.).
- First subtask must install dependencies (npm install) AND create tsconfig.json, vite.config.ts, index.html, package.json WITH all required deps (including eslint-plugin-react-hooks for React projects). Verify npm run build succeeds.
- Last subtask should be a full integration: wire all components together and verify the app runs (npm run dev starts without errors, npm run build exits 0).
- implementation_note must describe WHAT TO CREATE, not what to modify.
- For new project tasks, prefer fewer larger subtasks over many small ones. A subtask implementing an entire game hook (200-400 lines) is better than 3 subtasks each touching the same file.

REACT GAME PROJECT SUBTASK RULES:
- The scaffold subtask MUST include eslint-plugin-react-hooks in devDependencies and configure it in eslint.config.js
- The scaffold subtask MUST include tsconfig.json (not just tsconfig.app.json) for full project type-checking
- For AI/game opponents: there must be a dedicated "Wire AI opponent and game state in App.tsx" subtask
  - This subtask MUST use useRef (not useState) for the AI-thinking semaphore
  - The AI effect must only depend on game state that triggers it (e.g. currentTurn), NOT on the semaphore itself
- Chess piece rendering subtask MUST use Unicode symbols: ♔♕♖♗♘♙ (white), ♚♛♜♝♞♟ (black) — never bare letters
- Visual styling subtask must include: 70px minimum square size, piece font-size 2.5rem+, hover cursor pointer, selected square highlight, legal move dots`;
  }

  if (state.taskType === "direct_fix") {
    // For direct_fix benchmarks the prompt already names the exact file and change.
    // A single implementation subtask is sufficient; extra REVIEW/SEARCH/ACCEPTANCE
    // subtasks create coder-verifier loops that consume the entire timeout budget.
    systemPrompt += `

DIRECT_FIX MODE — CRITICAL CONSTRAINT (overrides all other subtask count rules above):
The prompt already specifies the exact file, exact line, and exact change needed.
- Generate EXACTLY ONE implementation subtask.
- Do NOT generate REVIEW, ACCEPTANCE TEST, EXECUTION-ONLY, or secondary verification subtasks of any kind.
- "files" must contain exactly the file mentioned in the prompt.
- "implementation_note" must quote the change verbatim from the task description.
- The evaluation harness (check.js) runs automatically after the session — adding verify/test subtasks causes infinite coder-verifier loops and wastes the entire timeout budget.
- Maximum subtask count: 1. Writing more than 1 subtask violates this constraint and will cause the run to time out.`;
  }

  // Guard against degenerate values like "[]" that look truthy but carry no
  // useful information. These are produced when the agent loop terminates after
  // For direct_fix benchmark scenarios the prompt already names the exact file and
  // change — skip PM entirely to save the 10-30s wasted on LLM calls that reliably
  // return write_file tool-call arrays instead of a valid plan.
  if (state.taskType === "direct_fix" && state.benchmarkScenarioId) {
    const originalTask = state.messages[0]?.content || "Fix the bug described in the task";
    const fileHint = originalTask.match(/\b[\w/-]+\.(?:js|ts|py|rb|go|php|java|cs|cpp|c|rs)\b/)?.[0] || "";
    log(colors.dim(`  [Graph] -> direct_fix + benchmark: skipping PM, synthesizing subtask from prompt`));
    return {
      subtasks: [{
        id: 1,
        task: originalTask.slice(0, 200),
        implementationNote: originalTask,
        files: fileHint ? [fileHint] : [],
        acceptanceCriteria: "Implementation passes check.js",
        failureCriteria: "N/A",
      }],
      executionPlan: `Direct fix: ${originalTask.slice(0, 100)}`,
    };
  }

  // If the scope document carries a BLOCKED signal from the scoper (researcher couldn't
  // find the target file), surface it immediately as a single BLOCKED subtask so the
  // pipeline halts and the user sees why, rather than generating phantom subtasks.
  if (/⛔\s*BLOCKED/i.test(state.scopeDocument || "")) {
    const snippet = (state.scopeDocument || "").slice(0, 800);
    log(colors.red(`  [Graph] -> Project Manager: scope document is BLOCKED — halting plan generation`));
    return {
      subtasks: [
        {
          task: "⛔ BLOCKED — target file not found",
          implementationNote: snippet,
          files: [],
          acceptanceCriteria: "N/A",
          failureCriteria: "N/A",
        },
      ],
      executionPlan: snippet,
    };
  }

  // consecutive parse-error retries instead of completing normally.
  const isDegenerate = (v) => !v || /^\[\]$/.test(v.trim()) || v.trim().length < 20;

  // Build a compact fallback file list — always include so PM has ground-truth file names.
  // Inlined into the scope message (not a separate turn) to avoid Copilot context overflow.
  let fallbackFileListing = "";
  if (state.projectDir) {
    try {
      const entries = await fs.readdir(state.projectDir, { recursive: false });
      const rootFiles = entries
        .filter(e => !e.startsWith(".") && e !== "node_modules" && e !== "docs")
        .slice(0, 20);
      if (rootFiles.length > 0) {
        fallbackFileListing = `\n\nPROJECT FILES (use these exact paths when specifying files in subtasks):\n${rootFiles.join(", ")}`;
      }
    } catch { /* skip */ }
  }

  // Chunked providers (Copilot, 9500-char limit): the full 29K systemPrompt requires
  // 4 chunks per PM attempt. These providers consistently fail on large multi-chunk PM
  // prompts. Use a compact system prompt + task-only messages that fit in 1-2 chunks.
  const isChunkedProviderForPM = (state.provider?.maxPromptChars ?? Infinity) <= 9500;
  let planningMessages;
  if (isChunkedProviderForPM) {
    const minimalSystemPrompt =
      `You are a Project Manager. Break the task into 1-3 focused subtasks.\n` +
      `Output ONLY a raw JSON object (no markdown, no prose) with exactly these keys:\n` +
      `{ "plan": "one-line summary", "subtasks": [ { "task": "...", "implementationNote": "...", "files": ["path/to/file"], "acceptanceCriteria": "...", "failureCriteria": "..." } ] }\n` +
      `Rules:\n` +
      `- Each subtask must name specific files (relative paths, e.g. script.js)\n` +
      `- "task" field: ≤150 chars summarizing what to change\n` +
      `- "implementationNote": full detail on HOW to make the change\n` +
      `- Output ONLY the JSON object, nothing else`;
    const taskText = state.messages[0]?.content || "Fix the bug described in the task";
    planningMessages = [
      { role: "system", content: minimalSystemPrompt },
      { role: "user", content: `TASK:\n${taskText}${fallbackFileListing}` },
    ];
    log(colors.dim(`  [Graph] -> PM: using minimal prompt for chunked provider (~${(minimalSystemPrompt.length + taskText.length).toLocaleString()} chars)`));
  } else {
    /** @type {import('ai').ModelMessage[]} */
    planningMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `ORIGINAL TASK:\n${state.messages[0]?.content || ""}` },
      ...(state.intentDocument
        ? [{ role: "user", content: `INTENT ANALYSIS (use success criteria to ensure plan is complete):\n${state.intentDocument}` }]
        : []),
      ...(state.refinedResearch
        ? [{ role: "user", content: `REFINED RESEARCH (condensed key facts — implementation focus):\n${state.refinedResearch}` }]
        : []),
      { role: "user", content: `FULL RESEARCH REPORT (key findings):\n${isDegenerate(state.researchSummary) ? (isDegenerate(state.researchContext) ? "(none)" : state.researchContext.slice(0, 3000)) : state.researchSummary}` },
      {
        role: "user",
        content: `SCOPE DOCUMENT (authoritative - use file paths from here):\n${isDegenerate(state.scopeDocument) ? `(Scoper produced no output - fall back to Research Report paths)` : state.scopeDocument}${fallbackFileListing}`,
      },
    ];
  }

  const signal = config?.signal ?? null;
  const MAX_PLAN_ATTEMPTS = 3;

  let subtasks = [];
  let executionPlan = "";
  let lastAttemptError = null;
  let reviewOnlyOverride = null; // injected on retry when plan has no file writes
  let jsonErrorOverride = null;  // injected on retry when JSON parse fails

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      log(colors.yellow(`  [Graph] -> Project Manager retry ${attempt}/${MAX_PLAN_ATTEMPTS}...`));
      // Reset the browser session before each retry so that accumulated conversation
      // context from the failed attempt doesn't overflow DeepSeek's output token budget
      // and cause garbage responses (<select>, <div id='playground-mount'>) on retries.
      if (!state.model) {
        await state.provider?.startNewChat?.();
      }
    }

    // Build message list: start with base messages, then append any retry overrides.
    let messagesForAttempt = planningMessages;
    if (jsonErrorOverride) {
      messagesForAttempt = [...planningMessages, { role: "user", content: jsonErrorOverride }];
    } else if (reviewOnlyOverride) {
      messagesForAttempt = [...planningMessages, { role: "user", content: reviewOnlyOverride }];
    }

    let planText = "";

    if (state.model) {
      const { text } = await generateText({
        model: state.model,
        messages: messagesForAttempt,
        abortSignal: signal,
      });
      planText = text;
    } else {
      const result = await state.provider.sendTurn(messagesForAttempt, "projectManager", {
        rootDir: state.projectDir,
        interactionMode: "scoping",
        signal,
      });
      planText = result?.text ?? "";
      if (planText) {
        eventBus.emit("message_complete", { text: planText });
      }
    }

    if (!planText.trim()) {
      lastAttemptError = new Error("Project Manager returned empty response (provider stall)");
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: empty response - will retry`));
      continue;
    }

    // Detect provider service errors (rate limit / service outage).
    // When the provider returns this, all retries will also fail — break
    // immediately so the fallback synthesizes a plan without burning quota.
    if (/we are experiencing an issue/i.test(planText) || /please try submitting a new message/i.test(planText)) {
      lastAttemptError = new Error("Provider service error (rate-limited or service outage)");
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: provider service error — breaking retry loop`));
      break;
    }

    let parsed = null;
    // Hoisted so the post-parse truncation guard below can read it without TDZ.
    let truncationSuffix = "";
    try {
      const firstBrace = planText.indexOf("{");
      if (firstBrace === -1) throw new Error("No JSON object found in output");

      // Use brace-depth matching to find the true end of the outermost JSON object.
      // lastIndexOf("}") is unreliable when the AI appends extra text with } characters
      // (e.g. PHP code examples like SilverStripe\Core\Extension { ... }) after the JSON block.
      let jsonEnd = -1;
      {
        const stack = [];
        let inString = false;
        let esc = false;
        for (let i = firstBrace; i < planText.length; i++) {
          const ch = planText[i];
          if (esc) { esc = false; continue; }
          if (ch === "\\" && inString) { esc = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === "{") stack.push("}");
          else if (ch === "[") stack.push("]");
          else if (ch === "}" || ch === "]") {
            stack.pop();
            if (stack.length === 0) { jsonEnd = i; break; }
          }
        }
        // Truncation recovery: if JSON was cut off, close all open brackets/braces
        if (jsonEnd === -1 && stack.length > 0) {
          truncationSuffix = stack.reverse().join("");
          log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: JSON truncated (depth ${stack.length}) — appending "${truncationSuffix}" to recover`));
        }
      }
      if (jsonEnd === -1 && !truncationSuffix) throw new Error("No closing brace found for JSON object");

      // Pre-escape composer/npm package-version patterns before sanitizeJsonStrings runs,
      // so that "vendor/pkg": "constraint" inside implementation_note strings are already
      // escaped as \"vendor/pkg\": \"constraint\" and won't cause premature string closure.
      // Also strip Gemini "immersive chip" URL tokens and fix invalid escape sequences.
      const extractedText = (jsonEnd === -1
        ? planText.substring(firstBrace) + truncationSuffix
        : planText.substring(firstBrace, jsonEnd + 1)
      ).replace(/https?:\/\/googleusercontent\.com\/immersive_entry_chip\/\d+/g, "");
      const rawJson = sanitizeJsonStrings(
        preEscapePackageVersionPatterns(
          preEscapeQuotesInSingleQuotedCodeRegions(extractedText),
        ),
      );
      try {
        parsed = JSON.parse(rawJson);
        if (truncationSuffix) log(colors.dim(`  [Graph] -> Project Manager attempt ${attempt}: truncation recovery succeeded.`));
      } catch {
        // First parse failed — try jsonrepair on the original extracted text (before sanitize
        // mangled any string boundaries). jsonrepair uses structural look-ahead to distinguish
        // embedded quotes from true string terminators, handling patterns like PHP function
        // args ("o", "Link", $this) and .env assignments (VAR="value") that heuristic repair
        // cannot reliably fix.
        const originalExtracted = extractedText;
        try {
          parsed = JSON.parse(jsonrepair(originalExtracted));
          log(colors.dim(`  [Graph] -> Project Manager attempt ${attempt}: parsed after jsonrepair.`));
        } catch {
          // Final fallback: heuristic quote repair on the sanitized text.
          const repaired = repairUnescapedQuotesInJson(rawJson);
          parsed = JSON.parse(repaired); // throws if still invalid → caught by outer catch
          log(colors.dim(`  [Graph] -> Project Manager attempt ${attempt}: parsed after heuristic quote repair.`));
        }
      }

      // Unwrap: AI sometimes wraps the plan inside a write_file tool call (single object)
      // e.g. { "tool": "write_file", "content": "{\"plan\":...\"subtasks\":[...]}" }
      if (parsed && typeof parsed.tool === "string" && typeof parsed.content === "string") {
        try {
          const inner = JSON.parse(parsed.content);
          if (inner && Array.isArray(inner.subtasks)) parsed = inner;
        } catch {}
      }

      // Unwrap: AI returns an array of write_file tool calls instead of a plan.
      // e.g. [{ "tool": "write_file", "path": "...", "content": "..." }, ...]
      // This happens when direct_fix prompts are given to DeepSeek — it implements
      // directly rather than planning. Extract file paths as subtask hints.
      if (Array.isArray(parsed)) {
        const writeFileCalls = parsed.filter(
          (item) => item && typeof item === "object" && item.tool === "write_file" && item.path
        );
        if (writeFileCalls.length > 0) {
          const originalTask = state.messages[0]?.content || "Fix the bug described in the task";
          const files = writeFileCalls.map((c) => c.path);
          log(colors.dim(`  [Graph] -> PM returned write_file array — synthesizing subtask from file paths: ${files.join(", ")}`));
          parsed = {
            plan: "Direct implementation inferred from write_file response",
            subtasks: [{
              task: originalTask.slice(0, 200),
              implementationNote: originalTask,
              files,
              acceptanceCriteria: "Fix applied to the specified file(s)",
              failureCriteria: "N/A",
            }],
          };
        }
      }
    } catch (e) {
      lastAttemptError = e;
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: JSON parse failed - ${e.message}`));
      log(colors.dim(`  [Graph] -> Raw output (first 500 chars): ${planText.slice(0, 500)}`));
      // Inject specific feedback so the AI knows exactly how to fix the JSON on retry.
      // The most common cause: unescaped double-quote characters inside string values
      // (e.g. quoting composer.json keys like "silverstripe/framework": "^6" without escaping).
      jsonErrorOverride =
        `JSON PARSE ERROR — your previous response was rejected because it contained invalid JSON.\n\n` +
        `Error: ${e.message}\n\n` +
        `Raw output that failed (first 600 chars):\n${planText.slice(0, 600)}\n\n` +
        `MOST COMMON CAUSE: double-quote characters inside string values that are not escaped.\n` +
        `WRONG:   "implementation_note": "Run: "silverstripe/framework": "^6""\n` +
        `CORRECT: "implementation_note": "Run: \\"silverstripe/framework\\": \\"^6\\""\n\n` +
        `Rules for this retry:\n` +
        `1. Output ONLY the raw JSON object — no markdown, no code fences, no prose before or after.\n` +
        `2. Every " character INSIDE a string value MUST be escaped as \\".\n` +
        `3. File content examples, composer.json keys/values, PHP class names, and YAML snippets that contain " MUST use \\" inside the JSON string.\n` +
        `4. Newlines inside string values must be \\n, not literal line breaks.\n\n` +
        `Output the complete corrected plan now as a JSON object with "plan" and "subtasks" keys.`;
      continue;
    }

    const candidateSubtasks = parsed.subtasks || [];

    if (candidateSubtasks.length === 0) {
      lastAttemptError = new Error("Project Manager produced zero subtasks");
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: plan has zero subtasks`));
      log(colors.dim(`  [Graph] -> Raw output (first 500 chars): ${planText.slice(0, 500)}`));
      continue;
    }

    // Quality gate: reject if all subtasks are trivially vague (catch-all fallback pattern)
    const allTrivial = candidateSubtasks.every(
      (s) => !s.task || s.task === "Complete the entire plan",
    );
    if (allTrivial) {
      lastAttemptError = new Error("Project Manager produced only trivial/vague subtasks");
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: all subtasks are trivial - will retry`));
      continue;
    }

    // Quality gate: reject review-only plans (no subtask writes any file).
    // REVIEW/EXECUTION-ONLY/ACCEPTANCE TEST subtasks all have files:[] and no
    // writes — a plan of only these types produces zero code changes. Force a
    // retry with an explicit override message demanding implementation subtasks.
    //
    // EXEMPTION: Pure audit/verification tasks ("Verify that X", "Check if X",
    // "Determine whether X", "Audit X") legitimately have no implementation work.
    // Forcing file writes on these tasks produces invented busywork (fake notes.txt,
    // spurious README updates) that pollutes the repo. Detect these by checking the
    // original task text and intent document goal for verification-only language.
    const originalTask = String(state.messages?.[0]?.content || "").toLowerCase();
    const intentGoal = String(state.intentDocument || "").toLowerCase().slice(0, 500);
    const combinedContext = originalTask + " " + intentGoal;
    const isPureVerificationTask =
      /\b(verify\s+that|verify\s+if|verify\s+whether|check\s+that|check\s+if|check\s+whether|determine\s+if|determine\s+whether|determine\s+if|audit\s+the|confirm\s+that|confirm\s+whether|assess\s+whether|pass\s*\/\s*fail|pass\s+or\s+fail|read[\s-]only\s+audit|read[\s-]only\s+verification|no\s+code\s+changes\s+required)\b/i.test(combinedContext);

    const hasFileWrite = candidateSubtasks.some(
      (s) =>
        Array.isArray(s.files) &&
        s.files.length > 0 &&
        !String(s.task).startsWith("REVIEW:") &&
        !String(s.task).startsWith("ACCEPTANCE TEST:"),
    );
    if (!hasFileWrite && !isPureVerificationTask) {
      const reviewTaskList = candidateSubtasks
        .map((s, i) => `  ${i + 1}. ${s.task}`)
        .join("\n");
      lastAttemptError = new Error("Project Manager produced only REVIEW/ACCEPTANCE TEST subtasks — no file writes");
      log(colors.yellow(`  [Graph] -> Project Manager attempt ${attempt}: review-only plan detected — forcing implementation subtask retry`));
      reviewOnlyOverride =
        `PIPELINE VIOLATION — REVIEW-ONLY PLAN REJECTED\n\n` +
        `Your previous plan contained ONLY REVIEW and ACCEPTANCE TEST subtasks with no file writes:\n${reviewTaskList}\n\n` +
        `This session will produce ZERO code changes. That is not acceptable.\n\n` +
        `You MUST now output a NEW plan that includes concrete implementation subtasks that write or modify files.\n` +
        `Rules for this retry:\n` +
        `1. Keep the REVIEW subtasks if needed, but each REVIEW subtask must be immediately paired with an implementation subtask that uses its findings.\n` +
        `2. Use the Research Report to make best-guess file paths for the implementation subtasks. The coder will read-confirm before writing.\n` +
        `3. At least 50% of all subtasks must be implementation tasks (files[] non-empty, not prefixed with REVIEW: or ACCEPTANCE TEST:).\n` +
        `4. Do NOT write "implementation subtasks will follow after review" — you are the only PM and this is your only chance.\n\n` +
        `Output the complete corrected plan now as a JSON object with "plan" and "subtasks" keys.`;
      continue;
    }

    // Exempt: pure verification task with all-REVIEW plan — this is correct
    if (!hasFileWrite && isPureVerificationTask) {
      log(colors.cyan(`  [Graph] -> Project Manager: review-only plan accepted — task is a pure audit/verification (no implementation expected)`));
    }

    // Truncation guard: if JSON truncation recovery had to close brackets AND
    // the resulting plan only has 1 subtask, the model's output was cut off
    // mid-list. Silently accepting yields a tiny scaffold-only plan that
    // doesn't match the user's actual ask. Retry to get the full plan.
    // (Observed in chess iter 10 with Grok: 1 subtask "create .gitignore +
    // basic skeleton" survived a depth-3 truncation; reviewers approved a
    // project with no chess code at all.)
    if (truncationSuffix && candidateSubtasks.length <= 1 && attempt < MAX_PLAN_ATTEMPTS) {
      lastAttemptError = new Error(
        `Project Manager output was truncated and only ${candidateSubtasks.length} subtask survived recovery`,
      );
      log(colors.yellow(
        `  [Graph] -> Project Manager attempt ${attempt}: plan truncated to ${candidateSubtasks.length} subtask(s) — retrying for a complete plan`,
      ));
      jsonErrorOverride =
        `PREVIOUS PLAN WAS TRUNCATED — only ${candidateSubtasks.length} subtask(s) survived JSON recovery.\n\n` +
        `Output a complete plan as a SINGLE valid JSON object. Keep each subtask short ` +
        `(task <= 100 chars, implementation_note <= 300 chars) so the full plan fits in your response budget.\n\n` +
        `The plan must cover ALL the work implied by the original task — typically 3-6 subtasks for a small project.\n\n` +
        `Output ONLY the JSON object. No markdown, no prose.`;
      continue;
    }

    // Valid plan - accept it
    subtasks = candidateSubtasks;
    executionPlan = parsed.plan || planText;
    lastAttemptError = null;
    break;

  }

  if (subtasks.length === 0) {
    const reason = lastAttemptError?.message ?? "unknown error";
    log(colors.red(`  [Graph] -> Project Manager: all ${MAX_PLAN_ATTEMPTS} attempts failed — ${reason}`));

    // direct_fix / quick_edit: PM is redundant — the prompt already names the exact files.
    // Synthesize subtasks from the original task rather than blocking the session.
    // Also applies to chunked providers (e.g. Copilot) that can't handle large PM prompts.
    const isChunkedProvider = (state.provider?.maxPromptChars ?? Infinity) <= 9500;
    if (state.taskType === "direct_fix" || state.taskType === "quick_edit" || isChunkedProvider) {
      const originalTask = state.messages[0]?.content || "Fix the bug described in the task";
      // Extract all referenced file paths from the task description.
      const fileMatches = [...new Set(
        (originalTask.match(/\b[\w./-]+\.(?:js|ts|jsx|tsx|css|html|py|rb|go|php|java|cs|cpp|c|rs)\b/g) || [])
          .filter((f) => !f.startsWith(".") && f.length < 60)
      )];
      const files = fileMatches.length > 0 ? fileMatches : [];
      log(colors.yellow(`  [Graph] -> PM fallback: synthesizing subtask from prompt (files: ${files.join(", ") || "none"})`));
      return {
        subtasks: [{
          task: originalTask.slice(0, 500),
          implementationNote: originalTask,
          files,
          acceptanceCriteria: "Implementation matches the fix described in the task",
          failureCriteria: "N/A",
        }],
        executionPlan: `Direct fix: ${originalTask.slice(0, 100)}`,
      };
    }

    eventBus.emit("system_message", {
      text: `⚠️ Project Manager failed to produce a valid plan after ${MAX_PLAN_ATTEMPTS} attempts: ${reason}`,
      type: "error",
    });
    // Return a BLOCKED sentinel instead of throwing so the pipeline routes gracefully
    // to broadcastReviews → knowledgeCapture → END rather than crashing the LangGraph
    // workflow and silently closing the session without any user notification.
    return {
      subtasks: [{
        task: "⛔ BLOCKED — Project Manager failed to produce a valid plan",
        implementationNote:
          `All ${MAX_PLAN_ATTEMPTS} planning attempts failed. Last error: ${reason}\n\n` +
          `Common causes:\n` +
          `• JSON parse failure: AI put unescaped double-quote characters inside JSON string values (e.g. quoting composer.json package names like "vendor/pkg": "^2" without escaping as \\"vendor/pkg\\": \\"^2\\")\n` +
          `• Review-only plan: AI generated only REVIEW/ACCEPTANCE TEST subtasks with no file writes\n` +
          `• Empty response: provider stalled`,
        files: [],
        acceptanceCriteria: "N/A",
        failureCriteria: "N/A",
      }],
      executionPlan: `PLANNING FAILED: ${reason}`,
    };
  }

  // ── Post-generation atomicity consolidation ──────────────────────────────
  // Merge subtasks that form a logically-atomic operation across multiple steps.
  // This runs AFTER all PM retries so it always applies to the accepted plan.
  subtasks = consolidateAtomicSubtasks(subtasks, state.projectType);

  subtasks = subtasks.map((s) => ({
    id: s.id,
    task: s.task,
    files: Array.isArray(s.files) ? s.files : [],
    lineRange: typeof s.line_range === "string" ? s.line_range : (typeof s.lineRange === "string" ? s.lineRange : ""),
    implementationNote: typeof s.implementation_note === "string" ? s.implementation_note : (typeof s.implementationNote === "string" ? s.implementationNote : ""),
    constraints: typeof s.constraints === "string" ? s.constraints : "",
    // Structured acceptance test fields — only present on ACCEPTANCE TEST subtasks.
    acceptanceCriteria: typeof s.acceptanceCriteria === "string" ? s.acceptanceCriteria : "",
    failureCriteria: typeof s.failureCriteria === "string" ? s.failureCriteria : "",
  }));

  const planSteps = subtasks.map((s) => ({
    id: s.id,
    label: s.task,
    state: "pending",
  }));

  setDashboardState({
    plan: { steps: planSteps },
    activeTaskId: null,
    completedCount: 0,
    totalCount: planSteps.length,
  });

  // Persist to checkpoint bridge so self-heal can resume from the correct subtask
  // even if the process crashes before the first coder turn completes.
  updateCheckpointState({ subtasks, executionPlan, currentSubtaskIndex: 0 });

  log(
    colors.yellow(
      `  [Graph] -> Project Manager produced ${subtasks.length} subtask(s).`,
    ),
  );

  return {
    executionPlan,
    subtasks,
    currentSubtaskIndex: 0,
    currentPersona: PERSONA.id,
  };
}
