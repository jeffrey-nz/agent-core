import { eventBus } from "#web/eventBus.js";

export const dashboardState = {
  projectId: null,
  project: "Unknown",
  sessionTask: null,
  sessionId: null,
  sessionStartedAt: null,
  phase: "INIT",
  phaseLabel: "",        // human-readable label for current phase (e.g. "Planning...")
  turn: 0,
  tokens: 0,
  aiStatus: "",
  lastAction: "",
  elapsedTime: "0m 0s",

  // Active AI Provider configuration
  provider: null,
  providerMode: null,

  currentTaskPath: [],
  plan: null,
  activeTaskId: null,
  failedTaskId: null,
  milestoneTitle: null,
  completedCount: 0,
  totalCount: 0,

  // Persistent ephemeral state so reconnecting clients can be fully restored.
  sessionSlow: false,
  sessionSlowRemoteId: null,

  // Multi-directory (self-upgrade) mode - populated from project.contextDirs.
  contextDirs: [],
  modifiedFiles: [],

  history: [],
};

export function computePlanProgress(steps) {
  if (!steps || steps.length === 0) return { completed: 0, total: 0 };
  let completed = 0;
  let total = 0;

  const walk = (tasks) => {
    for (const t of tasks) {
      if (t.subtasks && t.subtasks.length > 0) {
        walk(t.subtasks);
      } else {
        total++;
        if (
          t.state === "completed" ||
          t.state === "redundant" ||
          t.state === "skipped"
        ) {
          completed++;
        }
      }
    }
  };

  walk(steps);
  return { completed, total };
}

export function setDashboardState(updates) {
  Object.assign(dashboardState, updates);

  if (updates.plan !== undefined && dashboardState.plan) {
    const { completed, total } = computePlanProgress(
      dashboardState.plan.steps || [],
    );
    dashboardState.completedCount = completed;
    dashboardState.totalCount = total;
    if (dashboardState.plan.milestoneTitle) {
      dashboardState.milestoneTitle = dashboardState.plan.milestoneTitle;
    }
  }

  eventBus.emit("state_update", {
    data: {
      projectId: dashboardState.projectId,
      phase: dashboardState.phase,
      turn: dashboardState.turn,
      tokens: dashboardState.tokens,
      aiStatus: dashboardState.aiStatus,
      lastAction: dashboardState.lastAction,
      project: dashboardState.project,
      sessionTask: dashboardState.sessionTask,
      elapsedTime: dashboardState.elapsedTime,
      currentSubtask: dashboardState.activeTaskId,
      progress: `${dashboardState.completedCount}/${dashboardState.totalCount}`,
    },
  });

  if (updates.plan !== undefined) {
    eventBus.emit("plan_update", { plan: dashboardState.plan });
    eventBus.emit("progress_update", {
      completed: dashboardState.completedCount,
      total: dashboardState.totalCount,
      milestoneTitle: dashboardState.milestoneTitle,
    });
  }

  if (
    updates.activeTaskId !== undefined ||
    updates.failedTaskId !== undefined
  ) {
    const taskId = dashboardState.activeTaskId || dashboardState.failedTaskId;
    const state = dashboardState.failedTaskId
      ? "failed"
      : dashboardState.activeTaskId
        ? "in_progress"
        : "completed";
    if (taskId != null) {
      eventBus.emit("task_state_change", { taskId, state });
    }
  }
}

export function initDashboard() {}
export function stopDashboard() {}
export function suspendDashboardForPrompt() {}
export function resumeDashboardAfterPrompt() {}
