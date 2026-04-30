import { traceWarn } from "#app/ui/trace.js";
import { getSessionDb } from "./db.js";

export async function listSessions(projectId) {
  try {
    const db = await getSessionDb();
    const rows = db
      .prepare(
        "SELECT data FROM sessions WHERE projectId = ? ORDER BY updatedAt DESC",
      )
      .all(projectId);

    return rows.map((row) => JSON.parse(row.data));
  } catch (err) {
    traceWarn("SESSION", `Failed to list sessions: ${err.message}`);
    return [];
  }
}
