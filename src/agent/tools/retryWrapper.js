/**
 * Retry wrapper for transient tool failures.
 * Provides exponential backoff with jitter for retryable errors.
 */

/**
 * Determines if an error should be retried based on error code or retryable flag.
 * @param {Error} err - The error thrown
 * @returns {boolean}
 */
function isRetryableError(err) {
  // Explicit retryable flag from lower-level handlers
  if (err.retryable === true) return true;
  // Standard Node.js error codes for transient conditions
  const retryableCodes = new Set(['EBUSY', 'EEXIST', 'ETIMEDOUT']);
  return err.code && retryableCodes.has(err.code);
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter.
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelay - Base delay in ms
 * @param {number} factor - Exponential factor
 * @param {number} maxDelay - Maximum delay in ms
 * @returns {number}
 */
function calculateDelay(attempt, baseDelay, factor, maxDelay) {
  const exponentialDelay = baseDelay * Math.pow(factor, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  // Add jitter: random between 0 and cappedDelay
  const jitter = Math.random() * cappedDelay;
  return Math.floor(jitter);
}

/**
 * Wraps an async function with retry logic for transient failures.
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [options.baseDelay=500] - Initial delay in ms
 * @param {number} [options.factor=2] - Exponential backoff factor
 * @param {number} [options.maxDelay=5000] - Maximum delay in ms
 * @param {string} [options.toolName] - Name of the tool for logging
 * @param {Function} [options.shouldRetry] - Optional custom retry predicate (err, result) => boolean
 * @returns {Promise<any>} - Result of fn if successful
 * @throws {Error} - Throws the last error if all retries exhausted
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 500,
    factor = 2,
    maxDelay = 5000,
    toolName = 'unknown',
    shouldRetry = null
  } = options;

  let lastError;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const result = await fn();
      // If the function succeeded, return the result immediately
      return result;
    } catch (err) {
      lastError = err;

      // Determine if this error is retryable
      let retryable = isRetryableError(err);
      if (shouldRetry && !retryable) {
        // Custom retry predicate may override (e.g., based on exit code)
        retryable = shouldRetry(err, null);
      }

      if (!retryable || attempt === maxRetries) {
        // Not retryable or no attempts left: rethrow
        throw err;
      }

      // Log retry attempt
      const delayMs = calculateDelay(attempt, baseDelay, factor, maxDelay);
      console.warn(
        `[Retry] Tool "${toolName}" failed (attempt ${attempt + 1}/${maxRetries}) with error: ${err.message || err.code || err}. ` +
        `Retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
      attempt++;
    }
  }

  // Should never reach here, but TypeScript safety
  throw lastError;
}
