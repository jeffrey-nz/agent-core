import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

export function evaluateScenario(scenarioId) {
  return new Promise((resolve) => {
    const checkPath = path.resolve(process.cwd(), "projects/benchmark", scenarioId, "check.js");
    const output = [];
    let passCount = 0;
    let failCount = 0;

    const child = spawn(process.execPath, ["--test", "--no-warnings", checkPath], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 30_000,
    });

    child.stdout.on("data", (d) => output.push(d.toString()));
    child.stderr.on("data", (d) => output.push(d.toString()));

    child.on("close", (code) => {
      const full = output.join("");
      const tests = [];
      for (const line of full.split("\n")) {
        // Top-level "ok N - name" / "not ok N - name" lines.
        // Node v20 TAP is flat (no indentation for top-level tests), so we
        // capture both pass/fail counts AND push each top-level result into
        // tests[] so verifier feedback can list failing test names.
        const topLevel = line.match(/^(not ok|ok)\s+\d+\s*[-–]?\s*(.*)/);
        if (topLevel) {
          const passed = topLevel[1] === "ok";
          if (passed) passCount++; else failCount++;
          // Strip TAP diagnostic suffix (e.g. " # duration_ms 5.2") from the name
          const name = topLevel[2].replace(/\s*#.*$/, "").trim();
          if (name) tests.push({ name, passed });
          continue;
        }
        // Indented subtest lines (4+ spaces) — nested suite granularity
        const m = line.match(/^(\s{4,})(not ok|ok)\s+\d+\s*[-–]?\s*(.*)/);
        if (m) tests.push({ name: m[3].trim(), passed: m[2] === "ok" });
      }
      resolve({
        passed: code === 0,
        passCount,
        failCount,
        tests,
        output: full,
      });
    });

    child.on("error", (err) => {
      resolve({
        passed: false,
        passCount: 0,
        failCount: 1,
        output: err.message,
      });
    });
  });
}
