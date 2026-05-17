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
    if (err.rateLimited) {
      log(
        colors.yellow(
          `  [Automation API] DeepSeek rate limit — bridge exhausted all backoff retries. Will retry subtask.`,
        ),
      );
      const e = new Error(
        `RATE_LIMITED: DeepSeek rate limit — bridge exhausted backoff retries`,
      );
      e.rateLimited = true;
      throw e;
    }
    log(
      colors.yellow(
        `  [Automation API] Turn was skipped by operator (stall resolved as skip).`,
      ),
    );
    throw new Error(
      `TURN_SKIPPED: ${err.error || "Turn skipped by human operator"}`,
    );
  }

  // Playwright browser tab was closed externally — equivalent to session expiry.
  // Map to SESSION_EXPIRED so runAutomationApiTurn's recovery path fires.
  if (
    err.error?.includes("Target page, context or browser has been closed") ||
    (err.error?.includes("page") && err.error?.includes("closed"))
  ) {
    throw new Error(`SESSION_EXPIRED: Browser tab was closed. ${err.error}`);
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
