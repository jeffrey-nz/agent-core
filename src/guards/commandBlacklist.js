const failedCommands = new Set();

export function recordFailure(command) {
  failedCommands.add(command);
}

export function isBlacklisted(command) {
  return failedCommands.has(command);
}
