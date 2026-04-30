import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function handleNoActivity(state) {
  if (state.madeProgress) {
    // Distinguish between normal completion (AI wrote a non-empty summary after
    // finishing tool work) and a context-window overflow (Copilot returned a
    // genuinely empty string because the chat grew too large).
    const isEmpty = !state.responseText || !state.responseText.trim();
    if (isEmpty) {
      // Empty response after tool execution — context overflow signature.
      // Signal rotation so the session is reset and the subtask retried cleanly.
      log(
        colors.yellow(
          "  [Protocol] Empty response after tool execution — chat context likely overflowed. Signalling rotation.",
        ),
      );
      state.needsRotation = true;
      state.aborted = true;
      return false;
    }

    // Non-empty summary with no further tool calls — normal task completion.
    log(colors.dim("  [Protocol] No activity, but progress already recorded."));
    return false;
  }

  state.consecutiveNoActivity++;

  if (state.consecutiveNoActivity >= 3) {
    log(
      colors.red(
        "\n[Automation API] Aborting — tools unavailable or invalid output detected.",
      ),
    );

    state.responseText =
      "Planning complete. Tool execution unavailable. Ready for handoff.";
    state.aborted = true;
    return false;
  }

  return true;
}
