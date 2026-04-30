/**
 * smokeScreenshotStore.js
 *
 * Module-level store that caches the most-recent smoke test screenshot so the
 * verifierNode can access it for vision-augmented verification without needing
 * to thread the value through LangGraph state (which would require an extra
 * node to update it between a coder turn and the next verifier call).
 *
 * Updated by:
 *   webModeLoop.js  — subscribes to smoke_screenshot eventBus events
 *
 * Read by:
 *   verifierNode.js — uses the screenshot in vision model calls and state updates
 */

let _last = null;

/**
 * Stores the latest smoke screenshot payload.
 * @param {{ screenshotBase64: string, url: string, statusCode?: number, t?: number }} data
 */
export function setLastSmokeScreenshot(data) {
  _last = { ...data, t: data.t || Date.now() };
}

/**
 * Returns the latest smoke screenshot or null if none taken this session.
 * @returns {{ screenshotBase64: string, url: string, t: number } | null}
 */
export function getLastSmokeScreenshot() {
  return _last;
}

/** Clears the cached screenshot (called at session start). */
export function clearSmokeScreenshot() {
  _last = null;
}
