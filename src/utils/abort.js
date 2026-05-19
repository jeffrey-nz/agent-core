export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason && reason.name === "AbortError") throw reason;
  const err = Object.assign(new Error(reason?.message || "Aborted"), { name: "AbortError" });
  throw err;
}
