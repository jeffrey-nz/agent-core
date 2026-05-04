import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { getBaseUrl } from "./config.js";
import { createTelemetryTracker } from "./interaction/telemetry.js";
import { doFetch } from "./interaction/client.js";
import {
  handleApiError,
  handleApiResponse,
} from "./interaction/errorHandler.js";
import { eventBus } from "#web/eventBus.js";

export async function sendRemoteTurn(sessionId, text, label, signal, opts = {}) {
  const { attachments = [] } = opts;
  const safeText = typeof text === "string" ? text : JSON.stringify(text);

  // Track the active remote session ID so the WS abort handler can send a
  // control-skip to the automation-api when the user clicks "End Session".
  if (sessionId) {
    eventBus.emit("remote_session_active", { remoteSessionId: sessionId });
  }

  log(
    colors.cyan(
      `\n  [API Debug] Sending turn '${label}' to ${getBaseUrl()}/api/ask (Session: ${sessionId?.slice(0, 8)})${attachments.length ? ` [+${attachments.length} image(s)]` : ""}`,
    ),
  );

  const telemetry = createTelemetryTracker(sessionId, label);
  telemetry.start();

  let res;
  try {
    res = await doFetch(sessionId, safeText, { label, signal, attachments });
  } catch (err) {
    telemetry.stop();
    log(
      colors.red(
        `  [API Error] Network failure on fetch to ${getBaseUrl()}/api/ask: ${err.message}`,
      ),
    );
    throw err;
  }
  telemetry.stop();

  if (!res.ok) {
    await handleApiError(res, sessionId);
  }

  const data = await res.json();
  return handleApiResponse(data);
}
