import fs from "node:fs/promises";
import path from "node:path";

// Language-specific signature patterns. Each entry is a regex tested against
// the trimmed line; matching lines are included in the outline.
const LANG_PATTERNS = {
  // JavaScript / TypeScript
  js: [
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:class|function)\s+[a-zA-Z0-9_$]+/,
    /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s+)?(?:function|\(|[a-zA-Z0-9_$]+\s*=>)/,
    /^import\s+/,
  ],
  ts: [
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:abstract\s+)?(?:class|function|interface|type|enum)\s+[a-zA-Z0-9_$]+/,
    /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*[=:]/,
    /^import\s+/,
  ],
  // PHP — class declarations, method declarations (any visibility/modifier combo)
  php: [
    /^(?:abstract\s+|final\s+)?class\s+[a-zA-Z0-9_]+/,
    /^interface\s+[a-zA-Z0-9_]+/,
    /^trait\s+[a-zA-Z0-9_]+/,
    /^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+[a-zA-Z0-9_]+/,
    /^use\s+[a-zA-Z0-9_\\]+/,
  ],
  // Python
  py: [
    /^(?:async\s+)?def\s+[a-zA-Z0-9_]+/,
    /^class\s+[a-zA-Z0-9_]+/,
    /^import\s+/,
    /^from\s+\S+\s+import\s+/,
  ],
};

function getPatternsForExt(ext) {
  const map = {
    ".js": LANG_PATTERNS.js,
    ".mjs": LANG_PATTERNS.js,
    ".cjs": LANG_PATTERNS.js,
    ".jsx": LANG_PATTERNS.js,
    ".ts": LANG_PATTERNS.ts,
    ".tsx": LANG_PATTERNS.ts,
    ".php": LANG_PATTERNS.php,
    ".py": LANG_PATTERNS.py,
  };
  // Default: JS patterns (reasonable for unknown text files)
  return map[ext] ?? LANG_PATTERNS.js;
}

export async function getFileOutline(rootDir, targetPath) {
  const absPath = path.resolve(rootDir, targetPath);

  if (!absPath.startsWith(path.resolve(rootDir))) {
    return `[Error] Path out of bounds.`;
  }

  let content;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch (err) {
    return `[Error] Could not outline file: ${err.message}`;
  }

  const ext = path.extname(absPath).toLowerCase();
  const patterns = getPatternsForExt(ext);
  const lines = content.split("\n");
  const outline = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (patterns.some((re) => re.test(trimmed))) {
      outline.push(`${i + 1} | ${trimmed}`);
    }
  }

  if (outline.length === 0) {
    return `[Info] No major structural signatures (functions/classes) detected in ${targetPath}.`;
  }

  return `Structural Outline of ${targetPath}:\n\`\`\`\n${outline.join("\n")}\n\`\`\`\n*(Use read_file with start_line and end_line to inspect specific lines)*`;
}
