import fs from "node:fs";
import path from "node:path";

export function writeVerificationBundle({
  outDir,
  summary,
  testResults,
  warnings,
  capabilities,
}) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const bundle = {
    timestamp: new Date().toISOString(),
    environment: capabilities,
    summary,
    testResults,
    compilerWarnings: warnings,
  };

  const outPath = path.join(outDir, "verification.json");
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf8");

  return outPath;
}
