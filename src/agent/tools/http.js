import { execAsync } from "#utils/exec.js";

const MAX_BODY_LENGTH = 5000;

// Dev-only TLDs that commonly don't resolve via public DNS but are used as
// local virtual host names in development environments.
const DEV_DOMAIN_RE = /\.(local|test|dev|localhost|internal|lan|home\.arpa)$/i;

function isDevDomain(hostname) {
  return DEV_DOMAIN_RE.test(hostname);
}

/**
 * Fetch a URL via curl with --resolve hostname:port:127.0.0.1.
 * Used as a fallback for .local and other dev-TLD domains that don't resolve
 * in WSL2 via Node.js fetch() but ARE reachable via the system curl resolver.
 */
async function fetchViaCurl(url, { method = "GET", headers = {}, body, follow_redirects = true } = {}) {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const resolveFlag = `${parsed.hostname}:${port}:127.0.0.1`;
  const parts = [`curl -s`];
  if (follow_redirects) parts.push("-L");
  parts.push(`--max-time 15`);
  parts.push(`--resolve "${resolveFlag}"`);
  if (method.toUpperCase() !== "GET") parts.push(`-X ${method.toUpperCase()}`);
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`-H "${k}: ${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  if (body) {
    // Single-quote escaping: end the quote, insert escaped quote, reopen quote.
    const escaped = String(body).replace(/'/g, "'\\''");
    parts.push(`--data-raw '${escaped}'`);
  }
  parts.push(`-w "\\n[HTTP_STATUS:%{http_code}]"`);
  parts.push(`"${url}"`);
  const cmd = parts.join(" ");
  const { stdout } = await execAsync(cmd, { timeout: 16000 });
  const statusMatch = stdout.match(/\[HTTP_STATUS:(\d+)\]$/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const responseBody = stdout.replace(/\[HTTP_STATUS:\d+\]$/, "").trim();
  return { status, ok: status >= 200 && status < 300, body: responseBody };
}

export const httpToolDefs = [
  {
    name: "http_request",
    description:
      "Make an HTTP request to a URL and return the status code and response body. " +
      "Use this to verify that newly created routes return the expected status (e.g. 200 not 404), " +
      "inspect API responses, or check that redirects work correctly.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL to request.",
        },
        method: {
          type: "string",
          description: "HTTP method. Defaults to GET.",
        },
        headers: {
          type: "object",
          description: "Optional request headers as key/value pairs.",
        },
        body: {
          type: "string",
          description: "Optional request body.",
        },
        follow_redirects: {
          type: "boolean",
          description: "Whether to follow redirects. Defaults to true.",
        },
      },
      required: ["url"],
    },
  },
];

/**
 * Detects whether an HTTP 200 response body is actually an auth / login
 * redirect page rather than the real site content.  Returns a descriptive
 * string if detected, null otherwise.
 *
 * This happens when:
 *   • The dev used the live production URL instead of the local dev URL
 *   • The production site is behind SSO (Azure AD, Google, Okta, etc.)
 *   • The SSO page returns HTTP 200 but renders a login form
 */
export function detectAuthRedirect(body, url) {
  if (!body) return null;
  const text = String(body);

  // Microsoft Azure AD / Microsoft 365 login
  if (
    text.includes("login.microsoftonline.com") ||
    text.includes("ConvergedSignIn") ||
    text.includes("microsoftonline.com/common/oauth2") ||
    (text.includes("Sign in to your account") && text.includes("microsoft"))
  ) {
    return `AUTH REDIRECT DETECTED — the response is a Microsoft/Azure AD login page, not the actual site.\nThis means you tested the WRONG URL (likely the live production site).\nYou MUST use the local development URL (from the project .env SS_BASE_URL or the LOCAL DEV URL injected in your system prompt) for all http_request calls.\nNEVER test https://thescopes.org or any other production/external URL — those are live sites with authentication and will not reflect local code changes.`;
  }

  // Google / Firebase auth
  if (
    text.includes("accounts.google.com") ||
    text.includes("GoogleAuth") ||
    (text.includes("Sign in with Google") && text.includes("oauth"))
  ) {
    return `AUTH REDIRECT DETECTED — the response is a Google OAuth login page, not the actual site.\nYou must use the local development URL for http_request calls.`;
  }

  // Okta
  if (text.includes("okta.com") && text.includes("signin")) {
    return `AUTH REDIRECT DETECTED — the response is an Okta sign-in page, not the actual site.\nYou must use the local development URL for http_request calls.`;
  }

  // Generic: page title contains "sign in" / "log in" / "login" but is clearly a wrapper
  const titleMatch = text.match(/<title[^>]*>([^<]{3,120})<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].toLowerCase();
    if (
      /\bsign[\s-]?in\b|\blog[\s-]?in\b|\blogin\b|\bauthenticate\b|\bauthorize\b/.test(t) &&
      text.length < 80000  // Short page = likely a login redirect, not a full app
    ) {
      return `AUTH REDIRECT DETECTED — page title is "${titleMatch[1]}", which looks like a login page rather than the actual site.\nEnsure you are testing the correct local development URL.`;
    }
  }

  return null;
}

