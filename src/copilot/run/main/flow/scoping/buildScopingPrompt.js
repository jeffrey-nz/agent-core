export function buildScopingInitialMessage({
  projectTitle,
  targetRepoDir,
  initialPrompt,
  research,
  projectType = null,
}) {
  const scopeCtx = targetRepoDir
    ? `The project lives at: ${targetRepoDir}`
    : "";

  const researchBlock = research ? buildResearchBlock(research) : "";
  const projectTypeHint = buildProjectTypeHint(projectType);

  return `[SCOPING ASSISTANT - REQUIREMENTS GATHERING]
Project: "${projectTitle}".
${scopeCtx}
${researchBlock}
Your job is to turn the user's high-level description into a precise, actionable scope document.
${projectTypeHint}
Rules:
- Use the PROJECT RESEARCH above to ground your questions - reference actual file names, class names, or paths when you know them.
- Do NOT ask about things already evident from the research (framework type, file locations, project structure).
- CRITICAL: The PROJECT RESEARCH block already contains file locations, framework type, and project structure. Do NOT ask about these. Ask ONLY about ambiguous business logic, missing requirements, or edge cases that cannot be determined from the code.
- Ask ONE focused clarifying question at a time. Keep it concise.
- Ask no more than 6 questions total.
- STOP EARLY and output the <scope_doc> IMMEDIATELY once you clearly understand the goal, what needs to be changed, and the definition of done. Do not ask unnecessary questions if the requirements are clear.
- Uncover: what exactly changes, any constraints or non-goals, definition of done.
- When you are ready, output a scope document inside <scope_doc> tags:

<scope_doc>
## Goal
[One-sentence summary]

## What to build / change
[Concrete, numbered list]

## Out of scope
[What NOT to do]

## Definition of done
[How we know it's complete]
</scope_doc>

[USER'S INITIAL DESCRIPTION]
${initialPrompt.trim()}

Begin by either asking your first clarifying question, or if the initial description is detailed enough, output the <scope_doc> now.`;
}

function buildProjectTypeHint(projectType) {
  if (projectType === "unity") {
    return `\n⚠️ UNITY PROJECT — IMPORTANT SCOPING RULES:\n- Unity is a game engine. There is NO HTTP server and NO web endpoints.\n- Definition of done MUST use Unity batchmode test runner evidence (execute_bash + editmode_results.xml), NOT http_request.\n- NEVER write "HTTP request" or "http_request" in the Definition of done for a Unity project.\n- Verification examples: "Unity EditMode test confirms X", "execute_bash Unity batchmode exits 0 and editmode_results.xml shows test-case result=Passed".\n`;
  }
  if (projectType === "swift") {
    return `\n⚠️ SWIFT/iOS PROJECT — IMPORTANT SCOPING RULES:\n- This is a native iOS/macOS app. There is NO HTTP server and NO web endpoints.\n- Definition of done MUST use swiftc type-check and grep evidence, NOT http_request.\n`;
  }
  return "";
}

function buildResearchBlock(research) {
  const parts = ["[PROJECT RESEARCH - the AI has already explored the codebase; use this before asking questions]"];

  if (research.report) {
    // AI-generated report: rich, file-specific, based on actual tool use.
    // Prefer this over the static snapshot when available.
    // Cap at 5000 chars - scoping doesn't need the full investigation guide.
    parts.push(research.report.slice(0, 5000));
  } else {
    // Static fallback: project type + file tree only.
    // NOTE: research.constraints is intentionally excluded - it contains long
    // researcher/coder investigation guides (injector debugging steps, template
    // crash protocols, etc.) that are irrelevant to requirements gathering and
    // make the scoping prompt large enough to stall Copilot365.
    if (research.projectType) parts.push(`Project type: ${research.projectType}`);
    if (research.fileSnapshot) parts.push(`\nFile structure:\n${research.fileSnapshot}`);
    if (research.contextFiles) parts.push(`\nProject context:\n${research.contextFiles.slice(0, 2000)}`);
  }

  parts.push("[END PROJECT RESEARCH]");
  return "\n" + parts.join("\n\n") + "\n";
}

// Strip injected context blocks (e.g. [PAGE CONTEXT]...[END PAGE CONTEXT])
// from a prompt string so resumes stay clean and don't confuse the AI.
function stripContextBlocks(text) {
  return text
    .replace(/\[PAGE CONTEXT\][\s\S]*?\[END PAGE CONTEXT\]/gi, "")
    .replace(/\[FOLLOW-UP RESEARCH[^\]]*\][\s\S]*?(?=\n\n|\n$|$)/g, "")
    .trim();
}

export function buildScopingResumeMessage({
  projectTitle,
  targetRepoDir,
  initialPrompt,
  qaHistory,
}) {
  const scopeCtx = targetRepoDir
    ? `The project lives at: ${targetRepoDir}`
    : "";

  // Strip injected blocks from the initial prompt (page context, follow-up
  // research snippets) - these are one-shot aids for the live turn and
  // shouldn't pollute the resume conversation.
  const cleanInitialPrompt = stripContextBlocks(initialPrompt);

  // Filter out empty/stalled turns so a previous stall doesn't cause another.
  const validHistory = qaHistory.filter((m) => m.content?.trim());

  const historyText = validHistory
    .map(
      (m) => `${m.role === "assistant" ? "Assistant" : "Human"}: ${m.content}`,
    )
    .join("\n\n");

  return `[SCOPING ASSISTANT - RESUMING SESSION]
Project: "${projectTitle}".
${scopeCtx}

We are resuming a requirements-gathering session. Continue from where we left off.

Rules (same as before):
- Ask ONE clarifying question at a time.
- Max 6 questions total (count questions already asked).
- STOP EARLY and output the <scope_doc> IMMEDIATELY once you clearly understand the requirements.

[CONVERSATION SO FAR]
Human: ${cleanInitialPrompt}

${historyText}

Continue now - either ask your next question or produce the <scope_doc> if you have enough information.`;
}

/**
 * Builds the prompt used when the user clicks "Generate scope now".
 * Includes the original task so the AI has full context - not just a bare
 * system tag - and gives an explicit structure to follow.
 */
export function buildFinalizePrompt(initialPrompt, history = [], lastAnswer = "") {
  const answerLine = lastAnswer?.trim()
    ? `\nUser's final input: "${lastAnswer.trim()}"\n`
    : "";

  // Summarise the Q&A so far so the AI can write an accurate scope doc even
  // in a fresh browser session where conversation history may be limited.
  const qaLines = [];
  for (let i = 0; i < history.length - 1; i += 2) {
    const q = history[i];
    const a = history[i + 1];
    if (q?.role === "assistant" && a?.role === "user" && a.content?.trim()) {
      qaLines.push(`Q: ${q.content.trim().slice(0, 200)}`);
      qaLines.push(`A: ${a.content.trim().slice(0, 200)}`);
    }
  }
  const qaSummary = qaLines.length > 0
    ? `\n[Q&A SO FAR]\n${qaLines.join("\n")}\n`
    : "";

  return `The user has finished answering questions. Write the scope document now.

[ORIGINAL TASK]
${initialPrompt.trim().slice(0, 800)}
${qaSummary}${answerLine}
Output the complete scope document inside <scope_doc> tags using this format:

<scope_doc>
## Goal
[One-sentence summary of what this task achieves]

## What to build / change
[Numbered, concrete list of changes]

## Out of scope
[What NOT to do]

## Definition of done
[How we verify the task is complete]
</scope_doc>

Output the <scope_doc> now. Do not ask further questions.`;
}
