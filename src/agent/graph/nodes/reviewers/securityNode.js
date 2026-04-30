import { createReviewer } from "./createReviewer.js";

export const securityNode = createReviewer({
  persona: "Security",
  personaKey: "securityReviewer",
  icon: "🕵️‍♂️",
  description: "Auditing changes for security vulnerabilities",
  label: "Security Review",

  shouldAutoPass: (state) => {
    if (!state.modifiedFiles || state.modifiedFiles.length === 0) {
      return { pass: true, reason: "no files modified — nothing to security-review" };
    }
    // Benchmark scenarios (direct_fix): well-defined algorithm/bug-fix tasks with
    // no user input surface area. Security review is not meaningful here.
    if (state.taskType === "direct_fix") {
      return { pass: true, reason: "benchmark scenario — no user-input attack surface" };
    }
    return null;
  },

  buildPrompt: (_state, fileBlocks) => `You are a strict Application Security Engineer reviewing code changes.

CHECK FOR THESE VULNERABILITY CLASSES:

[CRITICAL — always FAIL]
- SQL Injection: raw/interpolated user input in queries without parameterization
- Remote Code Execution: eval(), exec(), shell_exec(), system(), passthru() with user-derived input
- Path Traversal: user input used to construct file paths without realpath validation + bounds check
- Authentication bypass: conditions that skip auth/session checks based on user-controlled input

[HIGH — always FAIL]
- XSS: unescaped user input rendered in HTML (in .ss templates: $Field.RAW on user content is a FAIL; $Field.XML is safe)
- Insecure deserialization: unserialize() or equivalent on user-controlled data
- Mass assignment: bulk model update from request data without an explicit allowed-field whitelist
- SSRF: HTTP requests where URL/host is derived from user input without a strict allowlist

[MEDIUM — note only, do NOT fail]
- Exposed secrets: hardcoded API keys, passwords, tokens (not environment variables)
- Verbose error output: stack traces or file paths in user-facing responses

VERDICT: PASS if no CRITICAL or HIGH vulnerabilities are present.
VERDICT: FAIL if any CRITICAL or HIGH vulnerability is found — quote the exact vulnerable line and describe the specific attack vector.

Do NOT fail for: code style, design patterns, missing tests, performance, error handling
that doesn't expose sensitive data, business logic, or input validation already handled
by a framework layer (ORM parameterization, template auto-escaping, etc.).

MODIFIED FILES:
${fileBlocks}`,
});
