import { getBridgeClient } from "./bridgeClient.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function sendControlAction(remoteSessionId, action, text) {
  log(colors.cyan(
    `\n  [Control] Sending '${action}' to stalled session ${remoteSessionId.slice(0, 8)}...`
  ));
  try {
    const data = await getBridgeClient()._request(
      "POST",
      `/api/sessions/${remoteSessionId}/control`,
      { action, text }
    );
    log(colors.green(`  [Control] Action '${action}' accepted (phase: ${data.phase || "?"})`));
    return true;
  } catch (err) {
    log(colors.yellow(`  [Control] ${err.message} (state: ${err.body?.state || "?"})`));
    return false;
  }
}
