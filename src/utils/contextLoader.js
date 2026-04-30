import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { getSessionDir } from "#copilot/run/main/sessionState/paths.js";
import { initVectorDb, searchSimilarChunks } from "#lib/rag/vectorDb.js";
import { readMemoryFile } from "#docs/memory.js";

export async function loadProjectContextFiles(
  projectId,
  projectDir,
  ignorePatterns = [],
  taskPrompt = "",
) {
  let context = "";

  try {
    const cheatPath = path.join(
      process.cwd(),
      "projects",
      projectId,
      "cheatsheet.md",
    );
    const content = await fs.readFile(cheatPath, "utf8");
    if (!content.includes("_To be filled in._") && content.trim().length > 20) {
      context += `[DEVELOPER CHEATSHEET]\n${content}\n\n`;
      log(colors.dim(`  Loaded project cheatsheet.`));
    }
  } catch (e) {}

  // Load the project memory bank (docs/memory/) — architecture patterns, tech context,
  // and current focus maintained across sessions by memoryUpdateNode.
  try {
    const [patterns, ctx, active] = await Promise.all([
      readMemoryFile(projectDir, "patterns.md"),
      readMemoryFile(projectDir, "context.md"),
      readMemoryFile(projectDir, "active.md"),
    ]);
    const combined = [patterns, ctx, active]
      .map((c) => c?.replace(/<!--[\s\S]*?-->/g, "").trim())
      .filter((c) => c && c.length > 30)
      .join("\n\n");
    if (combined.length > 30) {
      context += `[PROJECT MEMORY — accumulated from prior sessions]\n${combined.slice(0, 10000)}\n\n`;
      log(colors.dim(`  Loaded project memory bank (docs/memory/).`));
    }
  } catch (e) {}

  try {
    const sessionDir = await getSessionDir(projectId);
    const statusContent = await fs.readFile(
      path.join(sessionDir, ".ai-status.md"),
      "utf8",
    );
    context += `[PREVIOUS SESSION STATUS]\n${statusContent}\n\n`;
    log(colors.dim(`  Loaded session status report.`));
  } catch (e) {}

  try {
    if (taskPrompt) {
      if (!process.env.OPENAI_API_KEY) {
        log(
          colors.dim(`  Skipping RAG Vector DB query (OPENAI_API_KEY not set)`),
        );
      } else {
        log(colors.dim(`  Querying RAG Vector DB for relevant context...`));

        const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const db = await initVectorDb(projectId);
        const { embedding } = await embed({
          model: openai.embedding("text-embedding-3-small"),
          value: taskPrompt,
        });

        const topChunks = searchSimilarChunks(db, embedding, 10);

        if (topChunks.length > 0) {
          context += `[SEMANTICALLY RELEVANT CODE SNIPPETS]\n`;
          for (const chunk of topChunks) {
            context += `--- File: ${chunk.filepath} | Type: ${chunk.type} | Name: ${chunk.name} ---\n${chunk.content}\n\n`;
          }
          log(
            colors.green(
              `  Injected ${topChunks.length} highly relevant code chunks into context.`,
            ),
          );
        }
      }
    }
  } catch (e) {
    log(
      colors.yellow(
        `  RAG query failed (falling back to exploration mode): ${e.message}`,
      ),
    );
  }

  return context || null;
}

/**
 * Loads the Commands and Gotchas sections from docs/memory/context.md.
 * Used by coderNode to inject targeted fix recipes without loading the full memory bank.
 */
export async function loadProceduralKnowledge(projectDir) {
  try {
    const content = await readMemoryFile(projectDir, "context.md");
    const match = content.match(/^## (?:Commands|Gotchas)([\s\S]*?)(?=\n## |\n# |$)/m);
    if (!match) return null;
    const body = content
      .replace(/<!--[\s\S]*?-->/g, "")
      .match(/^(## Commands[\s\S]*?)(?=\n## [^CG]|\n# |$)/m)?.[0]
      ?.trim();
    return body && body.length > 10 ? body : null;
  } catch {
    return null;
  }
}
