import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs/promises";
import cosineSimilarity from "compute-cosine-similarity";

export async function initVectorDb(projectId) {
  const dbDir = path.join(process.cwd(), ".copilot-sessions", projectId, "rag");
  await fs.mkdir(dbDir, { recursive: true });

  const db = new Database(path.join(dbDir, "vectors.sqlite"));

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      filepath TEXT,
      type TEXT,
      name TEXT,
      content TEXT,
      embedding JSON
    );
    CREATE INDEX IF NOT EXISTS idx_filepath ON chunks(filepath);
  `);

  return db;
}

export function upsertChunks(db, chunks) {
  const stmt = db.prepare(`
    INSERT INTO chunks (id, filepath, type, name, content, embedding)
    VALUES (@id, @filepath, @type, @name, @content, @embedding)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      embedding = excluded.embedding
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run({
        ...item,
        embedding: JSON.stringify(item.embedding),
      });
    }
  });

  insertMany(chunks);
}

export function searchSimilarChunks(db, queryEmbedding, limit = 10, filepathPrefix = null) {
  let sql = "SELECT * FROM chunks";
  const params = [];
  if (filepathPrefix) {
    sql += " WHERE filepath LIKE ?";
    params.push(`${filepathPrefix}%`);
  }
  const rows = db.prepare(sql).all(...params);

  const scored = rows.map((row) => {
    const vec = JSON.parse(row.embedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    return { ...row, score };
  });

  return scored
    .filter((r) => !isNaN(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
