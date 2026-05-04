import { sendWithChunking } from "../chunking.js";
import { sendRemoteTurn } from "../../api/interaction.js";

export async function sendAutomationTurn({ state, promptText, label, signal }) {
  const maxChars = state.maxPromptChars || 118000;
  const chunkSize = Math.floor(maxChars * 0.98);

  // Consume pending attachments on the first turn only — cleared after sending
  // so subsequent turns in the same session don't re-send the same images.
  const attachments = state.pendingAttachments?.length ? [...state.pendingAttachments] : [];
  if (attachments.length) state.pendingAttachments = [];

  return sendWithChunking({
    remoteSessionId: state.remoteSessionId,
    promptText,
    label,
    chunkSize,
    send: async (sid, text, lbl) => {
      const result = await sendRemoteTurn(sid, text, lbl, signal, { attachments });
      state.messageCount = result.messageCount ?? state.messageCount ?? 0;
      return result.text;
    },
  });
}
