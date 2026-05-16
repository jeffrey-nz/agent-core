import fs from "node:fs";
import path from "node:path";
import { streamText } from "ai";
import { getMcpBoundTools } from "../../tools/sdkRegistry.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { personaMeta } from "../personas.js";
import { MAX_STEPS_SCOPER, MAX_STEPS_SCOPER_REFINE } from "#config/pipeline.js";
import { updateCheckpointState } from "../checkpointBridge.js";
import { readMemoryFile } from "#docs/memory.js";

// Extensions that count as code files for BLOCKED hallucination detection.
const CODE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".html", ".css", ".scss", ".sass",
  ".py", ".rb", ".go", ".php", ".vue", ".svelte",
]);

/**
 * Checks whether any file mentioned in the task exists inside projectDir.
 * Used to detect LLM hallucinations of BLOCKED when files genuinely exist.
 */
function taskFilesExistInProject(taskText, projectDir) {
  if (!projectDir || !taskText) return false;
  const mentioned = [...new Set(
    (taskText.match(/\b[\w/-]+\.(?:js|jsx|ts|tsx|mjs|cjs|html|css|scss|sass|py|rb|go|php|vue|svelte)\b/g) || [])
      .map((f) => path.basename(f))
      .filter((f) => f.length > 1 && f.length < 60),
  )];
  if (mentioned.length === 0) return false;

  const found = new Set();
  const walk = (dir, depth = 0) => {
    if (depth > 4 || found.size > 0) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", "vendor", ".venv"].includes(entry.name)) continue;
        if (entry.isFile() && mentioned.includes(entry.name)) { found.add(entry.name); return; }
        if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      }
    } catch { /* unreadable */ }
  };
  walk(projectDir);
  return found.size > 0;
}

const PERSONA = personaMeta("scoper");

/**
 * Reads the Invariants section from docs/memory/patterns.md.
 * Returns the section body, or null if absent.
 */
