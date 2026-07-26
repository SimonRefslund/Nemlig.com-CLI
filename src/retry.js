/**
 * Both nemlig.com and goma.gg occasionally return 429/5xx under load. Retrying
 * these makes long-running commands (notably `compare`, which issues one
 * request per basket line) survive a blip instead of failing the whole run.
 *
 * Only idempotent reads should be retried; basket writes must not be.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

function retryDelay(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(300 * 2 ** attempt, 4_000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `attempt(attemptNumber)` until it returns a non-retryable response.
 * `attempt` must return a Response; network-level throws are retried too.
 */
export async function withRetry(attempt, {
  retries = Number(process.env.NEMLIG_RETRIES ?? 2),
  wait = sleep,
} = {}) {
  const limit = Number.isFinite(retries) && retries >= 0 ? retries : 2;
  let lastError;

  for (let index = 0; index <= limit; index += 1) {
    try {
      const response = await attempt(index);
      if (index < limit && isRetryableStatus(response?.status)) {
        await wait(retryDelay(index, response.headers?.get?.("retry-after")));
        continue;
      }
      return response;
    } catch (error) {
      // A timeout means the request itself was given up on; retrying would
      // multiply the wait the user already chose to cap.
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
      lastError = error;
      if (index >= limit) throw error;
      await wait(retryDelay(index));
    }
  }
  throw lastError;
}

export const internals = { retryDelay };
