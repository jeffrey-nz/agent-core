import { verifyPhase1Gate } from "../verification/phase1Gate.js";

export function computeOutcome({
  phase,
  projectRoot,
  modifiedFiles,
  diagnosticsRun,
  formattingApplied,
  lintingApplied,
  assetsCleaned,
  testsBefore,
  testsAfter,
  knownFailures,
}) {
  if (phase === "PHASE_1_DEPENDENCIES") {
    const gate = verifyPhase1Gate({
      projectRoot,
      modifiedFiles,
      diagnosticsRun,
    });

    if (!gate.ok) {
      return {
        outcome: "FAIL",
        reason: "PHASE_1_HARD_GATE_FAILED",
        details: gate.errors,
      };
    }
  }

  if (!assetsCleaned) return "FAIL";
  if (!formattingApplied || !lintingApplied) return "FAIL";

  if (knownFailures?.status === "KNOWN_FAILURES_UNCHANGED") {
    return "PASS_WITH_KNOWN_FAILURES";
  }

  if (testsAfter?.failed > testsBefore?.failed) {
    return "FAIL";
  }

  return "PASS";
}
