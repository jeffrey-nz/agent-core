import fs from "node:fs";
import { parseStringPromise } from "xml2js";

export async function parseUnityTestResults(xmlPath) {
  const xml = fs.readFileSync(xmlPath, "utf8");
  const data = await parseStringPromise(xml);

  const run = data["test-run"];
  const summary = run.$;

  const failedCases = [];

  function walk(node) {
    if (node["test-case"]) {
      for (const tc of node["test-case"]) {
        if (tc.$?.result === "Failed") {
          failedCases.push(tc.$.fullname || tc.$.name);
        }
      }
    }
    if (node["test-suite"]) {
      node["test-suite"].forEach(walk);
    }
  }

  walk(run);

  return {
    total: Number(summary.total),
    passed: Number(summary.passed),
    failed: Number(summary.failed),
    failedCases,
  };
}
