export function validateSearchQuery(query) {
  if (!query || !String(query).trim()) {
    return { valid: false, error: `[Error] Empty search query.` };
  }
  let cleanQuery = String(query).trim();
  if (cleanQuery.includes("\n")) {
    const lines = cleanQuery.split("\n").map((l) => l.trim());
    const queryLine = lines.find((l) => l.toLowerCase().startsWith("query:"));
    cleanQuery = queryLine
      ? queryLine.replace(/^query:\s*/i, "").trim()
      : lines[0];
  }
  if (cleanQuery.length < 3 && /^[a-zA-Z0-9]+$/.test(cleanQuery)) {
    return {
      valid: false,
      error: `<search_results query="${cleanQuery}">[Error] Query "${cleanQuery}" is too short and generic.</search_results>\n\n`,
    };
  }
  return { valid: true, sanitizedQuery: cleanQuery };
}
