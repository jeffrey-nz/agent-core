import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function handleApiError(res, sessionId) {
  const err = await res.json().catch(() => ({ error: res.statusText }));
  log(
    colors.red(
      `  [API Error] HTTP ${res.status} for session ${sessionId?.slice(0, 8)}: ${err.error || JSON.stringify(err)}`,
    ),
  );

  if (res.status === 413 || (res.status === 400 && err.maxChars)) {
    throw new Error(`PROMPT_TOO_LONG: ${err.error}`);
  }
  if (res.status === 404) {
    throw new Error(`SESSION_EXPIRED: Remote browser session expired.`);
  }
  if (res.status === 409) {
    const e = new Error(
      `SESSION_BUSY: Remote browser session is currently busy.`,
    );
    e.isBusy = true;
    throw e;
  }
  if (res.status === 503 && err.stalled) {
    log(
      colors.yellow(
        `  [Automation API] Turn was skipped by operator (stall resolved as skip).`,
      ),
    );
    throw new Error(
      `TURN_SKIPPED: ${err.error || "Turn skipped by human operator"}`,
    );
  }

  throw new Error(err.error || `HTTP ${res.status}`);
}

export function handleApiResponse(data) {
  if (!data.success) {
    log(
      colors.red(
        `  [API Error] Success=false returned from API: ${data.error}`,
      ),
    );
    throw new Error(data.error);
  }

  return { text: data.response, messageCount: data.messageCount ?? 0 };
}
