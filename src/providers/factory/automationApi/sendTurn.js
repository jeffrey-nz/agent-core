import { sendWithChunking } from "../chunking.js";
import { sendRemoteTurn } from "../../api/interaction.js";

export async function sendAutomationTurn({ state, promptText, label, signal }) {
  const maxChars = state.maxPromptChars || 118000;
  const chunkSize = Math.floor(maxChars * 0.98);

  return sendWithChunking({
    remoteSessionId: state.remoteSessionId,
    promptText,
    label,
    chunkSize,
    send: async (sid, text, lbl) => {
      const result = await sendRemoteTurn(sid, text, lbl, signal);
      state.messageCount = result.messageCount ?? state.messageCount ?? 0;
      return result.text;
    },
  });
}
