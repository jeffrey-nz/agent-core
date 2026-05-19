// Standalone placeholder phrases (outside comments) that signal lazy output
const PLACEHOLDER_PHRASES = [
  "styles go here",
  "code goes here",
  "logic goes here",
  "insert code here",
  "your code here",
  "add your code here",
  "implementation goes here",
  "implementation details here",
  "write your code here",
  "fill in the implementation",
  "add implementation here",
];

// Truncation keywords inside comments ("// ... existing code" etc.)
const TRUNCATION_KEYWORDS = [
  "existing",
  "unchanged",
  "rest",
  "skip",
  "previous",
  "omitted",
  "same as before",
  "same as above",
  "keep existing",
  "keep the rest",
  "other methods",
  "remaining methods",
  "other routes",
  "other endpoints",
  "more items",
];

export function containsTruncationMarkers(content) {
  if (!content) return false;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();

    // Standalone placeholder phrases (not inside comments)
    if (PLACEHOLDER_PHRASES.some((p) => line.includes(p))) return true;

    // A line that is *only* an ellipsis (Python-style placeholder / stub)
    if (line === "..." || line === "…") return true;

    // Lines that contain "..." or "…" merit further inspection
    const hasEllipsis = line.includes("...") || line.includes("…");

    if (!hasEllipsis) continue;

    // Detect comment prefix: //, #, /*, <!-- , --, ;;, %
    const htmlCommentStart = "<" + "!--";
    const isComment =
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("#") ||
      line.startsWith(htmlCommentStart) ||
      line.startsWith("--") ||
      line.startsWith(";;") ||
      line.startsWith("%");

    if (isComment) {
      if (TRUNCATION_KEYWORDS.some((kw) => line.includes(kw))) return true;

      // Comments that are *only* "// ..." or "// ... ..." with no meaningful text
      // are almost always lazy output markers (e.g. "// ..." at end of a class)
      const stripped = line
        .replace(/^\/\/\s*|^#\s*|^\/\*\s*|^<!--\s*|^--\s*|^;;\s*|^%\s*/, "")
        .replace(/\s*\*\/\s*$/, "")
        .trim();
      if (/^\.{2,}$/.test(stripped) || /^…+$/.test(stripped)) return true;
    }
  }

  return false;
}

export function detectLazyTruncation(executionOps) {
  const errors = [];

  if (executionOps.files) {
    for (const file of executionOps.files) {
      if (containsTruncationMarkers(file.content)) {
        errors.push(
          `Validation Error: Lazy truncation or placeholder detected in write_file for -> ${file.filePath}. You MUST output the full, 100% complete file content without skipping lines or using placeholders like "/* styles go here */" or "// ... existing code".`,
        );
      }
    }
  }

  if (executionOps.patches) {
    for (const patch of executionOps.patches) {
      if (containsTruncationMarkers(patch.newBlock)) {
        errors.push(
          `Validation Error: Lazy truncation detected in patch_file for -> ${patch.filePath}. Do not use "// ... existing code", "// ... rest of methods", or any placeholder in your replacement blocks. Output the full replacement content.`,
        );
      }
    }
  }

  return errors;
}
