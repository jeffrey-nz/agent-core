import fs from "node:fs";
import path from "node:path";

export function freezeEvidence(rootDir, bundlePath) {
  const freezePath = path.join(rootDir, ".copilot-final-evidence.json");
  fs.copyFileSync(bundlePath, freezePath);
  return freezePath;
}
