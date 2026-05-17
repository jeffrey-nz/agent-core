import { runAutomationAgentLoop } from "../automation/agentLoop/run.js";
import { sendRemoteTurn } from "../../api/interaction.js";
import { eventBus } from "#web/eventBus.js";
import { ROTATION_THRESHOLDS } from "../segmentBoundary.js";

export async function runAutomationAgent({
  state,
  rootDir,
  toolContext,
  label,
  initialResponseText,
  requireWriteFile,
  requireTools = false,
  signal = null,
}) {
  return runAutomationAgentLoop({
    remoteSessionId: state.remoteSessionId,
    rootDir,
    toolContext,
    label,
    initialResponseText,
    providerName: state.providerName ?? null,
    send: async (sid, text, lbl) => {
      // Inner turns (tool results, corrections, nudges) don't need the FORMAT REQUIREMENT
      // prepended — DeepSeek already has context from the initial turn, and prepending it
      // causes DeepSeek to echo the example write_file back instead of continuing normally.
      const isInnerTurn = /\[(tools|placeholder-path|correction|nudge|parse-error|read-loop|build-loop|task-done|notools|diagnostics)\s*\d*/i.test(lbl ?? "");
      const result = await sendRemoteTurn(sid, text, lbl, signal, { projectDir: rootDir ?? null, skipConstraint: isInnerTurn });
      state.messageCount = result.messageCount ?? state.messageCount ?? 0;
      const threshold = ROTATION_THRESHOLDS[state.providerName] ?? null;
      eventBus.emit("browser_context_update", {
        messageCount: state.messageCount,
        threshold,
        segmentIndex: state.segmentIndex ?? 0,
        providerName: state.providerName,
      });
      return result.text;
    },
    requireWriteFile,
    requireTools,
  });
}
