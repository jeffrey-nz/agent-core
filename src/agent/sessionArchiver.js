import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export function buildSessionArchive(state) {
  return {
    task: state.task,
    completionSummary: state.completionSummary,
    iterations: state.iteration,
    durationMs: Date.now() - state.startedAt,
    tokensSent: state.tokensSent,
    tokensReceived: state.tokensReceived,
    modifiedFiles: state.modifiedFiles,
    notes: state.notes,
    decisions: state.decisions,
    blockers: state.blockers,
    wishlist: state.wishlist,
    plan: state.plan,
    turnLog: state.turnLog,
    archivedAt: new Date().toISOString(),
  };
}

export async function writePerformanceReport(state, flowStartTime) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const perfDir = path.join(process.cwd(), "copilot-reports", "self-upgrade");
  try {
    fs.mkdirSync(perfDir, { recursive: true });
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(perfDir, `perf-${date}.json`);
    const report = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - flowStartTime,
      tokensSent: state.tokensSent || 0,
      tokensReceived: state.tokensReceived || 0,
      totalTokens: (state.tokensSent || 0) + (state.tokensReceived || 0),
      subtaskCount: state.subtasks?.length || 0,
      modifiedFilesCount: state.modifiedFiles?.length || 0,
      projectId: state.projectId || "self-upgrade"
    };
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  } catch (err) {
    // Silently fail - don't let reporting crash the session
  }
}

export function printSessionSummary(state) {
  const ms = Date.now() - state.startedAt;
  const dur =
    ms > 60000
      ? `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
      : `${(ms / 1000).toFixed(1)}s`;

  const totalTokens = state.tokensSent + state.tokensReceived;

  log(`\n${colors.bgCyan(colors.bold(" 🏁 SESSION COMPLETE "))}`);

  log(
    colors.cyan(
      "  ┌─ Execution Stats ──────────────────────────────────────────────────────────",
    ),
  );
  log(`  ${colors.cyan("│")}  Duration:   ${colors.bold(dur)}`);
  log(
    `  ${colors.cyan("│")}  Iterations: ${colors.bold(state.iteration)} turns`,
  );
  log(
    `  ${colors.cyan("│")}  Usage:      ~${colors.bold(totalTokens.toLocaleString())} tokens`,
  );
  log(
    colors.cyan(
      "  └────────────────────────────────────────────────────────────────────────────",
    ),
  );

  if (state.completionSummary) {
    log(`\n  ${colors.magenta("🎯 Result:")} ${state.completionSummary}`);
  }

  if (state.modifiedFiles.length) {
    log(colors.green(`\n  📝 Files Modified (${state.modifiedFiles.length}):`));
    for (const f of state.modifiedFiles) log(colors.dim(`    • ${f}`));
  }

  if (state.decisions.length) {
    log(colors.blue(`\n  🛠️  Decisions Made (${state.decisions.length}):`));
    for (const d of state.decisions) log(colors.dim(`    • ${d}`));
  }

  if (state.blockers.length) {
    log(colors.red(`\n  🛑 Blockers Encountered (${state.blockers.length}):`));
    for (const b of state.blockers) log(colors.dim(`    • ${b}`));
  }

  if (state.wishlist?.length) {
    log(
      colors.magenta(
        `\n  ✨ Tooling Wishlist Logged (${state.wishlist.length}):`,
      ),
    );
    for (const w of state.wishlist) log(colors.dim(`    • ${w}`));
  }

  if (state.notes.length) {
    log(colors.yellow(`\n  📓 Architectural Notes (${state.notes.length}):`));
    for (const n of state.notes) log(colors.dim(`    • ${n}`));
  }

  log("");
}
