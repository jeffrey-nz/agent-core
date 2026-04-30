import path from "node:path";

export function formatSearchResults(query, stdout, rootDir) {
  const lines = stdout.split("\n").filter(Boolean);
  const limit = 30;
  const maxLineLength = 120;

  const absoluteLines = lines.map((line) => {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      const [_, relPath, lineNum, content] = match;
      return `${path.join(rootDir, relPath).replace(/\\/g, "/")}:${lineNum}:${content}`;
    }
    return line;
  });

  let formattedLines = absoluteLines
    .slice(0, limit)
    .map((line) =>
      line.length > maxLineLength ? line.slice(0, maxLineLength) + "..." : line,
    )
    .join("\n");

  let output = `<search_results query="${query}">\n${formattedLines}\n`;
  if (lines.length > limit) {
    output += `... (${lines.length - limit} more results truncated. Refine search or use read_file)\n`;
  }
  output += `</search_results>\n\n`;
  return output;
}
