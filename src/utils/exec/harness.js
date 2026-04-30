export function normalizeResult({ status, stdout = "", stderr = "" }) {
  return {
    status,
    stdout: stdout ? String(stdout).trim() : "",
    stderr: stderr ? String(stderr).trim() : "",
    success: status === 0,
  };
}

export function withHarness(run, options = {}) {
  const timeoutMs = options.timeout || 60000;
  const userSignal = options.signal;

  return new Promise((resolve) => {
    const ac = new AbortController();
    let timeoutId = null;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        ac.abort(new Error(`[ERROR] Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    if (userSignal) {
      userSignal.addEventListener("abort", () => ac.abort(userSignal.reason));
    }

    run(ac.signal, (result) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve(normalizeResult(result));
    });
  });
}
