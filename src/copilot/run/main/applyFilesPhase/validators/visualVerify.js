/**
 * visualVerify.js — screenshots a running dev server URL via the bridge's
 * /api/screenshot endpoint, then sends the image to Claude Vision (using the
 * already-installed Vercel AI SDK + @ai-sdk/anthropic) for QA analysis.
 *
 * Returns [] on PASS or when the check is skipped/unavailable.
 * Returns a non-empty error string array on FAIL so the verifier can feed
 * specific visual issues back to the coder.
 *
 * Fails OPEN: any network/API error → returns [] so the pipeline is never
 * false-blocked by flaky vision calls.
 */

import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getBaseUrl } from "#providers/api/config.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const VISION_MODEL = "claude-haiku-4-5-20251001";

const VISION_PROMPT = `You are a QA engineer reviewing a screenshot of a React web app that was just built by an AI coding agent.

Analyze the screenshot and respond with JSON ONLY (no prose, no markdown fences):
{
  "pass": boolean,
  "issues": string[],
  "feedback": string
}

- pass: true if the app looks functional (renders, primary UI visible, no error overlays)
- issues: list of specific visual problems (empty array if pass)
- feedback: one-sentence developer-facing summary

Check for:
1. Blank/white/all-black page (= broken)
2. Primary UI element missing (game board, form, calculator, etc.) (= broken)
3. Visible JS error overlay or React error boundary message (= broken)
4. CSS completely unstyled — raw HTML with no layout (= broken)
5. For chess/board games specifically:
   - Board squares must be two alternating colors (light + dark). If all squares are the same color, that is broken.
   - Pieces must be visually distinct from each other — white pieces vs black pieces must look different. If all pieces are the same color, that is broken.
6. Obvious broken styles: elements overlapping unintentionally, text invisible (white on white / black on black), layout completely collapsed`;

export async function checkVisualVerify(projectDir, devServerResult) {
  if (!devServerResult?.url) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log(colors.dim("  [VisualVerify] No ANTHROPIC_API_KEY — skipping"));
    return [];
  }

  const apiBase = getBaseUrl();
  if (!apiBase) return [];

  // 1. Capture screenshot via bridge's existing /api/screenshot endpoint
  let screenshotBase64;
  try {
    log(colors.dim(`  [VisualVerify] Capturing screenshot of ${devServerResult.url}…`));
    const resp = await fetch(
      `${apiBase}/api/screenshot?url=${encodeURIComponent(devServerResult.url)}`,
      { signal: AbortSignal.timeout(25_000) },
    );
    if (!resp.ok) {
      log(colors.dim(`  [VisualVerify] Screenshot endpoint returned ${resp.status} — skipping`));
      return [];
    }
    const data = await resp.json();
    screenshotBase64 = data?.data?.screenshotBase64;
    if (!screenshotBase64) {
      log(colors.dim("  [VisualVerify] No screenshot data in response — skipping"));
      return [];
    }
  } catch (err) {
    log(colors.dim(`  [VisualVerify] Screenshot failed: ${err.message?.slice(0, 80)}`));
    return [];
  }

  // 2. Claude Vision analysis via Vercel AI SDK (already a dependency — no new packages)
  try {
    const anthropic = createAnthropic({ apiKey });
    const { text } = await generateText({
      model: anthropic(VISION_MODEL),
      maxTokens: 600,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: Buffer.from(screenshotBase64, "base64"),
              mimeType: "image/png",
            },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
    });

    let analysis;
    try {
      analysis = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {
      log(colors.dim("  [VisualVerify] Could not parse vision response — skipping"));
      return [];
    }

    if (analysis.pass === false) {
      const issues =
        Array.isArray(analysis.issues) && analysis.issues.length > 0
          ? analysis.issues.join("; ")
          : analysis.feedback || "Visual verification failed";
      log(colors.red(`  [VisualVerify] FAIL — ${issues}`));
      return [
        `[VERIFIER VISUAL CHECK FAILED]\n\nApp URL: ${devServerResult.url}\nIssues detected:\n${(analysis.issues || [issues]).map((i) => `  • ${i}`).join("\n")}\n\nFix the visual issues above (CSS selectors, piece colors, board styling) then the verifier will re-screenshot and check again. Do NOT mark the subtask complete until the UI renders correctly.`,
      ];
    }

    log(colors.green(`  [VisualVerify] PASS — ${analysis.feedback || "App looks functional"}`));
    return [];
  } catch (err) {
    log(colors.dim(`  [VisualVerify] Vision API call failed: ${err.message?.slice(0, 80)}`));
    return []; // fail open — never false-block the pipeline
  }
}
