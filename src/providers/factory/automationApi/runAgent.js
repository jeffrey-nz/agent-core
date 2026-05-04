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
    send: async (sid, text, lbl) => {
      const result = await sendRemoteTurn(sid, text, lbl, signal);
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
