import fs from "node:fs";
import path from "node:path";

export class ExecutionLedger {
  constructor(rootDir) {
    this.path = path.join(rootDir, ".copilot-execution-ledger.json");
    this.entries = [];
  }

  record(entry) {
    this.entries.push({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    fs.writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  load() {
    if (fs.existsSync(this.path)) {
      this.entries = JSON.parse(fs.readFileSync(this.path, "utf8"));
    }
  }

  hasRun(action) {
    return this.entries.some((e) => e.action === action);
  }
}
