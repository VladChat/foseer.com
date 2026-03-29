// File: qwen-scripts/utils/retry-policy.js
// Purpose: Small bounded retry/backoff helpers for transient upstream failures.

const DEFAULT_MAX_ATTEMPTS = clampInteger(process.env.QWEN_API_RETRY_MAX_ATTEMPTS, 3, 1, 5);
const DEFAULT_BASE_DELAY_MS = clampInteger(process.env.QWEN_API_RETRY_BASE_DELAY_MS, 700, 100, 5000);
const DEFAULT_MAX_DELAY_MS = clampInteger(process.env.QWEN_API_RETRY_MAX_DELAY_MS, 6000, 250, 20000);
const DEFAULT_JITTER_MS = clampInteger(process.env.QWEN_API_RETRY_JITTER_MS, 250, 0, 2000);

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const targetMs = Date.parse(raw);
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, targetMs - Date.now());
}

function computeBackoffDelayMs(attemptNumber, { baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS, jitterMs = DEFAULT_JITTER_MS } = {}) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attemptNumber - 1)));
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.min(maxDelayMs, exponential + jitter);
}

export function isRetryableHttpStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  const name = String(error?.name || '').toLowerCase();
  return name === 'aborterror'
    || message.includes('network')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('fetch failed')
    || message.includes('temporarily unavailable');
}

export async function fetchWithRetry({
  provider,
  label,
  url,
  options,
  log,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  jitterMs = DEFAULT_JITTER_MS,
  classifyResponse = (response) => isRetryableHttpStatus(response?.status),
}) {
  let attempt = 0;
  let totalDelayMs = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetch(url, options);
      const shouldRetry = attempt < maxAttempts && classifyResponse(response) === true;
      if (!shouldRetry) {
        return {
          response,
          attemptCount: attempt,
          retryCount: Math.max(0, attempt - 1),
          totalDelayMs,
        };
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const delayMs = retryAfterMs !== null
        ? Math.min(maxDelayMs, retryAfterMs)
        : computeBackoffDelayMs(attempt, { baseDelayMs, maxDelayMs, jitterMs });
      if (typeof log === 'function') {
        log(provider, {
          label,
          status: 'retry_scheduled',
          reason: `http_${response.status}`,
          attempt,
          retry_in_ms: delayMs,
          retry_after_ms: retryAfterMs,
        });
      }
      totalDelayMs += delayMs;
      await sleep(delayMs);
      continue;
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < maxAttempts && isRetryableNetworkError(error);
      if (!shouldRetry) {
        error.retryMeta = {
          attemptCount: attempt,
          retryCount: Math.max(0, attempt - 1),
          totalDelayMs,
        };
        throw error;
      }

      const delayMs = computeBackoffDelayMs(attempt, { baseDelayMs, maxDelayMs, jitterMs });
      if (typeof log === 'function') {
        log(provider, {
          label,
          status: 'retry_scheduled',
          reason: 'network_error',
          attempt,
          retry_in_ms: delayMs,
          error: error.message,
        });
      }
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }

  if (lastError) {
    lastError.retryMeta = {
      attemptCount: maxAttempts,
      retryCount: Math.max(0, maxAttempts - 1),
      totalDelayMs,
    };
    throw lastError;
  }

  throw new Error('fetchWithRetry exhausted without response');
}

export function getRetryPolicyStats() {
  return {
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    base_delay_ms: DEFAULT_BASE_DELAY_MS,
    max_delay_ms: DEFAULT_MAX_DELAY_MS,
    jitter_ms: DEFAULT_JITTER_MS,
  };
}
