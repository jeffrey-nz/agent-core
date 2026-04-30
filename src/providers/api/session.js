import { getBridgeClient } from "./bridgeClient.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function createRemoteSession(providerName, mode = null) {
  log(colors.dim(
    `  [API Debug] Creating session for '${providerName}'${mode ? ` (mode: ${mode})` : ""}...`
  ));
  try {
    const session = await getBridgeClient().createSession(providerName, { mode: mode || undefined });
    log(colors.green(
      `  [API Debug] Session created: ${session.id} (Max Chars: ${session.maxPromptChars})`
    ));
    return { sessionId: session.id, maxPromptChars: session.maxPromptChars };
  } catch (err) {
    log(colors.red(`  [API Error] createSession failed: ${err.message}`));
    throw err;
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
