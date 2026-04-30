import { promises as fs } from "node:fs";
import path from "node:path";
import { loadProjectContextFiles } from "#utils/contextLoader.js";
import { detectProjectContext } from "#utils/detectProjectContext.js";
import { execAsync } from "#utils/exec.js";

/**
 * Runs pre-scoping research against the project directory before the first
 * clarifying question is asked. Returns a structured snapshot that is injected
 * into the scoping prompt so the AI asks informed, targeted questions instead
 * of rediscovering information already in the codebase.
 */
export async function buildScopingResearch(projectId, projectDir, task) {
  const [contextFiles, fileSnapshot] = await Promise.all([
    loadProjectContextFiles(projectId, projectDir, [], task).catch(() => null),
    buildFileSnapshot(projectDir),
  ]);

  let detectedCtx = null;
  try {
    detectedCtx = detectProjectContext(projectDir);
  } catch {
    /* non-fatal */
  }

  return {
    projectType: detectedCtx?.projectType || null,
    constraints: detectedCtx?.constraints || null,
    contextFiles,
    fileSnapshot,
  };
}

/**
 * Lists the top-level and one-level-deep file structure of the project,
 * excluding large generated directories.
 */
async function buildFileSnapshot(projectDir) {
  if (!projectDir) return null;
  try {
    const IGNORE = new Set([
      "node_modules",
      "vendor",
      ".git",
      "dist",
      "build",
      ".cache",
      ".next",
      "coverage",
    ]);
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const lines = [];
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      if (e.isDirectory()) {
        lines.push(`${e.name}/`);
        const sub = await fs
          .readdir(path.join(projectDir, e.name))
          .catch(() => []);
        for (const f of sub.slice(0, 20)) lines.push(`  ${e.name}/${f}`);
      } else {
        lines.push(e.name);
      }
    }
    return lines.join("\n").slice(0, 1500) || null;
  } catch {
    return null;
  }
}

/**
 * After each user clarification answer, extracts key terms (quoted strings,
 * CamelCase identifiers, file name mentions) and runs targeted greps to
 * surface files containing those terms. Returns a compact context string or
 * null if nothing useful was found.
 */
export async function enrichFromAnswer(projectDir, answer) {
  if (!projectDir || !answer) return null;
  const terms = extractKeyTerms(answer);
  if (terms.length === 0) return null;

  const results = [];
  for (const term of terms.slice(0, 3)) {
    try {
      const { stdout } = await execAsync(
        `grep -r --include="*.php" --include="*.js" --include="*.ts" --include="*.ss" -l ${JSON.stringify(term)} ${JSON.stringify(projectDir)} 2>/dev/null | head -5`,
        { timeout: 5000 },
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        // Show relative paths
        const relPaths = trimmed
          .split("\n")
          .map((p) => p.replace(projectDir + path.sep, "").replace(projectDir + "/", ""))
          .join(", ");
        results.push(`Files containing "${term}": ${relPaths}`);
      }
    } catch {
      /* non-fatal — grep failed or timed out */
    }
  }
  return results.length > 0 ? results.join("\n") : null;
}

/**
 * Extracts searchable terms from a user's answer:
 * - Quoted strings ("ClassName", 'method_name')
 * - CamelCase identifiers (ClassName, MyModule)
 * - File name mentions (filename.php, config.js)
 */
function extractKeyTerms(text) {
  const quoted = [...text.matchAll(/"([^"]{3,})"|'([^']{3,})'/g)].map(
    (m) => m[1] || m[2],
  );
  const camel = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const files = text.match(/\b\w+\.(php|js|ts|ss|css|json|yml|yaml)\b/g) || [];
  return [...new Set([...quoted, ...camel, ...files])].filter(
    (t) => t.length > 3 && t.length < 60,
  );
}
