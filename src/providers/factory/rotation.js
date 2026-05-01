export function injectRotationHandoff(payload, lastResponseText, opts = {}) {
  const { segmentIndex, progressSummary, providerName } = opts;
  const sessionNum = segmentIndex ?? 1;
  const provider = providerName || "AI";

  const snippet =
    lastResponseText && lastResponseText.length > 500
      ? lastResponseText.slice(-500)
      : lastResponseText || "";

  const lines = [
    `[${provider.toUpperCase()} — CONTINUING IN NEW BROWSER SESSION (Session ${sessionNum})]`,
    `Your previous ${provider} browser session reached its message limit and was closed.`,
    "The full codebase and task are being re-sent below. Continue from where you left off.",
    "",
  ];

  if (progressSummary && progressSummary.trim()) {
    lines.push(
      "FILES MODIFIED SO FAR (git status):",
      "---",
      progressSummary.trim(),
      "---",
      "",
    );
  } else {
    lines.push("FILES MODIFIED SO FAR: No changes recorded yet.", "");
  }

  if (snippet) {
    lines.push(
      "PREVIOUS SESSION'S LAST RESPONSE (tail):",
      "---",
      snippet,
      "---",
      "",
    );
  }

  // When the previous session ended due to context overflow (SESSION_BUSY),
  // the harness reverts all uncommitted changes to the last checkpoint.
  // The AI must re-apply any changes that were in-flight — they are NOT preserved.
  const hasNoChanges = !progressSummary || !progressSummary.trim() ||
    progressSummary.trim() === "No changes recorded yet.";
  if (hasNoChanges) {
    lines.push(
      "⚠️ REVERT NOTICE: The previous session ended before any changes were committed.",
      "All in-flight edits have been rolled back. Start fresh — do not assume any prior",
      "file modifications are still present. Read the target file before patching.",
      "",
    );
  } else {
    lines.push(
      "IMPORTANT: Do not redo work already reflected in the modified files above.",
      "Any changes NOT listed above were rolled back and must be re-applied.",
      "",
    );
  }

  const handoff = lines.join("\n");

  if (Array.isArray(payload)) {
    const idx = payload.findIndex((m) => m.role === "system");
    if (idx !== -1) {
      return payload.map((m, i) =>
        i === idx ? { ...m, content: handoff + "\n\n" + m.content } : m,
      );
    }
    return [{ role: "system", content: handoff }, ...payload];
  }
  if (typeof payload === "string") {
    return handoff + "\n\n" + payload;
  }
  return payload;
}