export function extractErrorContext(body, status) {
  const context = [];
  const textBody = String(body || "");

  // SS6 dev mode DebugView: <h1>[Emergency] Uncaught InvalidArgumentException: msg</h1>
  const ss6Match = textBody.match(
    /\[(?:Emergency|Critical|Alert|Error)\]\s+Uncaught\s+([\w\\]+)(?:Exception)?:\s*([^\n<]{1,200})/i,
  );
  if (ss6Match) {
    context.push(`[SS6 BOOTSTRAP ERROR] ${ss6Match[1]}: ${ss6Match[2].trim()}`);
  }
  // SS6 live mode DebugViewFriendlyErrorFormatter: <h1>Website Error</h1>
  if (/<h1[^>]*>Website Error<\/h1>/i.test(textBody)) {
    context.push("[SS6 FRIENDLY ERROR] SilverStripe returned a 'Website Error' page — check server logs for the underlying exception.");
  }

  if (textBody.includes('class="info"') || textBody.includes('class="trace"')) {
    context.push("[FRAMEWORK] SilverStripe / Detailed Error Page Detected.");
    const fileMatch = textBody.match(
      /at\s+<b>(.*?)<\/b>[:\s]+line\s+<b>(\d+)<\/b>/i,
    );
    if (fileMatch) {
      context.push(`Fault Location: ${fileMatch[1]} on line ${fileMatch[2]}`);
    }
    const traceMatch = textBody.match(/<pre class="trace">([\s\S]*?)<\/pre>/i);
    if (traceMatch) {
      const cleanTrace = traceMatch[1].replace(/<[^>]*>/g, "").trim();
      context.push(`Stack Trace Snippet:\n${cleanTrace.slice(0, 1000)}`);
    }
  }

  const phpErrorMatch = textBody.match(
    /(?:Fatal error|Parse error|Uncaught Exception|Uncaught TypeError): (.*?) in (.*?) on line (\d+)/i,
  );
  if (phpErrorMatch) {
    context.push(`[RUNTIME] PHP Error: ${phpErrorMatch[1]}`);
    context.push(`Location: ${phpErrorMatch[2]} (Line ${phpErrorMatch[3]})`);
  }

  // Only inspect JSON payload for error-status responses to avoid false positives
  // on success responses with a "message" field.
  if (status >= 400) {
    try {
      const json = JSON.parse(textBody);
      if (json.error || json.message || json.exception) {
        context.push(
          `[API] JSON Error Payload:\n${JSON.stringify(json, null, 2)}`,
        );
      }
    } catch (e) {}
  }

  return context.length > 0 ? context.join("\n\n") : null;
}

export async function executeHttpTool(name, input) {
  if (name !== "http_request") return undefined;
  const {
    url,
    method = "GET",
    headers = {},
    body,
    follow_redirects = true,
  } = input;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: { Accept: "application/json, text/html, */*", ...headers },
      redirect: follow_redirects ? "follow" : "manual",
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const responseBody = await res.text();
    const errorContext = extractErrorContext(responseBody, res.status);
    const authWarning = res.ok ? detectAuthRedirect(responseBody, url) : null;

    const lines = [
      `[HTTP ${method.toUpperCase()}] ${url}`,
      `Status: ${res.status} ${res.statusText} ${res.ok ? "✅" : "❌"}`,
    ];

    if (authWarning) {
      lines.push(
        "",
        "⛔ ⛔ ⛔ WRONG URL — AUTH PAGE RETURNED ⛔ ⛔ ⛔",
        authWarning,
        "⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔",
      );
    }

    if (errorContext) {
      lines.push(
        "",
        "!!! AUTOMATIC ERROR DIAGNOSTICS !!!",
        errorContext,
        "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      );
    }

    const displayBody =
      responseBody.length > MAX_BODY_LENGTH
        ? responseBody.slice(0, MAX_BODY_LENGTH) + `\n... [truncated]`
        : responseBody;

    lines.push("", "Response body:", displayBody);

    const safeUrl = String(url || "").replace(/"/g, "&quot;");
    return `<http_result url="${safeUrl}">\n${lines.join("\n")}\n</http_result>`;
  } catch (err) {
    const safeUrl = String(url || "").replace(/"/g, "&quot;");
    // For dev-only TLDs (*.local, *.test, etc.) in WSL2, DNS may not resolve via
    // Node.js fetch(). Retry with curl --resolve hostname:port:127.0.0.1 which
    // bypasses mDNS and hits the local Apache/nginx vhost directly.
    try {
      const parsed = new URL(url);
      if (isDevDomain(parsed.hostname) && /ENOTFOUND|fetch failed|EAI_AGAIN/i.test(err.message)) {
        const curlRes = await fetchViaCurl(url, { method, headers, body, follow_redirects });
        const errorContext = extractErrorContext(curlRes.body, curlRes.status);
        const authWarning = curlRes.ok ? detectAuthRedirect(curlRes.body, url) : null;
        const lines = [
          `[HTTP ${method.toUpperCase()}] ${url}`,
          `Status: ${curlRes.status} ${curlRes.ok ? "✅" : "❌"} (via curl --resolve)`,
        ];
        if (authWarning) {
          lines.push(
            "",
            "⛔ ⛔ ⛔ WRONG URL — AUTH PAGE RETURNED ⛔ ⛔ ⛔",
            authWarning,
            "⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔ ⛔",
          );
        }
        if (errorContext) {
          lines.push(
            "",
            "!!! AUTOMATIC ERROR DIAGNOSTICS !!!",
            errorContext,
            "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
          );
        }
        const displayBody = curlRes.body.length > MAX_BODY_LENGTH
          ? curlRes.body.slice(0, MAX_BODY_LENGTH) + "\n... [truncated]"
          : curlRes.body;
        lines.push("", "Response body:", displayBody);
        return `<http_result url="${safeUrl}">\n${lines.join("\n")}\n</http_result>`;
      }
    } catch { /* curl fallback failed — fall through to original error */ }
    return `<http_result url="${safeUrl}">\n[HTTP ERROR] ${url} failed: ${err.message}\n</http_result>`;
  }
}
