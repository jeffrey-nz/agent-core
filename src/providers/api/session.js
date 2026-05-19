import { getBridgeClient } from "./bridgeClient.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";

export async function createRemoteSession(providerName, mode = null) {
  log(colors.dim(
    `  [API Debug] Creating session for '${providerName}'${mode ? ` (mode: ${mode})` : ""}...`
  ));
  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 15000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const session = await getBridgeClient().createSession(providerName, { mode: mode || undefined });
      log(colors.green(
        `  [API Debug] Session created: ${session.id} (Max Chars: ${session.maxPromptChars})`
      ));
      return { sessionId: session.id, maxPromptChars: session.maxPromptChars };
    } catch (err) {
      const is429 = err.message?.includes("429") || err.message?.includes("Too many requests");
      const is503 = err.message?.includes("503") || err.message?.includes("timed out");
      if ((is429 || is503) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * attempt;
        const reason = is429 ? "429 rate limit" : "503 timeout";
        log(colors.yellow(`  [API Warn] createSession ${reason} (attempt ${attempt}/${MAX_RETRIES}) — waiting ${delay / 1000}s before retry...`));
        eventBus.emit("rate_limit", { retryAfter: delay / 1000 });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      log(colors.red(`  [API Error] createSession failed: ${err.message}`));
      throw err;
    }
  }
}

export async function deleteRemoteSession(sessionId) {
  if (!sessionId) return false;
  log(colors.dim(`  [API Debug] Deleting session ${sessionId}...`));
  try {
    await getBridgeClient().closeSession(sessionId);
    return true;
  } catch (err) {
    log(colors.yellow(`  [API Warn] Failed to delete session: ${err.message}`));
    return false;
  }
}
