export const MAX_TOOL_STEPS = 12;

export const REQUIRE_WRITE_FILE =
  String(process.env.COPILOT_HELPER_REQUIRE_WRITE ?? "false").toLowerCase() ===
  "true";
