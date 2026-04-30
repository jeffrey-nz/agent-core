/**
 * Infinite loop mode state.
 *
 * When active, the pipeline bypasses all human-input gates (scoping Q&A,
 * scope approval, post-task feedback) and restarts automatically after each
 * completed run using a configurable generic prompt.
 *
 * Usage: import { isLoopActive } from "#web/loopMode.js";
 */

let _active = false;
let _prompt =
  "Find bugs in the codebase and fix them. Look for: runtime errors, edge cases, missing error handling, security vulnerabilities, and code quality issues.";
let _iteration = 0;
let _lastTaskContext = null; // { projectId, provider }

// Loop-mode guardrails (configuration only).
// These exports are additive and do not change existing loopMode behavior.
export const DEFAULT_LOOP_GUARDRAILS = Object.freeze({
 // Hard stop after N iterations (null disables).
 maxIterations: 10,
 // Hard stop after elapsed time (ms) since loop activation (null disables).
 maxElapsedMs: 30 * 60 * 1000,
 // Emit a checkpoint/summarization hint every N iterations (null disables).
 summaryEvery: 5,
 // Stop suggestion threshold for consecutive tool failures (null disables).
 maxConsecutiveToolFailures: 3,
 // If true, callers may choose to stop when no progress is detected.
 requireProgressSignals: true,
});

let _loopGuardrails = { ...DEFAULT_LOOP_GUARDRAILS };

function _sanitizeGuardrails(next) {
 const out = { ..._loopGuardrails };
 if (!next || typeof next !== "object") return out;

 const numericOrNull = (v) => (v === null ? null : (typeof v === "number" && Number.isFinite(v) ? v : undefined));

 const maxIterations = numericOrNull(next.maxIterations);
 if (maxIterations !== undefined) out.maxIterations = maxIterations;

 const maxElapsedMs = numericOrNull(next.maxElapsedMs);
 if (maxElapsedMs !== undefined) out.maxElapsedMs = maxElapsedMs;

 const summaryEvery = numericOrNull(next.summaryEvery);
 if (summaryEvery !== undefined) out.summaryEvery = summaryEvery;

 const maxConsecutiveToolFailures = numericOrNull(next.maxConsecutiveToolFailures);
 if (maxConsecutiveToolFailures !== undefined) out.maxConsecutiveToolFailures = maxConsecutiveToolFailures;

 if (typeof next.requireProgressSignals === "boolean") {
 out.requireProgressSignals = next.requireProgressSignals;
 }

 return out;
}

export const getLoopGuardrails = () => ({ ..._loopGuardrails });

export const setLoopGuardrails = (partial) => {
 _loopGuardrails = _sanitizeGuardrails(partial);
 return getLoopGuardrails();
};

export const resetLoopGuardrails = () => {
 _loopGuardrails = { ...DEFAULT_LOOP_GUARDRAILS };
 return getLoopGuardrails();
};

export const isLoopActive = () => _active;
export const setLoopActive = (v) => {
  _active = !!v;
  if (!v) _iteration = 0;
};

export const getLoopPrompt = () => _prompt;
export const setLoopPrompt = (p) => {
  if (typeof p === "string" && p.trim()) _prompt = p;
};

export const getLoopIteration = () => _iteration;
export const incrementLoopIteration = () => ++_iteration;

export const getLoopTaskContext = () => _lastTaskContext;
export const setLoopTaskContext = (ctx) => {
  _lastTaskContext = ctx;
};

// Auto mode: AI project manager selects the next task from GitHub state
// instead of repeating a fixed prompt. Auto mode always implies loop mode.
let _autoMode = false;
let _autoProjectConfig = null;

export const isAutoMode = () => _autoMode;
export const setAutoMode = (v) => { _autoMode = !!v; };
export const getAutoProjectConfig = () => _autoProjectConfig;
export const setAutoProjectConfig = (cfg) => { _autoProjectConfig = cfg; };

// Standing instructions from the user that the PM factors in when selecting the next task.
let _pmInstructions = "";
export const getPMInstructions = () => _pmInstructions;
export const setPMInstructions = (v) => { _pmInstructions = typeof v === "string" ? v.trim() : ""; };

let _loopIsIdle = false;
export const isLoopIdle = () => _loopIsIdle;
export const setLoopIdle = (v) => { _loopIsIdle = !!v; };
