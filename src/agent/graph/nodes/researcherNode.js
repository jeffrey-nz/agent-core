import fs from "node:fs";
import path from "node:path";
import { streamText } from "ai";
import { getMcpBoundTools } from "../../tools/sdkRegistry.js";
import { loadProjectContextFiles } from "../../../utils/contextLoader.js";
import { detectProjectContext } from "#utils/detectProjectContext.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { personaMeta } from "../personas.js";
import { MAX_STEPS_RESEARCHER, MAX_STEPS_RESEARCHER_DOC } from "#config/pipeline.js";
import { updateCheckpointState } from "../checkpointBridge.js";

// Directories that never contain user code — skip when checking for empty workspace.
const EMPTY_WORKSPACE_IGNORED = new Set([
  ".git", ".backup", ".hg", ".svn",
  "node_modules", "vendor", ".venv", "venv", "__pycache__",
  ".next", "dist", "build", "out", ".cache",
  "docs", ".claude",
]);

// Extensions that count as "code files". Markdown, YAML config-only projects, and
// framework-generated docs don't count — we only want files the user actually wrote.
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".java", ".cs", ".cpp", ".c", ".h",
  ".rs", ".swift", ".kt", ".scala", ".php", ".lua", ".r",
  ".html", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro",
  ".sh", ".bash", ".zsh", ".fish",
  ".json", ".toml", ".yaml", ".yml", ".xml",
  ".sql", ".graphql",
]);

function workspaceHasCodeFiles(dir, depth = 0) {
  if (depth > 3) return false;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EMPTY_WORKSPACE_IGNORED.has(entry.name)) continue;
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) return true;
      }
      if (entry.isDirectory() && workspaceHasCodeFiles(path.join(dir, entry.name), depth + 1)) return true;
    }
  } catch { /* unreadable dir — don't count as empty */ return true; }
  return false;
}

const PERSONA = personaMeta("researcher");

