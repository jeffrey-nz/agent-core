export function containsTruncationMarkers(content) {
  if (!content) return false;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();

    if (
      line.includes("styles go here") ||
      line.includes("code goes here") ||
      line.includes("logic goes here") ||
      line.includes("insert code here")
    ) {
      return true;
    }

    if (!line.includes("...") && !line.includes("…")) {
      continue;
    }

    const htmlCommentStart = "<" + "!--";
    const isComment =
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("#") ||
      line.startsWith(htmlCommentStart);

    if (isComment) {
      if (
        line.includes("existing") ||
        line.includes("unchanged") ||
        line.includes("rest") ||
        line.includes("skip") ||
        line.includes("previous")
      ) {
        return true;
      }
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
          `Validation Error: Lazy truncation or placeholder detected in write_file for -> ${file.filePath}. You MUST output the full, 100% complete file content without skipping lines or using placeholders like "/* styles go here */".`,
        );
      }
    }
  }

  if (executionOps.patches) {
    for (const patch of executionOps.patches) {
      if (containsTruncationMarkers(patch.newBlock)) {
        errors.push(
          `Validation Error: Lazy truncation detected in patch_file for -> ${patch.filePath}. Do not use "// ... existing code" or placeholders in your replacement blocks.`,
        );
      }
    }
  }

  return errors;
}
