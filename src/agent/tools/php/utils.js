export const trimTail = (str = "") => {
  if (str.length <= 4000) return str;
  return (
    "...[HEAD TRUNCATED — showing tail where errors appear]...\n" +
    str.slice(-4000)
  );
};

export const smartExtractErrors = (str = "") => {
  if (str.length <= 4000) return str;

  const lines = str.split("\n");
  const importantLines = [];
  let captureMode = false;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    if (
      lower.includes("problem 1") ||
      lower.includes("fatal error:") ||
      lower.includes("error [emergency]") ||
      lower.includes("error [alert]") ||
      lower.includes("parse error:") ||
      lower.includes("there was 1 error") ||
      lower.includes("there were ") ||
      lower.includes("failures!") ||
      lower.includes("exception:") ||
      lower.startsWith("failed asserting")
    ) {
      captureMode = true;

      if (i > 2 && importantLines.length === 0) {
        importantLines.push("... [Standard Output Truncated] ...");
        importantLines.push(lines[i - 2]);
        importantLines.push(lines[i - 1]);
      }
    }

    if (captureMode) {
      importantLines.push(lines[i]);
    }
  }

  if (importantLines.length > 0) {
    const extracted = importantLines.join("\n");
    if (extracted.length <= 6000) {
      return `[SMART ERROR EXTRACTION APPLIED]\n${extracted}`;
    }
  }

  return trimTail(str);
};
