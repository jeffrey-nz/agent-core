export function buildForceCompleteMessage() {
  return `[SYSTEM]
You are currently in EXECUTION mode.

Your next response MUST include ONE of:
1) A JSON tool call array
2) A NEED_FILES declaration
3) A WRITE_FILE block

If you are finished planning, say:
"Planning complete. Ready to execute."

Do NOT include explanations or summaries.
`;
}

export function buildReformatWriteFilesMessage(invalidWrites = []) {
  return `[SYSTEM]
Some WRITE_FILE blocks were malformed.
Please re-send corrected WRITE_FILE blocks only.
`;
}

export function buildRejectedWritesMessage(rejected = []) {
  return `[SYSTEM]
Some WRITE_FILE operations were rejected.
Please correct and re-submit only the affected files.
`;
}
