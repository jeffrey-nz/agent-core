import fs from "node:fs/promises";
import path from "node:path";
import { stripCommentsPreservingSome } from "#tools/stripFormat/stripper.js";

function normalizeNewlines(s) {
  return String(s).replace(/\r\n/g, "\n");
}

export async function processFile(
  root,
  filePath,
  { dryRun = false, keepDirectives = false } = {},
) {
  const abs = path.resolve(root, filePath);

  const original = await fs.readFile(abs, "utf8");
  const input = normalizeNewlines(original);

  const stripped = stripCommentsPreservingSome(input, { keepDirectives });

  if (stripped === input) return { changed: false };

  if (!dryRun) {
    await fs.writeFile(abs, stripped, "utf8");
  }

  return { changed: true };
}
