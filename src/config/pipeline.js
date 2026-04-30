/**
 * Central pipeline configuration.
 * All magic numbers governing agent step limits, timeouts, and retry caps
 * are defined here so they can be overridden via environment variables.
 */

export const MAX_VERIFIER_RETRIES  = Number(process.env.MAX_VERIFIER_RETRIES  ?? 8);
export const MAX_STEPS_RESEARCHER  = Number(process.env.MAX_STEPS_RESEARCHER  ?? 12);
export const MAX_STEPS_RESEARCHER_DOC = Number(process.env.MAX_STEPS_RESEARCHER_DOC ?? 8);
export const MAX_STEPS_SCOPER      = Number(process.env.MAX_STEPS_SCOPER      ?? 20);
export const MAX_STEPS_SCOPER_REFINE = Number(process.env.MAX_STEPS_SCOPER_REFINE ?? 14);
export const MAX_STEPS_CODER       = Number(process.env.MAX_STEPS_CODER       ?? 15);
export const MAX_STEPS_CODER_UNITY = Number(process.env.MAX_STEPS_CODER_UNITY ?? 20);
export const STALL_TIMEOUT_MS      = Number(process.env.STALL_TIMEOUT_MS      ?? 120_000);
export const HARD_TIMEOUT_MS       = Number(process.env.HARD_TIMEOUT_MS       ?? 180_000);

// Debugger trigger thresholds — after this many verifier failures on one subtask,
// route to the debugger for root-cause investigation before the next coder attempt.
export const DEBUGGER_TRIGGER_RETRIES  = Number(process.env.DEBUGGER_TRIGGER_RETRIES  ?? 3);
export const DEBUGGER2_TRIGGER_RETRIES = Number(process.env.DEBUGGER2_TRIGGER_RETRIES ?? 6);