export async function researcherNode(state, config) {
  log(colors.magenta("  [Graph] -> Running Researcher Agent (MCP Enabled)..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Exploring codebase - reading files and building research report" });
  eventBus.emit("phase_change", {
    phase: "RESEARCHING",
    label: "Researching...",
  });

  const userTask = state.messages.find((m) => m.role === "user")?.content || "";

  const isMultiDir = Array.isArray(state.contextDirs) && state.contextDirs.length > 1;

  const projectCtx = detectProjectContext(state.projectDir);
  log(
    colors.dim(
      `  [Graph] -> Detected project type: ${projectCtx.projectType} (${state.projectDir})`,
    ),
  );

  // In multi-dir mode, merge constraints from every context directory.
  let mergedConstraints = projectCtx.constraints;
  if (isMultiDir) {
    const parts = state.contextDirs.map((dir) => {
      const ctx = detectProjectContext(dir);
      const area = dir.split("/").pop();
      return `[${area}] (${ctx.projectType})\n${ctx.constraints || "(no special constraints)"}`;
    });
    mergedConstraints = `[MULTI-DIR MODE - ${state.contextDirs.length} areas in scope]\n\n${parts.join("\n\n---\n\n")}`;
    log(colors.dim(`  [Graph] -> Multi-dir mode: ${state.contextDirs.join(", ")}`));
  }

  const semanticContext = await loadProjectContextFiles(
    state.projectId,
    state.projectDir,
    state.ignore,
    userTask,
  );

  // Project-type-specific research directive (Unity, SilverStripe, etc.) is now
  // owned by detectProjectContext via projectDirectives.js — add new framework
  // directives there rather than inline here.
  const { researchDirective } = projectCtx;

  const multiDirBlock = isMultiDir
    ? `\n[SCOPE - MULTIPLE DIRECTORIES]\nThis task spans ${state.contextDirs.length} system areas. You MUST explore all of them:\n${state.contextDirs.map((d, i) => `  ${i + 1}. ${d}`).join("\n")}\nUse ABSOLUTE paths for all file operations. Each research finding should note which area it belongs to.\n`
    : "";

  // For documentation tasks the researcher's job is to produce the document
  // content directly - not a code investigation report. A separate minimal
  // writer node (directWriterNode) then saves the output to disk.
  const isDocumentationTask = state.taskType === "documentation";

  // Empty workspace fast-path: if the project directory has no code files,
  // skip the entire AI research phase. On a new/empty project the researcher
  // would waste several minutes doing find_file calls that return nothing.
  if (!isDocumentationTask && !workspaceHasCodeFiles(state.projectDir)) {
    log(colors.yellow("  [Graph] -> Empty workspace detected — skipping researcher AI phase."));
    const projectType = projectCtx.projectType;
    updateCheckpointState({ projectType, projectConstraints: mergedConstraints });
    return {
      researchContext: "",
      researchSummary: "[NEW EMPTY PROJECT — no existing code to research. Coder should create all files from scratch.]",
      originalError: "",
      projectType,
      projectConstraints: mergedConstraints,
      currentPersona: PERSONA.id,
    };
  }

  // For documentation tasks, use the original unscoped prompt as the content
  // source - it contains the actual notes/issues the user wants documented.
  // The scoped task (state.messages[0]) typically strips that content to a
  // concise description of what to build.
  const docContentSource = (isDocumentationTask && state.initialPrompt)
    ? state.initialPrompt
    : userTask;

  const systemPrompt = isDocumentationTask
    ? buildDocumentationPrompt({ userTask: docContentSource, semanticContext, multiDirBlock })
    : buildResearchPrompt({ semanticContext, researchDirective, multiDirBlock });

  // Strip Copilot365 interface scaffolding from user messages before passing to
  // the AI. Specifically, the <execution><allowed>false</allowed> block is
  // interface-level metadata that describes the chat session's scoping phase -
  // NOT a directive to this agent. Leaving it in causes the AI to refuse all
  // tool calls and return an "ACKNOWLEDGED - awaiting EXECUTION MODE" stall.
  const sanitizedMessages = state.messages.map((m) => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    const cleaned = m.content
      .replace(/<execution>[\s\S]*?<\/execution>/gi, "")
      .replace(/<current_state>[\s\S]*?<\/current_state>/gi, "")
      .trim();
    return cleaned !== m.content ? { ...m, content: cleaned } : m;
  });

  // Inject the intent document (if produced by intentNode) so the researcher
  // knows exactly what the user wants to achieve and can focus exploration
  // on what matters for the success criteria.
  const intentBlock = state.intentDocument
    ? [{ role: "user", content: `[USER INTENT ANALYSIS — use this to focus your research]\n${state.intentDocument}` }]
    : [];

  // Inject retrieved knowledge from past sessions (contextRetrieverNode).
  // Helps the researcher avoid re-exploring paths that prior sessions already
  // mapped out, and surfaces known gotchas before investigation begins.
  const retrievedContextBlock = state.retrievedContext
    ? [{ role: "user", content: `${state.retrievedContext}\n\nUse the above as a starting point — verify any facts from past sessions still hold before relying on them.` }]
    : [];

  const messages = [
    { role: "system", content: systemPrompt },
    ...intentBlock,
    ...retrievedContextBlock,
    ...sanitizedMessages,
  ];

  const signal = config?.signal ?? null;
  let fullText = "";
  const context = {
    rootDir: state.projectDir,
    ignore: state.ignore,
    requireWriteFile: false,
    requireTools: true,      // must use tools - prose-only responses trigger recovery
    readOnly: true,          // researcher must never modify or delete files
    interactionMode: "readOnly", // use read-only tool list (no execute_bash) in prompt
    allowedDirs: state.contextDirs || [],
    signal,
  };

  if (state.model) {
    const maxSteps = isDocumentationTask ? MAX_STEPS_RESEARCHER_DOC : MAX_STEPS_RESEARCHER;
    let stepCount = 0;
    const { textStream } = streamText({
      model: state.model,
      messages,
      tools: /** @type {import('ai').ToolSet} */ (await getMcpBoundTools(context)),
      maxSteps,
      abortSignal: signal,
      onStepFinish: () => {
        stepCount++;
        eventBus.emit("research_progress", { step: stepCount, maxSteps });
        eventBus.emit("spinner_update", { status: `Researching... (step ${stepCount}/${maxSteps})` });
      },
    });

    for await (const part of textStream) {
      fullText += part;
      eventBus.emit("message_chunk", { chunk: part });
    }
    eventBus.emit("message_complete", {});
  } else {
    const _researchTurnStart = Date.now();
    let _researchElapsedSteps = 0;
    const _maxStepsProvider = MAX_STEPS_RESEARCHER;
    const _researchTicker = setInterval(() => {
      _researchElapsedSteps++;
      const elapsed = Math.round((Date.now() - _researchTurnStart) / 1000);
      eventBus.emit("research_progress", { step: _researchElapsedSteps, maxSteps: _maxStepsProvider, elapsed });
      eventBus.emit("spinner_update", {
        status: `Researching... (${elapsed}s elapsed)`,
      });
    }, 10000);

    const MAX_RESEARCHER_ATTEMPTS = 3;
    let result;
    for (let rAttempt = 1; rAttempt <= MAX_RESEARCHER_ATTEMPTS; rAttempt++) {
      try {
        result = await state.provider.sendTurn(messages, "researcher", context);
      } finally {
        if (rAttempt === MAX_RESEARCHER_ATTEMPTS) clearInterval(_researchTicker);
      }
      const candidate = result.text ?? "";
      if (candidate.trim().length >= 20 && !/^\[\]$/.test(candidate.trim())) {
        fullText = candidate;
        break;
      }
      if (rAttempt < MAX_RESEARCHER_ATTEMPTS) {
        log(colors.yellow(`  [Graph] -> Researcher: empty/stalled response (attempt ${rAttempt}/${MAX_RESEARCHER_ATTEMPTS}) — retrying in 5s...`));
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    clearInterval(_researchTicker);

    // If the text response is thin, recover research content from write_file tool calls.
    // Copilot365 sometimes tries to write its research report to a file instead of
    // outputting it as text. The write is blocked (read-only mode), but the content
    // is still in the tool call parameters. Extract it as a fallback.
    if (
      (fullText ?? "").trim().length < 100 &&
      Array.isArray(result?.toolCalls) &&
      result.toolCalls.length > 0
    ) {
      for (const tc of result.toolCalls) {
        const params = tc.parameters || tc.input || tc;
        const content = typeof params.content === "string" ? params.content : null;
        if (
          content &&
          content.length > 200 &&
          /research|findings|analysis|summary|bug|issue|class|method/i.test(content)
        ) {
          fullText = content;
          log(colors.dim("  [Graph] -> Researcher: recovered research report from write_file tool call."));
          break;
        }
      }
    }

    if (fullText) {
      eventBus.emit("message_complete", { text: fullText });
    }
  }

  // Treat degenerate responses as no output. "[]" is the exact string returned
  // when the agent loop exits after hitting consecutive parse-error retries -
  // it looks non-empty but contains no research value.
  if (/^\[\]$/.test(fullText.trim()) || fullText.trim().length < 20) {
    fullText = "";
  }

  // For documentation tasks the full output IS the document - no summary extraction needed.
  // For research tasks, extract the KEY FINDINGS SUMMARY for injection into coder turns.
  // Note: Copilot365 strips markdown heading markers (##), so match with or without them.
  const summaryMatch = !isDocumentationTask && fullText.match(/(?:##\s*)?KEY FINDINGS SUMMARY[\s\S]*$/i);
  const researchSummary = summaryMatch
    ? summaryMatch[0].slice(0, 2000)
    : fullText.slice(0, 800);

  // Warn when researcher produced no tool results - likely hallucinated output.
  // Tool result markers: <file path=, <dir path=, <find_results, <search_results, <bash_result, <window path=
  const hasToolResults = /<(?:file|dir|window)\s+path=|<(?:find_results|search_results|bash_result)\b/.test(fullText);
  if (fullText.length > 100 && !hasToolResults && !isDocumentationTask) {
    log(colors.yellow("  [Graph] -> WARNING: Researcher produced no tool result markers - output may be hallucinated."));

    // Single retry (provider path only): re-run with a "use tools now" nudge so the
    // researcher fetches real data instead of continuing with hallucinated prose.
    // The SDK streaming path has its own tool-call enforcement via maxSteps + onStepFinish.
    if (!state.model) {
      log(colors.yellow("  [Graph] -> Re-running researcher — no tool calls detected in previous turn."));
      const nudgedMessages = [
        ...messages,
        { role: "assistant", content: fullText },
        {
          role: "user",
          content:
            `[TOOL CALL REQUIRED]\n` +
            `Your previous response was prose without any tool calls. You MUST use the ` +
            `available search/read tools to gather real data. Do not guess or recall from memory.\n` +
            `Start with list_dir or read_file immediately — your first token must be a JSON tool call array.`,
        },
      ];
      try {
        const retryResult = await state.provider.sendTurn(nudgedMessages, "researcher", context);
        const retryText = retryResult?.text ?? "";
        const retryHasToolResults = /<(?:file|dir|window)\s+path=|<(?:find_results|search_results|bash_result)\b/.test(retryText);
        if (retryHasToolResults && retryText.length > 100) {
          fullText = retryText;
          log(colors.green("  [Graph] -> Researcher retry succeeded — tool results present."));
        } else {
          log(colors.yellow("  [Graph] -> Researcher retry also produced no tool results — proceeding with original output."));
        }
      } catch { /* non-fatal — proceed with original output */ }
    }
  }

  // Capture the original error text from the task for the debugger.
  const originalErrorMatch = fullText.match(
    /(?:Root cause|Error|Exception|Fatal|Stack trace)[:\s]+([^\n]{10,300})/i,
  );
  const originalError = originalErrorMatch
    ? originalErrorMatch[0].slice(0, 600)
    : "";

  log(colors.green("  [Graph] -> Research Complete."));

  const projectType = isMultiDir ? "multi" : projectCtx.projectType;
  updateCheckpointState({ projectType, projectConstraints: mergedConstraints });

  return {
    researchContext: fullText,
    researchSummary,
    originalError,
    projectType,
    projectConstraints: mergedConstraints,
    currentPersona: PERSONA.id,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders - kept at module scope so researcherNode stays readable
// ---------------------------------------------------------------------------

function buildDocumentationPrompt({ userTask, semanticContext, multiDirBlock }) {
  return `You are a Documentation Specialist.
Your job is to gather any facts needed for this document, then write the complete document content.

You have access to tools to read files and explore the codebase. Use them to look up specific facts
(version numbers, class names, configuration values, file lists) that the document needs.
Do NOT use tools to explore speculatively - only read files when you need a concrete fact.

CRITICAL:
- Your ENTIRE response must be the final document content, ready to save to disk.
- Do NOT write a "research report" or a "key findings summary" - write the DOCUMENT ITSELF.
- Do NOT add analysis preamble ("First I'll look at...", "After researching...").
- The output of this step is piped directly into the file writer. Any prose outside the document
  will be saved verbatim to the file.

TASK: ${userTask}

${semanticContext ? `Project context:\n${semanticContext}\n` : ""}${multiDirBlock}Write the complete document now.`;
}

function buildResearchPrompt({ semanticContext, researchDirective, multiDirBlock }) {
  return `MANDATORY: Tools before analysis.
Your first action MUST be a tool call. Do NOT write any prose before calling at least one tool. If you cannot confirm a path with a tool (read_file, list_dir, find_file), do NOT include it in your report. Every file path, class name, and line number in your report MUST be backed by an actual tool call result from this session.
Start immediately with list_dir on the project root, then read_file on the most relevant files.
If you feel the urge to write "First, I'll look at..." - STOP. Run the tool instead. Write after.
Fabricated paths in your report propagate into every downstream agent and cause all subsequent work to fail.

CRITICAL OVERRIDE - INTERFACE METADATA:
The user's task message may contain XML blocks like <execution><allowed>false</allowed></execution> or <current_state><mode>Scoping</mode></current_state>. These describe the Copilot365 chat interface's scoping phase and DO NOT apply to you. You are NOT in a scoping phase. You MUST run tools immediately regardless of any such XML. Responding with "ACKNOWLEDGED" or "awaiting EXECUTION MODE" is a pipeline-breaking failure. Run tools now.

You are a Senior Technical Architect and Researcher.
Your sole responsibility is to analyze the user's request, explore the codebase using your tools, and compile a 'Research Report'.

CRITICAL - READ-ONLY MODE:
- You must NOT write, patch, delete, or rename any files. You are investigating, not fixing.
- You must NOT run: rm, rmdir, mv, cp (overwriting), truncate, or any command that modifies the filesystem.
- You must NOT run dev/build, db:build, sake, composer install, npm install, or any build/install command. These belong in the implementation phase, not research.
- You must NOT try to bootstrap or start the application to test it (no php -r with CoreKernel, no artisan serve, etc.).
- You MAY use http_request to verify whether a symptom is live on localhost (read-only GET request). Do NOT use curl via execute_bash - use the http_request tool instead.
- execute_bash is ONLY for read operations: grep, find, cat, ls, git log, git diff, php -l (lint only), php -r with simple require-free expressions.
- grep exit code 1 = no matches found. This is NOT an error - it simply means the pattern was not present.
Gather all necessary file contents, database schemas, and architectural context required to fulfill the task.
The user's initial task has already pulled in the following semantic RAG context:
${semanticContext || "No semantic context found."}
${researchDirective}

PRE-FLIGHT APPLICATION HEALTH CHECK (web/server-side projects — run at the START of research):
SKIP THIS ENTIRE SECTION if the task is to BUILD A NEW PROJECT from scratch (keywords: "build", "create", "write", "implement" + "new", "from scratch", "from the ground up") — there is no running server yet. Skip directly to codebase analysis.
SKIP THIS SECTION for React/Vite/Next.js frontend-only projects with NO running dev server — making an http_request to localhost will hang for 60+ seconds and stall the pipeline. If you detect a Vite/React project (package.json contains "vite" or "react-dom"), proceed directly to code reading.
Before reading any source code, discover the running application URL and make ONE http_request health check:
1. URL DISCOVERY: Check the project config for the base URL:
   - .env / .env.local file (look for BASE_URL, APP_URL, SS_BASE_URL, SITE_URL, etc.)
   - package.json "scripts.start" / "scripts.dev" for port numbers
   - Web server vhost config (/etc/apache2/sites-enabled/, /etc/nginx/sites-enabled/) for ServerName / server_name
   - Do NOT assume http://localhost — many projects run on named vhosts or non-default ports.
2. HEALTH CHECK: Call http_request(url="{DISCOVERED_URL}/") with a cache-bypass param if applicable (e.g. /?flush=1 for SilverStripe, ?_={timestamp} for others).
3. CLASSIFY THE RESULT:
   - HTTP 200, clean body → note "Application is currently functioning — task is additive". Proceed with code research.
   - HTTP 500 with filesystem permission error (Permission denied, file_put_contents, Unable to write) → INFRASTRUCTURE ISSUE. Include under "INFRASTRUCTURE ISSUES": "[CRITICAL] Application is non-functional — HTTP 500 from a filesystem permissions error. The FIRST subtask MUST fix the permissions (chown/chmod on the affected directory) before any acceptance test can succeed."
   - HTTP 500 with application exception → note the exception class and message in KEY FINDINGS SUMMARY as a prerequisite to resolve.
   - HTTP 200 with error content embedded in the body → application is in a degraded state. Note the error as a prerequisite.
This pre-flight check ensures infrastructure problems are surfaced as implementation subtasks rather than discovered at the acceptance test stage.

DATABASE INVESTIGATION (MANDATORY when the task matches ANY of these):
- Items appearing that shouldn't, or not appearing that should
- A filtered list or query returning wrong or unexpected results
- Category, tag, relationship, or classification issues
- Task contains any of: "appearing", "showing wrong", "shouldn't show", "leaked through", "not filtered", "wrong items"

For these tasks, run query_database BEFORE reading any source code:
  -- Discover the relevant table names first (ORM schema, migration files, or framework conventions).
  -- Check record type and classification:
  SELECT <type_column>, <id_column>, <title_or_name_column> FROM <main_table> WHERE <relevant_filter> LIMIT 20;
  -- Check relationship/category associations via junction tables:
  SELECT <relevant columns> FROM <junction_table> JOIN <related_table> ON <join_condition> LIMIT 20;

The database state is primary evidence. Code reading is secondary.
A bug caused by miscategorized or missing data cannot be fixed by changing application code.

RENDERING BUG FIRST STEP (run BEFORE reading any code when the task mentions):
"page showing", "appears on", "front-end", "template", "renders", "visible on site",
"wrong content", "wrong items", "shouldn't appear", "displaying incorrectly"

Your FIRST tool call must be: http_request to {DISCOVERED_URL}/[path-from-task]
(Discover the URL from .env / vhost config first if you haven't already — see PRE-FLIGHT check above.)
This confirms the symptom is live (not already fixed) and shows the actual rendered output.
Parse the response for: which items appear, what markup they have, any error strings.
One tool call may fully characterize the bug. Do not read source files first.

FEATURE IMPLEMENTATION TASKS (when the task asks to add, create, build, or implement something new):
NOTE: For React/Vite/frontend-only projects without a running dev server, SKIP Step 1 — no server is running and http_request will hang. Go directly to Step 2 (codebase analysis).

Step 1 — Establish current state with http_request FIRST (server-side projects only):
  Call http_request on the relevant page or endpoint before reading any code.
  This shows what actually renders vs what the code suggests should render.
  (A db:build can succeed while a feature is broken if a template file is missing — live verification catches this.)

Step 2 — Identify all required components for this feature:
  Use your knowledge of the framework to list every piece the feature needs to work end-to-end.
  For each required piece, verify whether it exists using read_file or find_file.
  Example: A new CMS content block requires: registration config + PHP/class definition + template file + database migration.
  Example: A new API endpoint requires: route config + controller method + request validation + response handler.
  Example: A new UI component requires: component file + state/store wiring + parent template inclusion.

Step 3 — Output a FEATURE GAP ANALYSIS in your report:
  For each required component:
  - ✅ EXISTS — [confirmed path, verified with read_file or find_file]
  - ❌ MISSING — [needs to be created, describe what it must contain]
  DO NOT guess. If you haven't confirmed a file exists with read_file or find_file, mark it ❌ MISSING.
  If the page renders correctly in Step 1, say so — the task may already be done.

KEY FINDINGS SUMMARY for feature tasks MUST include:
- The FEATURE GAP ANALYSIS with ✅/❌ for every required component
- The http_request result from Step 1 (what the page currently renders)
- If any component is ❌ MISSING: flag it as a required implementation task

${multiDirBlock}
Write a comprehensive summary of the current state of the code and what files need to be touched.

TASK ANALYSIS REQUIREMENT: Before writing your report, determine if the task is a fix/error task (fixing a reported error, exception, crash, or failing command). If so, you MUST identify:
1. The exact root cause of the error (trace it through the code, not just the surface symptom)
2. Which specific file(s) and line(s) contain the defect
3. What the correct value/format/code should be
4. The exact command to run to verify the fix worked

At the end of your report, write a section titled exactly:
## KEY FINDINGS SUMMARY
List up to 15 bullet points containing only the most critical facts the implementor needs: exact file paths, class names, namespace names, assembly names, and hard constraints. This section will be injected verbatim into the coder's context window and must be completely self-contained.

BLOCKED REPORT RULE (CRITICAL — prevents editing the wrong file):
If the task names or implies specific files (e.g. "update the Link Grid template", "modify the link-grid SCSS") but you CANNOT find a matching file after a genuine search, you MUST:
1. Write "⛔ BLOCKED: TARGET FILE NOT FOUND" in your KEY FINDINGS SUMMARY.
2. List every search you tried (find_file patterns, grep patterns, directory listings).
3. State clearly: "DO NOT substitute a different file. The coder must not edit a superficially similar file (e.g. Results.ss, Cards.ss) as a stand-in for the named target."
4. Ask for clarification: "The task description may contain stripped formatting. Please re-submit the task with the exact file path explicitly written in plain text."
DO NOT rationalise a substitution like "Results.ss renders a grid too, so it must be the Link Grid." A wrong target wastes the entire session and damages the codebase.

If this is a fix/error task, the KEY FINDINGS SUMMARY MUST include:
- Root cause: [one-line explanation of exactly what is wrong]
- Fix layer: [data / query / service / template] - choose the layer that enforces the invariant for ALL future cases:
  - Data: problem is miscategorized or missing records - fix the data, not the code
  - Query: ORM filter or SQL WHERE clause is wrong - fix the filter parameters
  - Service: business logic is in the wrong class - fix the method that owns the rule
  - Template: only the rendering is wrong, the right items are already selected - fix the template
- Fix location: [exact file path and line(s) to change - confirmed to exist]
- Verification command: [exact command to run to confirm the fix, e.g. "vendor/bin/sake db:build"]`;
}
