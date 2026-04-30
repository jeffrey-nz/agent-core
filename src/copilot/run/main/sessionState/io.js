import { traceWarn } from "#app/ui/trace.js";
import { getSessionDb } from "./db.js";

export async function loadSessionState(projectId, sessionId) {
  if (!sessionId) return null;
  try {
    const db = await getSessionDb();
    const row = db
      .prepare("SELECT data FROM sessions WHERE id = ? AND projectId = ?")
      .get(sessionId, projectId);
    return row ? JSON.parse(row.data) : null;
  } catch (err) {
    traceWarn("SESSION", `Failed to load session state: ${err.message}`);
    return null;
  }
}

export async function saveSessionState(projectId, sessionId, state) {
  if (!projectId || !state || !sessionId) return;
  try {
    const db = await getSessionDb();

    state.updatedAt = new Date().toISOString();
    if (!state.startedAt) state.startedAt = state.updatedAt;
    state.id = sessionId;

    const stmt = db.prepare(`
      INSERT INTO sessions (id, projectId, status, updatedAt, data)
      VALUES (@id, @projectId, @status, @updatedAt, @data)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updatedAt = excluded.updatedAt,
        data = excluded.data
    `);

    stmt.run({
      id: sessionId,
      projectId,
      status: state.status || "in_progress",
      updatedAt: state.updatedAt,
      data: JSON.stringify(state),
    });
  } catch (err) {
    traceWarn("SESSION", `Failed to save session state: ${err.message}`);
  }
}

export async function clearSessionState(projectId, sessionId) {
  if (!projectId || !sessionId) return;
  try {
    const db = await getSessionDb();
    db.prepare("DELETE FROM sessions WHERE id = ? AND projectId = ?").run(
      sessionId,
      projectId,
    );
  } catch (err) {
    traceWarn("SESSION", `Failed to clear session state: ${err.message}`);
  }
}

export async function saveSegmentCheckpoint(projectId, sessionId, segmentData) {
  if (!projectId || !sessionId || !segmentData) return;
  try {
    const state = (await loadSessionState(projectId, sessionId)) || {};
    if (!Array.isArray(state.copilot365Segments)) {
      state.copilot365Segments = [];
    }
    state.copilot365Segments.push({
      index: segmentData.segmentIndex,
      endedAt: segmentData.timestamp || new Date().toISOString(),
      messageCount: segmentData.previousMessageCount,
      gitDiffStat: segmentData.gitDiffStat || "",
    });
    await saveSessionState(projectId, sessionId, state);
  } catch (err) {
    traceWarn("SESSION", `Failed to save segment checkpoint: ${err.message}`);
  }
}
