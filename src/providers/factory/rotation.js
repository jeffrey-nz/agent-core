export function injectRotationHandoff(payload, lastResponseText, opts = {}) {
  const { segmentIndex, progressSummary, providerName, sessionContext } = opts;
  const sessionNum = segmentIndex ?? 1;
  const provider = providerName || "AI";
  const ctx = sessionContext || {};

  const rule = "─".repeat(44);

  const lines = [
    `[${provider.toUpperCase()} — NEW BROWSER SESSION (Session ${sessionNum})]`,
    `The previous session hit its context limit and was closed. A full project`,
    `overview follows so you can continue without missing a step.`,
    "",
  ];

  // ── Project goal ──────────────────────────────────────────────────────────
  if (ctx.projectGoal) {
    lines.push("PROJECT GOAL", rule, ctx.projectGoal.trim(), "");
  }

  // ── Execution plan ────────────────────────────────────────────────────────
  if (ctx.executionPlan) {
    lines.push("EXECUTION PLAN", rule, ctx.executionPlan.trim(), "");
  }

  // ── Subtask progress ──────────────────────────────────────────────────────
  const subtasks = ctx.subtasks;
  const currentIdx = ctx.currentSubtaskIndex ?? 0;
  if (subtasks?.length > 0) {
    const completedCount = subtasks.filter((_, i) => i < currentIdx).length;
    lines.push(`PROGRESS: ${completedCount} of ${subtasks.length} subtasks complete`, rule);
    for (let i = 0; i < subtasks.length; i++) {
      const s = subtasks[i];
      const marker = i < currentIdx ? "✓" : i === currentIdx ? "→" : "○";
      const filesStr = s.files?.length > 0 ? ` → wrote: ${s.files.join(", ")}` : "";
      const current = i === currentIdx ? "  ◄ YOUR CURRENT TASK" : "";
      lines.push(`  ${marker} Subtask ${s.id ?? i + 1}: ${s.task}${filesStr}${current}`);
    }
    lines.push("");
  }

  // ── Files modified (git stat) ─────────────────────────────────────────────
  if (progressSummary?.trim()) {
    lines.push("FILES MODIFIED (git diff --stat)", rule, progressSummary.trim(), "");
  }

  // ── All written files (from state) ───────────────────────────────────────
  if (ctx.allModifiedFiles?.length > 0) {
    lines.push(
      "ALL FILES WRITTEN BY PRIOR SUBTASKS",
      rule,
      ...ctx.allModifiedFiles.map((f) => `  - ${f}`),
      "",
    );
  }

  // ── What to do next ───────────────────────────────────────────────────────
  const currentSubtask = subtasks?.[currentIdx];
  if (currentSubtask) {
    lines.push("WHAT TO DO NEXT", rule);
    lines.push(`Continue Subtask ${currentSubtask.id ?? currentIdx + 1}: ${currentSubtask.task}`);
    if (currentSubtask.files?.length > 0) {
      lines.push(`Target files: ${currentSubtask.files.join(", ")}`);
    }
    lines.push(
      "",
      "RULES:",
      "• Do NOT re-implement any ✓ completed subtask — those files already exist.",
      "• Any files NOT listed in 'FILES MODIFIED' were rolled back; re-apply them now.",
      "• Output tool calls immediately — no preamble, no questions.",
      "",
    );
  } else {
    const hasNoChanges = !progressSummary?.trim() || progressSummary.trim() === "No changes recorded yet.";
    if (hasNoChanges) {
      lines.push(
        "⚠️ REVERT NOTICE: The previous session ended before any changes were committed.",
        "All in-flight edits have been rolled back. Read each target file before writing.",
        "",
      );
    } else {
      lines.push(
        "IMPORTANT: Do not redo work already reflected in the modified files above.",
        "Any changes NOT listed above were rolled back and must be re-applied.",
        "",
      );
    }
  }

  // ── Tail of previous response (for continuity) ────────────────────────────
  const snippet =
    lastResponseText && lastResponseText.length > 300
      ? lastResponseText.slice(-300)
      : lastResponseText || "";
  if (snippet) {
    lines.push("PREVIOUS SESSION LAST RESPONSE (tail):", rule, snippet, "");
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
