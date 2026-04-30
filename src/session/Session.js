export class Session {
  constructor(id, provider) {
    this.id = id;
    this.provider = provider;
    this.startedAt = Date.now();
    this.phase = "EXPLORE";
    this.messages = [];
    this.modifiedFiles = [];
    this.diagnosticsRun = false;
    this.endedReason = null;
  }

  setPhase(phase) {
    this.phase = phase;
  }

  addMessage(msg) {
    this.messages.push(msg);
  }

  markFileModified(filePath) {
    if (!this.modifiedFiles.includes(filePath)) {
      this.modifiedFiles.push(filePath);
    }
  }

  markDiagnosticsRun() {
    this.diagnosticsRun = true;
  }

  end(reason = "completed") {
    this.endedReason = reason;
  }

  toJSON() {
    return {
      id: this.id,
      provider: this.provider,
      startedAt: this.startedAt,
      phase: this.phase,
      messages: this.messages,
      modifiedFiles: this.modifiedFiles,
      diagnosticsRun: this.diagnosticsRun,
      endedReason: this.endedReason,
    };
  }
}
