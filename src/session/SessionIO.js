export function exportSession(session) {
  return JSON.stringify(
    {
      ...session.toJSON(),
      summary: {
        durationMs: Date.now() - session.startedAt,
        filesModified: session.modifiedFiles.length,
        endedReason: session.endedReason,
      },
    },
    null,
    2,
  );
}

export function importSession(json) {
  return JSON.parse(json);
}
