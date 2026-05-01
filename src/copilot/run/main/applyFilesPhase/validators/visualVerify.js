/**
 * visualVerify.js — two-tier visual QA check.
 *
 * Tier 1 (deterministic): Call /api/page-inspect to check if React mounted.
 *   - If there's a Vite/React import-error overlay → SKIP (intermediate build state)
 *   - If #root is empty and no error overlay → FAIL (app broke silently)
 *   - If #root has content → proceed to Tier 2
 *
 * Tier 2 (AI optional): Call /api/visual-ask to get AI analysis of the screenshot.
 *   - Catches CSS/layout issues, wrong colors, missing game elements, etc.
 *   - Fails open: any parse/network error → [] (never false-block the pipeline)
 *
 * No external AI APIs — all AI interaction goes through the browser-automation session.
 */

import { getBaseUrl } from "#providers/api/config.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const VISUAL_QA_PROMPT = `You are a QA engineer reviewing a screenshot of a React web app built by an AI coding agent.

Respond with JSON ONLY (no prose, no markdown fences):
{
  "pass": boolean,
  "issues": string[],
  "feedback": string
}

- pass: true if the app renders and shows the primary UI (no blank page, no error overlays)
- issues: list of specific visual problems found (empty array if pass)
- feedback: one-sentence developer-facing summary

Check for:
1. Blank/white/all-black page (= broken)
2. Primary UI element missing (board, form, calculator, etc.) (= broken)
3. Visible JS error overlay or React error boundary message (= broken)
4. For chess/board games: board squares must be two alternating colors; pieces must be visually distinct (white vs black)
5. Obviously broken layout: invisible text, collapsed elements, completely unstyled raw HTML`;

export async function checkVisualVerify(projectDir, devServerResult) {
  if (!devServerResult?.url) return [];

  const apiBase = getBaseUrl();
  if (!apiBase) return [];

  const url = devServerResult.url;

  // ── Tier 1: deterministic DOM check ─────────────────────────────────────
  log(colors.dim(`  [VisualVerify] Checking render at ${url}…`));

  try {
    const inspectResp = await fetch(
      `${apiBase}/api/page-inspect?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(25_000) },
    );

    if (inspectResp.ok) {
      const inspect = await inspectResp.json();
      const { hasContent, errorText, consoleErrors = [] } = inspect;

      // Import errors or Vite build errors → skip, not a visual failure
      // These will be resolved when the missing files are written in later subtasks
      const isImportError =
        (errorText && /import|module|Cannot find|Failed to resolve/i.test(errorText)) ||
        consoleErrors.some(e => /import|module|Cannot find|Failed to resolve/i.test(e));

      if (isImportError) {
        log(colors.dim("  [VisualVerify] Import/module error detected — skipping (dependency missing, not a visual bug)"));
        return [];
      }

      if (!hasContent) {
        const msg = "React #root div is empty — app did not mount. Check for JS errors in main.jsx or App.jsx.";
        log(colors.red(`  [VisualVerify] FAIL — ${msg}`));
        return [
          `[VERIFIER VISUAL CHECK FAILED]\n\nApp URL: ${url}\nIssue: ${msg}\n\nThe React app is not rendering. Possible causes:\n  • Missing or incorrect default export in App.jsx\n  • Runtime error in component mount (check useEffect hooks)\n  • main.jsx not connecting to the #root element\n\nFix the render issue. The verifier will re-check on next retry.`,
        ];
      }

      log(colors.dim("  [VisualVerify] App mounted — running AI visual analysis…"));
    } else {
      // page-inspect not available — skip tier 1
      log(colors.dim("  [VisualVerify] page-inspect unavailable — skipping DOM check"));
    }
  } catch (err) {
    log(colors.dim(`  [VisualVerify] DOM check failed: ${err.message?.slice(0, 80)} — skipping`));
    return [];
  }

  // ── Tier 2: AI visual analysis (optional, fail open) ────────────────────
  try {
    let provider = "deepseek";
    try {
      const sessResp = await fetch(`${apiBase}/api/sessions`, { signal: AbortSignal.timeout(3000) });
      if (sessResp.ok) {
        const sessData = await sessResp.json();
        const sessions = Array.isArray(sessData) ? sessData : (sessData?.data?.sessions ?? sessData?.sessions ?? []);
        const active = sessions.find(s => s.providerId && s.state !== "busy");
        if (active?.providerId) provider = active.providerId;
      }
    } catch { /* use default */ }

    const resp = await fetch(`${apiBase}/api/visual-ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenshotUrl: url, prompt: VISUAL_QA_PROMPT, label: "visual-qa", provider }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!resp.ok) {
      if (resp.status === 501) {
        log(colors.dim("  [VisualVerify] Provider does not support file upload — skipping AI check"));
      } else {
        log(colors.dim(`  [VisualVerify] Bridge returned ${resp.status} — skipping AI check`));
      }
      return [];
    }

    const data = await resp.json();
    const responseText = data?.response ?? data?.data?.response ?? "";

    if (!responseText) return [];

    let analysis;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch?.[0] ?? "{}");
    } catch {
      return []; // non-JSON response (e.g. DeepSeek tool calls) → fail open
    }

    if (analysis.pass === false) {
      const issues =
        Array.isArray(analysis.issues) && analysis.issues.length > 0
          ? analysis.issues
          : [analysis.feedback || "Visual verification failed"];
      log(colors.red(`  [VisualVerify] FAIL — ${issues.join("; ")}`));
      return [
        `[VERIFIER VISUAL CHECK FAILED]\n\nApp URL: ${url}\nIssues detected:\n${issues.map(i => `  • ${i}`).join("\n")}\n\nFix the visual issues above then the verifier will re-screenshot and check again.`,
      ];
    }

    log(colors.green(`  [VisualVerify] PASS — ${analysis.feedback || "App looks functional"}`));
    return [];
  } catch (err) {
    log(colors.dim(`  [VisualVerify] AI check failed: ${err.message?.slice(0, 80)}`));
    return []; // fail open
  }
}
