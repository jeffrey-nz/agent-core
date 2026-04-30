import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";
import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { COMMON_IGNORE_DIRS, COMMON_IGNORE_FILES } from "#config/ignores.js";
import { initVectorDb, upsertChunks } from "./vectorDb.js";
import { chunkFileWithAST } from "./astChunker.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function indexProject(projectId, rootDir, ignore = []) {
  if (!process.env.OPENAI_API_KEY) {
    log(
      colors.yellow(
        `  [RAG] Skipping semantic indexing: OPENAI_API_KEY is not set.`,
      ),
    );
    return;
  }

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

  log(colors.dim(`\n  [RAG] Scanning ${rootDir} for semantic indexing...`));

  const ignores = [
    ...Array.from(COMMON_IGNORE_DIRS).map((d) => `**/${d}/**`),
    ...Array.from(COMMON_IGNORE_FILES).map((f) => `**/${f}`),
    ...ignore,
  ];

  const files = await fg(["**/*.js", "**/*.php", "**/*.ts", "**/*.jsx"], {
    cwd: rootDir,
    ignore: ignores,
    absolute: true,
  });

  const db = await initVectorDb(projectId);
  let totalChunks = 0;

  for (const file of files) {
    const relPath = path.relative(rootDir, file);
    try {
      const content = await fs.readFile(file, "utf8");
      const chunks = chunkFileWithAST(relPath, content);

      const { embeddings } = await embedMany({
        model: openai.embedding("text-embedding-3-small"),
        values: chunks.map(
          (c) =>
            `File: ${relPath}\nType: ${c.type}\nName: ${c.name}\n\n${c.content}`,
        ),
      });

      const dbRecords = chunks.map((c, i) => ({
        id: `${relPath}::${c.name}::${i}`,
        filepath: relPath,
        type: c.type,
        name: c.name,
        content: c.content,
        embedding: embeddings[i],
      }));

      upsertChunks(db, dbRecords);
      totalChunks += dbRecords.length;
    } catch (err) {
      log(colors.dim(`  [RAG] Skipped ${relPath}: ${err.message}`));
    }
  }

  log(colors.green(`  [RAG] Indexed ${totalChunks} semantic chunks.`));
}
