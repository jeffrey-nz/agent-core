import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";

let dbInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  const dbDir = path.join(process.cwd(), ".copilot-sessions");
  await fs.mkdir(dbDir, { recursive: true });
  dbInstance = new Database(path.join(dbDir, "benchmark.sqlite"));
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      scenarioId TEXT NOT NULL,
      provider TEXT,
      startedAt INTEGER NOT NULL,
      completedAt INTEGER,
      passed INTEGER,
      passCount INTEGER,
      failCount INTEGER,
      durationMs INTEGER,
      turns INTEGER,
      tokenCount INTEGER,
      modifiedFiles TEXT,
      logFile TEXT,
      errorMsg TEXT,
      testResults TEXT,
      phaseSummary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bench_scenario ON benchmark_runs(scenarioId);
    CREATE INDEX IF NOT EXISTS idx_bench_started ON benchmark_runs(startedAt DESC);
    PRAGMA journal_mode=WAL;
  `);
  // Schema migrations for existing databases
  for (const col of [
    "ALTER TABLE benchmark_runs ADD COLUMN provider TEXT",
    "ALTER TABLE benchmark_runs ADD COLUMN testResults TEXT",
    "ALTER TABLE benchmark_runs ADD COLUMN phaseSummary TEXT",
  ]) {
    try { dbInstance.exec(col); } catch {}
  }
  return dbInstance;
}

export async function saveRun(run) {
  const db = await getDb();
  db.prepare(`
    INSERT INTO benchmark_runs
      (id, scenarioId, provider, startedAt, completedAt, passed, passCount, failCount,
       durationMs, turns, tokenCount, modifiedFiles, logFile, errorMsg, testResults, phaseSummary)
    VALUES
      (@id, @scenarioId, @provider, @startedAt, @completedAt, @passed, @passCount, @failCount,
       @durationMs, @turns, @tokenCount, @modifiedFiles, @logFile, @errorMsg, @testResults, @phaseSummary)
  `).run({
    id: run.id,
    scenarioId: run.scenarioId,
    provider: run.provider ?? null,
    startedAt: run.startedAt ?? Date.now(),
    completedAt: run.completedAt ?? null,
    passed: run.passed != null ? (run.passed ? 1 : 0) : null,
    passCount: run.passCount ?? null,
    failCount: run.failCount ?? null,
    durationMs: run.durationMs ?? null,
    turns: run.turns ?? null,
    tokenCount: run.tokenCount ?? null,
    modifiedFiles: run.modifiedFiles ? JSON.stringify(run.modifiedFiles) : null,
    logFile: run.logFile ?? null,
    errorMsg: run.errorMsg ?? null,
    testResults: null,
    phaseSummary: null,
  });
}

export async function updateRun(id, fields) {
  const db = await getDb();
  const allowed = ["completedAt", "passed", "passCount", "failCount", "durationMs",
                   "turns", "tokenCount", "modifiedFiles", "logFile", "errorMsg", "provider",
                   "testResults", "phaseSummary"];
  const sets = [];
  const values = {};
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = @${key}`);
      values[key] = key === "passed"
        ? (fields[key] != null ? (fields[key] ? 1 : 0) : null)
        : (key === "modifiedFiles" || key === "testResults" || key === "phaseSummary") && fields[key] != null
        ? JSON.stringify(fields[key])
        : (fields[key] ?? null);
    }
  }
  if (sets.length === 0) return;
  values.id = id;
  db.prepare(`UPDATE benchmark_runs SET ${sets.join(", ")} WHERE id = @id`).run(values);
}

function rowToRun(row) {
  if (!row) return null;
  return {
    ...row,
    passed: row.passed != null ? Boolean(row.passed) : null,
    modifiedFiles: row.modifiedFiles ? JSON.parse(row.modifiedFiles) : [],
    testResults: row.testResults ? JSON.parse(row.testResults) : null,
    phaseSummary: row.phaseSummary ? JSON.parse(row.phaseSummary) : null,
  };
}

export async function getRuns(scenarioId) {
  const db = await getDb();
  const rows = scenarioId
    ? db.prepare("SELECT * FROM benchmark_runs WHERE scenarioId = ? ORDER BY startedAt DESC").all(scenarioId)
    : db.prepare("SELECT * FROM benchmark_runs ORDER BY startedAt DESC LIMIT 100").all();
  return rows.map(rowToRun);
}

export async function getRunById(id) {
  const db = await getDb();
  return rowToRun(db.prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id));
}
