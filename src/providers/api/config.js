import { getBridgeBaseUrl } from "./bridgeClient.js";

const FALLBACK_URL = "http://localhost:3333";

export function getBaseUrl() {
  const url = getBridgeBaseUrl();
  if (!url) return FALLBACK_URL;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return FALLBACK_URL;
    return url.replace(/\/$/, ""); // strip trailing slash for consistent concat
  } catch {
    return FALLBACK_URL;
  }
}
