export function requireArtifact({ artifactPath, wasRead }) {
  if (!wasRead) {
    throw new Error(
      `Subtask cannot complete: required artifact was not read (${artifactPath})`,
    );
  }
}
