export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error("Aborted");
}
