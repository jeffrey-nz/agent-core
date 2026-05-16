import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { createRemoteSession, deleteRemoteSession } from "../api/session.js";
import { sendRemoteTurn } from "../api/interaction.js";
import { buildApiPrompt } from "./promptBuilder.js";
import { parseApiResponseTools } from "./toolParser.js";

export class AutomationApiHandler {
  constructor(providerName) {
    this.providerName = providerName;
    this.remoteSessionId = null;
  }

  async startNewChat() {
    if (this.remoteSessionId) {
      await deleteRemoteSession(this.remoteSessionId);
      this.remoteSessionId = null;
    }
  }

  async sendTurn(payload, label) {
    try {
      if (!this.remoteSessionId) {
        const sessionData = await createRemoteSession(this.providerName);
        this.remoteSessionId = sessionData.sessionId;
      }

      const promptText = await buildApiPrompt(payload);

      log(
        colors.cyan(
          `\n  [Automation API] Sending turn '${label}' to ${this.providerName}...`,
        ),
      );

      const { text: responseText } = await sendRemoteTurn(
        this.remoteSessionId,
        promptText,
        label,
      );

      eventBus.emit("message_chunk", { chunk: responseText });

      const toolCalls = parseApiResponseTools(responseText);

      log(
        colors.green(
          `  [Automation API] Turn complete. Tools called: ${toolCalls.length}`,
        ),
      );

      return { ok: true, text: responseText, toolCalls };
    } catch (error) {
      log(colors.red(`  [Automation API Error] ${error.message}`));
      // On any non-busy error, discard the remote session ID so the next call
      // opens a fresh bridge session rather than retrying the broken/expired tab.
      if (!error.isBusy) {
        if (this.remoteSessionId) {
          await deleteRemoteSession(this.remoteSessionId).catch(() => {});
          this.remoteSessionId = null;
        }
      }
      return { ok: false, reason: error.message };
    }
  }

  async close() {
    if (this.remoteSessionId) {
      await deleteRemoteSession(this.remoteSessionId);
      this.remoteSessionId = null;
    }
  }
}
