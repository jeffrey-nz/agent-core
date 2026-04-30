import { saveScopingState } from "./state.js";
import {
  handleScopeReview,
  promptUserForClarification,
} from "./interaction.js";
import { buildInitialScopingPrompt } from "./scopingPrompt.js";
import { buildFinalizePrompt } from "./buildScopingPrompt.js";
import { runScopingTurn } from "./scopingTurn.js";
import { enrichFromAnswer } from "./scopingResearch.js";

export async function runScopingLoop({
  provider,
  project,
  initialPrompt,
  sessionId,
  projectId,
  qaHistory,
  research,
  projectDir,
}) {
  const targetRepoDir = project?.targetRepoDir || projectDir || null;
  const history = [...qaHistory];

  let currentPrompt = buildInitialScopingPrompt({
    project,
    projectId,
    initialPrompt,
    qaHistory: history,
    research,
    projectType: research?.projectType || null,
  });

  let scopeDoc = null;
  // Track whether the user hit "Generate scope now" so that if the AI still
  // fails to produce a <scope_doc> we retry silently instead of presenting the
  // AI's confused output as another clarifying question.
  let finalizeRequested = false;
  let finalizeAttempts = 0;
  const MAX_FINALIZE_RETRIES = 2;

  for (let round = 0; round <= 6; round++) {
    const label =
      round === 0 ? "Scoping — Initial" : `Scoping — Round ${round}`;

    const { text, scopeDoc: parsedScope } = await runScopingTurn({
      provider,
      targetRepoDir,
      prompt: currentPrompt,
      label,
    });

    history.push({ role: "assistant", content: text });

    if (parsedScope) {
      scopeDoc = parsedScope;

      await saveScopingState(
        projectId,
        sessionId,
        initialPrompt,
        history,
        null,
      );

      const { approved, feedback } = await handleScopeReview(scopeDoc);

      if (approved) break;

      history.push({
        role: "user",
        content: `[Feedback on scope]: ${feedback}`,
      });

      currentPrompt = `The user reviewed the scope document and gave this feedback:\n\n"${feedback}"\n\nRevise and output the updated <scope_doc>.`;
      scopeDoc = null;
      finalizeRequested = false;
      finalizeAttempts = 0;
      continue;
    }

    // After "Generate scope now" the AI should have produced a <scope_doc>.
    // If it didn't, retry with a stronger explicit prompt rather than showing
    // the confused AI output as another clarifying question.
    if (finalizeRequested) {
      finalizeAttempts++;
      if (finalizeAttempts < MAX_FINALIZE_RETRIES) {
        currentPrompt = buildFinalizePrompt(initialPrompt, history);
        continue;
      }
      // Exhausted retries — fall through and ask the user what to do
      finalizeRequested = false;
    }

    await saveScopingState(projectId, sessionId, initialPrompt, history, null);

    const { answer, action } = await promptUserForClarification(
      text,
      round + 1,
    );

    let basePrompt = answer || "";

    if (action === "finalize") {
      finalizeRequested = true;
      finalizeAttempts = 0;
      // Build a substantive finalize prompt so the AI has full context,
      // not just an empty user turn with a cryptic [SYSTEM:] tag.
      currentPrompt = buildFinalizePrompt(initialPrompt, history, answer);
      history.push({ role: "user", content: basePrompt || "[Generate scope now]" });
      continue;
    }

    // Store the base answer (without enrichment) in history so resume prompts
    // stay clean; inject enrichment only into the live prompt for the next turn.
    history.push({ role: "user", content: basePrompt });

    let nextPrompt = basePrompt;

    // After each user answer, grep the project for terms mentioned in the answer
    // and inject that context so the next question is better targeted.
    if (targetRepoDir && answer) {
      const extra = await enrichFromAnswer(targetRepoDir, answer).catch(() => null);
      if (extra) {
        nextPrompt += `\n\n[FOLLOW-UP RESEARCH — files relevant to your answer]\n${extra}`;
      }
    }

    currentPrompt = nextPrompt;
  }

  return { scopeDoc, finalHistory: history };
}