async function readArchitectureInvariants(projectDir) {
  if (!projectDir) return null;
  try {
    const content = await readMemoryFile(projectDir, "patterns.md");
    const match = content.replace(/<!--[\s\S]*?-->/g, "").match(/^## Invariants\n([\s\S]*?)(?=\n## |\n# |$)/m);
    const body = match ? match[1].trim() : null;
    return body && body.length > 10 ? body : null;
  } catch {
    return null;
  }
}

export async function scoperNode(state, config) {
  log(colors.cyan("  [Graph] -> Running Scoper Agent (Deep Exploration)..."));

  eventBus.emit("persona_change", { ...PERSONA, description: "Mapping exact file locations, line numbers, and dependencies" });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Scoping..." });

  // Strip Copilot365 interface scaffolding - <execution> and <current_state>
  // blocks are chat-phase metadata that instruct the AI to refuse tools.
  const rawUserTask = state.messages.find((m) => m.role === "user")?.content || "";
  const userTask = rawUserTask
    .replace(/<execution>[\s\S]*?<\/execution>/gi, "")
    .replace(/<current_state>[\s\S]*?<\/current_state>/gi, "")
    .trim();
  const researchReport = state.researchContext || "";

  // If the researcher reported BLOCKED (could not find target files), propagate that
  // immediately rather than letting the scoper substitute a different file.
  // EXCEPTIONS:
  //   1. Tool unavailability: Copilot can't run list_dir/read_file — proceed with minimal scope.
  //   2. Hallucination: files mentioned in the task actually exist in the workspace — some
  //      LLMs (especially ChatGPT) generate BLOCKED without genuinely searching. Detect this
  //      by checking the filesystem; if files exist, the block is a false positive.
  if (/⛔\s*BLOCKED[:\s]/i.test(researchReport)) {
    const toolUnavailability = /can'?t\s+(actually\s+)?run|can'?t\s+call|can'?t\s+(use|access)\s+(the\s+)?(tools?|list_dir|read_file)|no\s+access\s+to\s+tool|tool.*not\s+available/i.test(researchReport);
    if (!toolUnavailability) {
      if (taskFilesExistInProject(userTask, state.projectDir)) {
        log(colors.yellow(
          `  [Graph] -> Scoper: researcher reported BLOCKED but task files exist in workspace — likely hallucination, proceeding`,
        ));
        // Fall through to normal scoping
      } else {
        const blockedMatch = researchReport.match(/⛔\s*BLOCKED[\s\S]{0,600}/i);
        const blockedSnippet = blockedMatch ? blockedMatch[0].slice(0, 600) : "Researcher reported BLOCKED.";
        log(colors.red(`  [Graph] -> Scoper: researcher reported BLOCKED — propagating without scoping`));
        return {
          scopeDocument: `## SCOPE DOCUMENT\n\n⛔ BLOCKED — RESEARCHER COULD NOT FIND TARGET FILE\n\n${blockedSnippet}\n\nDo NOT proceed with implementation. The task description likely had file paths stripped by rich-text formatting. Ask the user to re-submit with the exact file path written in plain text.`,
        };
      }
    } else {
      log(colors.yellow(`  [Graph] -> Scoper: researcher BLOCKED due to tool unavailability — proceeding with minimal scope`));
    }
  }

  const systemPrompt = `You are a Codebase Scoper.
Your job is to build a precise SCOPE DOCUMENT by reading the actual code - never invent or assume.

You have been given a Research Report that identifies relevant areas. Now you must verify and expand on it:
1. Read every file mentioned in the research report
2. Find the exact lines, function signatures, class hierarchies that need changing
3. Trace dependencies: who calls what, what imports what, what inherits from what
4. Identify ALL files that need touching - including files the researcher did not mention
5. Note any breaking changes, migration requirements, or gotchas

SCOPE DOCUMENT FORMAT:
Output your findings in the following structure:

## SCOPE DOCUMENT

### Files to Modify
For each file: path, relevant line range, what specifically needs to change and why.
Example:
- \`src/auth/AuthService.ts\` (lines 45-72): The \`login()\` method needs a new \`rememberMe\` parameter. Called from 3 places (see Callsites).

### Content to Remove / Replace
MANDATORY for any template or rendering change: list every line that must be DELETED and what replaces it.
A coder who only sees "add X" will APPEND it alongside the old code — both will render simultaneously.
For every REPLACEMENT, you MUST write:
  - OLD (line N): [exact current content] — MUST BE DELETED
  - NEW: [exact replacement] — replaces the deleted line
Example:
  - OLD (line 8): [$Content] — MUST BE DELETED (unconditional Content always renders; conflicts with Elemental)
  - NEW: [<% if \$ElementalArea && \$ElementalArea.Elements.Count %> ... <% else_if \$Content %> ... <% end_if %>]
If you cannot confirm the exact conflicting lines from reading the file, say so explicitly — the Project Manager will generate a REVIEW subtask to identify them before the implementation subtask.

### Files to Create
New files needed and their purpose.

### Callsites & Dependencies
List every callsite, import, or subclass that will be affected by the changes above.

### Implementation Order
Suggest the order in which files should be modified to avoid dependency issues.

### Constraints & Gotchas
Hard constraints, migration notes, or tricky edge cases the implementor must know.

RULES:
- EFFICIENCY: Call multiple read_file, grep, and list_dir tools in a single response array. Group related reads together — you can read 5-10 files at once by including them all in one JSON array. Never wait for a file result before deciding to read another file you already know you need.
- Use tools aggressively - you have ${MAX_STEPS_SCOPER} steps, use them
- Read the actual file contents before making any claim about line numbers
- MANDATORY PATH VERIFICATION: For EVERY file path mentioned in the research report, call read_file or find_file to confirm it exists BEFORE including it in your scope document. This is not optional.
  - If read_file returns "[ERROR: File not found]": immediately call find_file with just the filename (no directory) to locate the real path.
  - If find_file returns no results: try variations of the filename or search a parent directory.
  - NEVER include a path in your scope document that you have not confirmed exists. A scope document with wrong paths causes the coder to make phantom edits that waste multiple retry cycles.
  - If you genuinely cannot find a file after 2 search attempts: write "⚠️ [NOT FOUND] filename.ext - searched but could not locate; coder must use find_file before patching" in the scope document.
- TEMPLATE RENDERING ANALYSIS (critical for .ss / .html / .erb / .twig files):
  When a task involves changing how content is rendered in a template file, you MUST:
  1. Read the ENTIRE template file, not just the lines the researcher mentioned
  2. Identify EVERY place the old content type is currently rendered (look for ALL occurrences of $Content, $Body, $MainContent, etc.)
  3. For each conflicting occurrence: quote the exact line(s) and mark them "⚠️ MUST DELETE — leaving this line creates dual rendering"
  4. State the NEW rendering block that replaces the deleted line(s)
  If you only scope the "add new block" but miss the "delete old line", the coder will produce a dual-rendering bug (old always renders + new conditionally renders) that is invisible to HTTP 200 smoke tests.
- CMS FIELD SUPPRESSION ANALYSIS (critical when task involves getCMSFields, Elemental area in CMS, or field visibility):
  When a task involves making fields appear in the SilverStripe CMS admin, you MUST:
  1. grep -rn 'removeByName' app/src/ — find EVERY removeByName() call in the entire codebase
     Flag these specifically: removeByName('Content'), removeByName('ElementalArea'), removeByName('ElementalAreaID'), removeByName('Root.Main')
  2. grep -rn 'getCMSFields' app/src/ — find ALL getCMSFields() overrides
     For each: read_file and check if it calls parent::getCMSFields(). If NOT — it replaces all fields and Elemental is silently dropped
  3. grep -rn 'updateCMSFields' app/src/ — find all extension hooks that modify CMS fields
     Any that call removeByName() can suppress Elemental
  4. In your scope document, quote the EXACT line(s) with removeByName or missing parent:: calls and mark them "⚠️ MUST DELETE" or "⚠️ MUST ADD parent::getCMSFields() call"
  5. Verify that ElementalPageExtension is attached in a _config YAML — read the file and quote the relevant lines
  Note: CMS admin acceptance tests cannot use http_request (admin requires authentication). Include "STRUCTURAL ACCEPTANCE" guidance in your Implementation Order.
- ARCHITECTURE INVARIANTS: If the user message includes an "ARCHITECTURE INVARIANTS" block, treat each entry as a hard constraint that the proposed implementation MUST NOT violate. For each invariant: (a) grep or read the relevant file to confirm the invariant is currently satisfied, (b) include the invariant verbatim in your "Constraints & Gotchas" section, (c) if the task would violate an invariant, flag it as ⚠️ INVARIANT VIOLATION and explain what must be preserved instead.
- Do NOT write or modify any code - this is analysis only`;

  // Prepend the refiner's condensed research (if available) so the scoper knows
  // exactly which findings matter most before beginning its own deeper verification.
  const refinedBlock = state.refinedResearch
    ? `\n\nREFINED RESEARCH (condensed key findings from researcher — focus on these):\n${state.refinedResearch}`
    : "";

  // Inject Architecture Invariants from the project's knowledge file.
  // These are hard rules written by prior sessions about code that must not be
  // deleted or bypassed — e.g. "translateSentence() must be called when creating
  // Sentence objects." Including them here means the scoper adds them to
  // Constraints & Gotchas, and the planner never generates a subtask that violates them.
  const architectureInvariants = await readArchitectureInvariants(state.projectDir);
  const invariantsBlock = architectureInvariants
    ? `\n\nARCHITECTURE INVARIANTS (hard constraints from prior sessions — MUST NOT be violated):\n${architectureInvariants}`
    : "";

  /** @type {import('ai').ModelMessage[]} */
  const messages = [
    { role: "system", content: systemPrompt },
    ...(state.intentDocument
      ? [{ role: "user", content: `[USER INTENT ANALYSIS — success criteria to guide your scoping]\n${state.intentDocument}` }]
      : []),
    {
      role: "user",
      content: `ORIGINAL TASK:\n${userTask}${invariantsBlock}${refinedBlock}\n\nFULL RESEARCH REPORT (verify all paths with tools):\n${researchReport}`,
    },
  ];

  const signal = config?.signal ?? null;
  const context = {
    rootDir: state.projectDir,
    ignore: state.ignore,
    requireWriteFile: false,
    requireTools: true,      // must use tools — prose-only responses trigger recovery
    readOnly: true,          // scoper must never modify or delete files
    interactionMode: "readOnly", // use read-only tool list (no execute_bash) in prompt
    allowedDirs: state.contextDirs || [],
    signal,
  };

  let scopeDocument = "";

  if (state.model) {
    const { textStream } = streamText({
      model: state.model,
      messages,
      tools: /** @type {import('ai').ToolSet} */ (await getMcpBoundTools(context)),
      maxSteps: MAX_STEPS_SCOPER,
      abortSignal: signal,
    });

    for await (const part of textStream) {
      scopeDocument += part;
      eventBus.emit("message_chunk", { chunk: part });
    }
    eventBus.emit("message_complete", {});
  } else {
    const _scopeTurnStart = Date.now();
    const _scopeTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - _scopeTurnStart) / 1000);
      eventBus.emit("spinner_update", {
        status: `Scoper - deep-reading codebase (${elapsed}s)...`,
      });
    }, 10000);

    let result;
    try {
      result = await state.provider.sendTurn(messages, "scoper", context);
    } finally {
      clearInterval(_scopeTicker);
    }

    scopeDocument = result?.text ?? "";
    if (scopeDocument) {
      eventBus.emit("message_complete", { text: scopeDocument });
    }

    // If the text response is thin, recover the scope document from write_file tool calls.
    // Some models (e.g. DeepSeek) wrap their scope doc in a write_file call instead of
    // outputting it as text. Extract content from the most relevant write_file.
    if (
      scopeDocument.trim().length < 100 &&
      Array.isArray(result?.toolCalls) &&
      result.toolCalls.length > 0
    ) {
      for (const tc of result.toolCalls) {
        const params = tc.parameters || tc.input || tc;
        const content = typeof params.content === "string" ? params.content : null;
        if (
          content &&
          /##\s*SCOPE DOCUMENT|##\s*FILES?\s+TO\s+MODIFY/i.test(content) &&
          content.length > 200
        ) {
          scopeDocument = content;
          log(colors.dim("  [Graph] -> Scoper: recovered scope document from write_file tool call."));
          break;
        }
      }
    }

    // If all tool calls were execute_bash with no file reads, the model got stuck
    // in an echo/exit loop. Force degenerate to skip refinement (same loop would occur).
    if (Array.isArray(result?.toolCalls) && result.toolCalls.length >= 2) {
      const fileReadTools = new Set(["read_file", "find_file", "list_dir", "grep", "search_files"]);
      const hasAnyRead = result.toolCalls.some((tc) =>
        fileReadTools.has((tc.tool || tc.name || "").toLowerCase()),
      );
      const allBash = result.toolCalls.every((tc) =>
        (tc.tool || tc.name || "").toLowerCase() === "execute_bash",
      );
      if (allBash && !hasAnyRead) {
        log(colors.yellow("  [Graph] -> Scoper: all tool calls were execute_bash with no file reads — skipping refinement, using research fallback."));
        scopeDocument = "";
      }
    }
  }

  // If the AI produced nothing (e.g. provider error or degenerate "[]" response),
  // fall back to the research report so the pipeline doesn't stall.
  // "[]" is the exact string returned when the agent loop terminates after
  // consecutive parse-error retries - treat it as empty, not as a scope document.
  const isDegenerate =
    !scopeDocument.trim() ||
    /^\[\]$/.test(scopeDocument.trim()) ||
    scopeDocument.trim().length < 100;
  if (isDegenerate) {
    log(colors.yellow("  [Graph] -> Scoper produced no output - using research report as fallback."));
    // IMPORTANT: The fallback warning is embedded in the scope document so the
    // Planner reads it and treats all class names / paths with extra skepticism.
    // Without this warning the Planner silently trusts unverified researcher output,
    // which caused a 28-rollback loop in session 7471743d from a wrong class name.
    scopeDocument = researchReport
      ? `## SCOPE DOCUMENT\n\n⚠️ WARNING: SCOPER PRODUCED NO OUTPUT — THIS IS AN UNVERIFIED FALLBACK.\nAll class names, file paths, and line numbers below come from the Research Report and have NOT been confirmed against the actual codebase. Before generating subtasks:\n1. Treat every PHP class name as UNVERIFIED — add a REVIEW subtask to confirm each class exists with find_file or grep before any YAML writes.\n2. For SilverStripe extension classes: always use DNADesign\\Elemental\\* namespace, NEVER SilverStripe\\Elemental\\*.\n3. If a feature (e.g. Elemental extensions) appears in any _config YAML in the report, do NOT generate a subtask to re-add it — flag it as already present.\n\n${researchReport.slice(0, 3000)}`
      : "";
  }

  // Quality gate: a useful scope document must contain file paths and line numbers,
  // and must not be dominated by unverified ⚠️ [NOT FOUND] paths that will cause
  // the coder to make phantom edits on non-existent files.
  const hasLineRefs = /\blines?\s+\d+|\bline\s+\d+|:\d+\b/i.test(scopeDocument);
  // Include doc/config extensions - a scope for creating a new .md file is valid without code extensions.
  const hasFilePaths = /\.(php|js|ts|cs|py|rb|go|java|ss|yml|yaml|json|md|txt|rst|adoc|gd|tscn|tres)\b/i.test(scopeDocument);
  const isFallback = scopeDocument.includes("(Fallback - scoper produced no output)");
  const notFoundCount = (scopeDocument.match(/⚠️ \[NOT FOUND\]/g) || []).length;
  const tooManyNotFound = notFoundCount > 2;

  // Documentation-only tasks (create/write a .md, .txt, etc.) are valid without
  // line refs - there are no existing files to modify and no line numbers to cite.
  // Detect this by checking if all file references in the scope are doc extensions
  // and no code-file extensions appear (i.e. the whole task is "create new file").
  const hasCodeFilePaths = /\.(php|js|ts|cs|py|rb|go|java|ss|yml|yaml|json|gd|tscn|tres)\b/i.test(scopeDocument);
  const isDocOnlyScope = hasFilePaths && !hasCodeFilePaths;

  if (!isFallback && scopeDocument.trim().length > 100 && (!hasLineRefs || !hasFilePaths || tooManyNotFound) && !isDocOnlyScope) {
    log(colors.yellow(`  [Graph] -> Scoper output needs refinement (lineRefs:${hasLineRefs}, filePaths:${hasFilePaths}, notFound:${notFoundCount}) - re-prompting.`));

    const notFoundGuidance = notFoundCount > 0
      ? `\nYour scope document has ${notFoundCount} ⚠️ [NOT FOUND] path(s). For EVERY one:
1. Call find_file with just the filename (no directory prefix) to locate the real path
2. If found: replace the ⚠️ [NOT FOUND] entry with the confirmed path
3. If genuinely not found after 2 attempts: mark it "⚠️ [CONFIRMED NOT FOUND] - coder must skip"\n`
      : "";

    /** @type {import('ai').ModelMessage[]} */
    const refinementMessages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `ORIGINAL TASK:\n${userTask}\n\nRESEARCH REPORT (use as starting guide - verify everything with tools):\n${researchReport}`,
      },
      { role: "assistant", content: scopeDocument },
      {
        role: "user",
        content: `Your scope document is missing concrete details. For EVERY file listed, you must:
1. Read the file using read_file and find the EXACT line numbers that need to change
2. State the current code at those lines (a snippet or signature)
3. State what needs to change
${notFoundGuidance}
Re-output the complete SCOPE DOCUMENT with these line-level details filled in. Use read_file on each file before writing the updated scope.`,
      },
    ];

    let refinedDoc = "";

    if (state.model) {
      try {
        const { textStream: refineStream } = streamText({
          model: state.model,
          messages: refinementMessages,
          tools: /** @type {import('ai').ToolSet} */ (await getMcpBoundTools(context)),
          maxSteps: MAX_STEPS_SCOPER_REFINE,
          abortSignal: signal,
        });
        for await (const part of refineStream) {
          refinedDoc += part;
          eventBus.emit("message_chunk", { chunk: part });
        }
        eventBus.emit("message_complete", {});
      } catch (refineErr) {
        log(colors.yellow(`  [Graph] -> Scoper refinement failed (non-fatal): ${refineErr.message}`));
      }
    } else if (state.provider) {
      try {
        const refineResult = await state.provider.sendTurn(refinementMessages, "scoper-refine", context);
        refinedDoc = refineResult?.text ?? "";
        if (refinedDoc) eventBus.emit("message_complete", { text: refinedDoc });
      } catch (refineErr) {
        log(colors.yellow(`  [Graph] -> Scoper refinement failed (non-fatal): ${refineErr.message}`));
      }
    }

    // Only use refinement if it looks like an actual scope document —
    // minimum length AND contains file paths or line references. This prevents
    // a 73-char echo output ("Research complete. Handing off.") from being
    // accepted as a valid scope document after a bash-loop refinement pass.
    const refinedHasLineRefs = /\blines?\s+\d+|\bline\s+\d+|:\d+\b/i.test(refinedDoc);
    const refinedHasFilePaths = /\.(php|js|ts|cs|py|rb|go|java|ss|yml|yaml|json|md|txt|gd|tscn|tres)\b/i.test(refinedDoc);
    const refinedLooksValid = refinedDoc.trim().length > 200 && (refinedHasLineRefs || refinedHasFilePaths);
    if (refinedLooksValid) {
      log(colors.cyan("  [Graph] -> Scoper refinement produced output - using it."));
      scopeDocument = refinedDoc;
    } else if (refinedDoc.trim().length > 50) {
      log(colors.yellow("  [Graph] -> Scoper refinement output is too short or lacks file paths — keeping original scope (or falling back to research)."));
    } else {
      log(colors.yellow("  [Graph] -> Scoper refinement produced no output - keeping original."));
    }
  }

  log(colors.cyan(`  [Graph] -> Scope Document complete (${scopeDocument.length} chars).`));
  updateCheckpointState({ scopeDocument });

  return {
    scopeDocument,
    currentPersona: PERSONA.id,
    messages: [{ role: "assistant", content: scopeDocument }],
  };
}
