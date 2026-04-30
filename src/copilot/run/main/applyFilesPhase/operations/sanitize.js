export function sanitizeCode(rawContent) {
  if (!rawContent) return "";

  return (
    rawContent

      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")

      .replace(/\xA0/g, " ")
      .replace(/[\u202F\u2007\u2002\u2003]/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")

      .replace(/\r\n/g, "\n")

      .trimEnd() + "\n"
  );
}
