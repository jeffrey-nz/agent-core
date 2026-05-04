import http from "node:http";
import { getBaseUrl } from "../config.js";

const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEWER_FETCH_TIMEOUT_MS = 4 * 60 * 1000;

function httpRequest(url, options, body, timeoutMs = FETCH_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Aborted"));
    }

    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage ?? String(res.statusCode),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(raw));
              } catch (e) {
                return Promise.reject(e);
              }
            },
            text: () => Promise.resolve(raw),
          });
        });
        res.on("error", reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs} ms`));
    });

    if (signal) {
      const onAbort = () => req.destroy(new Error("Aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function doFetchWithRetry(sessionId, safeText, opts, attempt = 1) {
  const baseUrl = getBaseUrl();
  const label = opts.label ?? null;
  const signal = opts.signal ?? null;
  const attachments = opts.attachments ?? [];
  const isReviewer = /reviewer/i.test(label ?? "");
  const timeoutMs = opts.timeoutMs ?? (isReviewer ? REVIEWER_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS);
  const body = JSON.stringify({
    sessionId,
    prompt: safeText,
    ...(label ? { label } : {}),
    ...(attachments.length ? { images: attachments } : {}),
  });

  try {
    const res = await httpRequest(
      `${baseUrl}/api/ask`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      body,
      timeoutMs,
      signal,
    );

    // Validate response is valid JSON (already parsed in httpRequest's json method)
    // But check if response has expected structure
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && typeof data === "object" && (data.response !== undefined || data.success !== undefined)) {
        return res;
      }
      // Malformed JSON - retry with backoff
      throw new Error("Invalid JSON response structure");
    }
    return res;
  } catch (err) {
    const maxRetries = opts.maxRetries ?? 3;
    if (attempt < maxRetries && !signal?.aborted) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(resolve => setTimeout(resolve, delay));
      return doFetchWithRetry(sessionId, safeText, opts, attempt + 1);
    }
    throw err;
  }
}

export async function doFetch(sessionId, safeText, opts = {}) {
  return doFetchWithRetry(sessionId, safeText, opts, 1);
}
