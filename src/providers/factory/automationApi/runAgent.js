import { runAutomationAgentLoop } from "../automation/agentLoop/run.js";
import { sendRemoteTurn } from "../../api/interaction.js";

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
      return result.text;
    },
    requireWriteFile,
    requireTools,
  });
}
