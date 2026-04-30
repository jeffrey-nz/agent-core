import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { getModifiedFileBlocks } from "../../utils/fileReader.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../../personas.js";

const MAX_FILE_REVIEW_CHARS = 12000;

/**
 * Factory that produces a LangGraph-compatible reviewer node function.
 *
 * All reviewer nodes share the same skeleton:
 *   1. Optional auto-pass check (avoids a provider call for trivially clear cases)
 *   2. Load modified file blocks
 *   3. Build a prompt string
 *   4. Call the provider
 *   5. Parse "VERDICT: FAIL" / "VERDICT: PASS"
 *   6. Return { reviews: { persona, status, feedback } }
 *
 * @param {object} opts
 * @param {string}   opts.persona        Human-readable reviewer name ("Security", "Requirements")
 * @param {string}   opts.personaKey       Key registered in personas.js ("securityReviewer")
 * @param {string}   opts.icon           Emoji prefix for log lines ("🕵️‍♂️")
 * @param {string}   opts.description    Short description for eventBus persona_change
 * @param {string}   opts.label          Phase label for eventBus phase_change ("Security Review")
 * @param {(state: object) => { pass: boolean, reason: string } | null} [opts.shouldAutoPass]
 *   Called before loading files. Return { pass: true, reason } to skip the provider call entirely.
 *   Return null to proceed with the normal review flow.
 * @param {(state: object, fileBlocks: string) => string} opts.buildPrompt
 *   Returns the full prompt string. Receives the state and the (possibly truncated) file content block.
 *
 * @returns {(state: object, config: object) => Promise<{ reviews: object }>}
 */
export function createReviewer({ persona, personaKey, icon, description, label, shouldAutoPass, buildPrompt }) {
  return async function reviewerNode(state, config) {
    log(colors.blue(`  [Graph] -> ${icon} ${persona} Reviewer inspecting code...`));
    const PERSONA = personaMeta(personaKey);
    eventBus.emit("persona_change", { ...PERSONA, description });
    eventBus.emit("phase_change", { phase: PERSONA.phase, label });

    // --- Auto-pass -----------------------------------------------------------
    const autoPass = shouldAutoPass?.(state);
    if (autoPass?.pass) {
      log(colors.green(`  [Graph] -> ${icon} ${persona} Reviewer: PASSED (${autoPass.reason})`));
      eventBus.emit("system_message", {
        text: `✓ ${label}: passed (${autoPass.reason})`,
        type: "info",
      });
      return {
        reviews: {
          persona,
          status: "PASS",
          feedback: `Auto-passed: ${autoPass.reason}`,
        },
      };
    }

    // --- Load files ----------------------------------------------------------
    const rawFileBlocks = await getModifiedFileBlocks(state.modifiedFiles, state.projectDir);
    const fileBlocks =
      rawFileBlocks.length > MAX_FILE_REVIEW_CHARS
        ? rawFileBlocks.slice(0, MAX_FILE_REVIEW_CHARS) + "\n...[truncated — file content too large for review]"
        : rawFileBlocks;

    // --- Call provider -------------------------------------------------------
    const prompt = buildPrompt(state, fileBlocks);
    const result = await state.provider.sendTurn(
      [{ role: "user", content: prompt }],
      `${personaKey}-turn`,
      { requireWriteFile: false, interactionMode: "scoping", signal: config?.signal ?? null },
    );

    const text = result.text ?? "";
    const status = text.includes("VERDICT: FAIL") ? "FAIL" : "PASS";

    if (status === "FAIL") {
      log(colors.red(`  [Graph] -> ${icon} ${persona} Reviewer: FAILED`));
      eventBus.emit("system_message", { text: `✗ ${label}: failed`, type: "warning" });

      // Post the review finding to the GitHub issue so it's visible outside the session.
      // This creates a visible reviewer→coder feedback thread on the issue timeline.
      if (state.githubOptions?.issueNumber) {
        try {
          const { writeReviewNote } = await import("#github/context.js");
          await writeReviewNote({
            client: state.githubOptions.client,
            owner: state.githubOptions.owner,
            repo: state.githubOptions.repo,
            issueNumber: state.githubOptions.issueNumber,
            persona,
            status,
            feedback: text,
          });
        } catch { /* non-fatal */ }
      }
    } else {
      log(colors.green(`  [Graph] -> ${icon} ${persona} Reviewer: PASSED`));
      eventBus.emit("system_message", { text: `✓ ${label}: passed`, type: "info" });
    }

    return { reviews: { persona, status, feedback: text } };
  };
}
