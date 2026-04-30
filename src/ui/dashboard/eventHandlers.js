import { eventBus } from "#web/eventBus.js";
import { dashboardState } from "../dashboard.js";

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function initDashboardListeners() {
  let _sessionTimer = null;
  let _sessionStart = null;

  function startTimer() {
    if (_sessionTimer) clearInterval(_sessionTimer);
    _sessionStart = Date.now();
    _sessionTimer = setInterval(() => {
      const formatted = formatElapsed(Date.now() - _sessionStart);
      dashboardState.elapsedTime = formatted;
      eventBus.emit("telemetry_update", { formatted });
    }, 1000);
  }

  function stopTimer() {
    if (_sessionTimer) {
      clearInterval(_sessionTimer);
      _sessionTimer = null;
    }
  }

  eventBus.on("session_start", () => startTimer());

  eventBus.on("workflow_complete", () => stopTimer());

  eventBus.on("app_reset", () => {
    stopTimer();
    _sessionStart = null;
    dashboardState.elapsedTime = "";
    dashboardState.phaseLabel = "";
    dashboardState.sessionSlow = false;
    dashboardState.sessionSlowRemoteId = null;
    dashboardState.contextDirs = [];
    dashboardState.modifiedFiles = [];
    eventBus.emit("telemetry_update", { formatted: "" });
  });

  eventBus.on("telemetry_update", (data) => {
    if (data.formatted !== undefined) {
      dashboardState.elapsedTime = data.formatted;
      eventBus.emit("state_update", { data: { elapsedTime: data.formatted } });
    }
  });

  // Keep phaseLabel in sync so reconnecting clients get a human-readable label.
  eventBus.on("phase_change", ({ label }) => {
    if (label) dashboardState.phaseLabel = label;
  });

  // Track session-slow state persistently so stateSync can restore it.
  eventBus.on("session_slow", ({ remoteSessionId } = {}) => {
    dashboardState.sessionSlow = true;
    dashboardState.sessionSlowRemoteId = remoteSessionId ?? null;
  });
  eventBus.on("session_slow_done", () => {
    dashboardState.sessionSlow = false;
    dashboardState.sessionSlowRemoteId = null;
  });

  // Track modified files for the "Modified Areas" viz panel section.
  eventBus.on("files_modified", ({ files }) => {
    dashboardState.modifiedFiles = files;
  });

  eventBus.on("task_state_change", (data) => {
    if (!Array.isArray(dashboardState.history)) dashboardState.history = [];
    dashboardState.history.push({
      timestamp: Date.now(),
      type: "task",
      ...data,
    });
  });
}
