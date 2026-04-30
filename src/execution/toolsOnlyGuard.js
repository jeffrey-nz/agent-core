export function enforceToolsOnly({ phaseState, output }) {
  if (phaseState.phase !== "EXECUTION") return;

  const isToolArray =
    Array.isArray(output) &&
    output.every(
      (item) => typeof item === "object" && typeof item.action === "string",
    );

  if (!isToolArray) {
    throw new Error(
      "Invalid execution output: tools-only JSON array required during EXECUTION phase.",
    );
  }
}
