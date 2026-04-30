import fs from "node:fs";

export function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      reason: "FILE_MISSING",
      message: `Required file does not exist: ${filePath}`,
    };
  }

  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    return {
      ok: false,
      reason: "FILE_UNREADABLE",
      message: `Required file exists but is not readable: ${filePath}`,
    };
  }

  return { ok: true };
}
