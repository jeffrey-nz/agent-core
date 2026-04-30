import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";

let dbInstance = null;

export async function getSessionDb() {
  if (dbInstance) return dbInstance;

  const dbDir = path.join(process.cwd(), ".copilot-sessions");
  await fs.mkdir(dbDir, { recursive: true });

  dbInstance = new Database(path.join(dbDir, "sessions.sqlite"));

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      status TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      data JSON NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_id ON sessions(projectId);
  `);

  return dbInstance;
}

/**
 * Synchronous — safe to call from a SIGINT/SIGTERM handler.
 * Marks any in-progress sessions as interrupted so the UI can show the correct
 * final status after a hard exit (Ctrl-C, kill signal, etc.).
 */
export function markInProgressSessionsAsInterrupted() {
  if (!dbInstance) return;
  try {
    dbInstance
      .prepare(`UPDATE sessions SET status = 'interrupted', updatedAt = ? WHERE status = 'in_progress'`)
      .run(new Date().toISOString());
  } catch {}
}
