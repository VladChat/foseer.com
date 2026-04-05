// File: qwen-scripts/utils/api-clients.js
// Purpose: Provider wrappers for Brave/GDELT/Google with shared cache TTL, offline-first reads, and optional manual live refresh.

import fs from 'node:fs';
import path from 'node:path';
import { readCacheEntry, writeCache, getCacheStats, DEFAULT_TTL_HOURS } from './cache-manager.js';
import { fetchWithRetry, getRetryPolicyStats, isRetryableHttpStatus } from './retry-policy.js';

const PROVIDER_STATUS = {
  SKIPPED_CONFIG: 'skipped_config',
  CACHE_HIT: 'cache_hit',
  STALE_CACHE_HIT: 'stale_cache_hit',
  CACHE_MISS_NO_NETWORK: 'cache_miss_no_network',
  CALLED_SUCCESS: 'called_success',
  AUTH_FAILURE: 'auth_failure',
  RATE_LIMIT: 'rate_limit',
  RATE_LIMIT_CIRCUIT_OPEN: 'rate_limit_circuit_open',
  REQUEST_CONSTRUCTION_FAILURE: 'request_construction_failure',
  UPSTREAM_RESPONSE_FAILURE: 'upstream_response_failure',
  LIVE_QUOTA_EXHAUSTED: 'live_quota_exhausted',
  NETWORK_DISABLED: 'network_disabled',
};

const SEARCH_NETWORK_MODE = (process.env.QWEN_SEARCH_NETWORK_MODE || 'cache_only').toLowerCase();
const SEARCH_NETWORK_ENABLED = SEARCH_NETWORK_MODE !== 'cache_only' && process.env.QWEN_DISABLE_SEARCH_NETWORK !== '1';
const MIN_SEARCH_INTERVAL_MS = Number(process.env.QWEN_MIN_SEARCH_INTERVAL_MS || 6000);
const LIVE_QUOTAS = {
  brave: Number(process.env.QWEN_BRAVE_MAX_LIVE_QUERIES || 5),
  gdelt: Number(process.env.QWEN_GDELT_MAX_LIVE_QUERIES || 2),
  google: Number(process.env.QWEN_GOOGLE_MAX_LIVE_QUERIES || 2),
};
const LIVE_RESCUE_RESERVED = {
  brave: Number(process.env.QWEN_BRAVE_RESCUE_RESERVED ?? 1),
  gdelt: Number(process.env.QWEN_GDELT_RESCUE_RESERVED ?? 1),
  google: Number(process.env.QWEN_GOOGLE_RESCUE_RESERVED ?? 1),
};
const BRAVE_RESCUE_MAX_LIVE_QUERIES = Number(process.env.QWEN_BRAVE_RESCUE_MAX_LIVE_QUERIES ?? 1);
const LIVE_PHASE_CAPS = {
  brave: {
    discovery: Number(process.env.QWEN_BRAVE_DISCOVERY_MAX_LIVE_QUERIES ?? Number.NaN),
    rescue: Number(process.env.QWEN_BRAVE_RESCUE_MAX_LIVE_QUERIES ?? Number.NaN),
  },
  gdelt: {
    discovery: Number(process.env.QWEN_GDELT_DISCOVERY_MAX_LIVE_QUERIES ?? Number.NaN),
    rescue: Number(process.env.QWEN_GDELT_RESCUE_MAX_LIVE_QUERIES ?? Number.NaN),
  },
  google: {
    discovery: Number(process.env.QWEN_GOOGLE_DISCOVERY_MAX_LIVE_QUERIES ?? Number.NaN),
    rescue: Number(process.env.QWEN_GOOGLE_RESCUE_MAX_LIVE_QUERIES ?? Number.NaN),
  },
};
const LIVE_USAGE = {
  brave: 0,
  gdelt: 0,
  google: 0,
};
const LIVE_USAGE_BY_PHASE = {
  brave: { discovery: 0, rescue: 0 },
  gdelt: { discovery: 0, rescue: 0 },
  google: { discovery: 0, rescue: 0 },
};
const PROVIDER_MIN_INTERVAL_MS = {
  brave: MIN_SEARCH_INTERVAL_MS,
  google: MIN_SEARCH_INTERVAL_MS,
  gdelt: Math.max(MIN_SEARCH_INTERVAL_MS, 10000),
};
let lastSearchRequestAt = 0;
const LAST_PROVIDER_SEARCH_AT = {
  brave: 0,
  gdelt: 0,
  google: 0,
};
const PROVIDER_CIRCUIT_STATE_PATH = path.resolve(process.cwd(), 'qwen-data', 'events', 'provider-circuit-state.json');
const GDELT_RATE_LIMIT_LOCK_MS = Math.max(60_000, Number(process.env.QWEN_GDELT_RATE_LIMIT_LOCK_MS || 24 * 60 * 60 * 1000));
const PROVIDER_RATE_LIMIT_CIRCUITS = loadProviderRateLimitCircuits();

function loadProviderRateLimitCircuits() {
  try {
    if (!fs.existsSync(PROVIDER_CIRCUIT_STATE_PATH)) {
      return { providers: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_CIRCUIT_STATE_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { providers: {} };
    const providers = parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
    return { providers };
  } catch {
    return { providers: {} };
  }
}

function saveProviderRateLimitCircuits() {
  try {
    fs.mkdirSync(path.dirname(PROVIDER_CIRCUIT_STATE_PATH), { recursive: true });
    fs.writeFileSync(PROVIDER_CIRCUIT_STATE_PATH, JSON.stringify(PROVIDER_RATE_LIMIT_CIRCUITS, null, 2), 'utf-8');
  } catch {
    // best-effort persistence only
  }
}

function closeProviderRateLimitCircuit(provider) {
  if (!provider) return;
  if (!PROVIDER_RATE_LIMIT_CIRCUITS.providers?.[provider]) return;
  delete PROVIDER_RATE_LIMIT_CIRCUITS.providers[provider];
  saveProviderRateLimitCircuits();
}

function getProviderRateLimitCircuitState(provider) {
  const state = PROVIDER_RATE_LIMIT_CIRCUITS.providers?.[provider];
  if (!state) {
    return { open: false, provider, lockedUntilMs: null, lockedUntilIso: null, reason: null, httpCode: null };
  }

  const lockedUntilMs = Number(state.locked_until_ms || 0);
  const now = Date.now();
  if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= now) {
    closeProviderRateLimitCircuit(provider);
    return { open: false, provider, lockedUntilMs: null, lockedUntilIso: null, reason: null, httpCode: null };
  }

  return {
    open: true,
    provider,
    lockedUntilMs,
    lockedUntilIso: new Date(lockedUntilMs).toISOString(),
    reason: String(state.reason || 'rate_limit'),
    httpCode: Number(state.http_code || 429),
  };
}

function openProviderRateLimitCircuit(provider, { lockMs, reason = 'rate_limit', httpCode = 429 } = {}) {
  const safeLockMs = Math.max(60_000, Number(lockMs || 0) || 0);
  const lockedUntilMs = Date.now() + safeLockMs;
  PROVIDER_RATE_LIMIT_CIRCUITS.providers = PROVIDER_RATE_LIMIT_CIRCUITS.providers || {};
  PROVIDER_RATE_LIMIT_CIRCUITS.providers[provider] = {
    opened_at: new Date().toISOString(),
    locked_until_ms: lockedUntilMs,
    reason: String(reason || 'rate_limit'),
    http_code: Number(httpCode || 429),
  };
  saveProviderRateLimitCircuits();
  return {
    provider,
    lockedUntilMs,
    lockedUntilIso: new Date(lockedUntilMs).toISOString(),
    lockMs: safeLockMs,
  };
}

function baseResult(provider, extra = {}) {
  return {
    provider,
    data: null,
    status: PROVIDER_STATUS.CACHE_MISS_NO_NETWORK,
    cacheHit: false,
    networkCall: false,
    error: null,
    errorType: null,
    httpResponseCode: null,
    rateLimit: null,
    retryCount: 0,
    retryDelayMs: 0,
    ...extra,
  };
}

function logProvider(provider, fields) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const preparedValue = key === 'url' ? redactSensitiveUrl(value) : value;
      return `${key}=${typeof preparedValue === 'string' ? preparedValue : JSON.stringify(preparedValue)}`;
    });
  console.log(`[${provider}] ${parts.join(' ')}`);
}

function redactSensitiveUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    for (const key of ['key', 'api_key', 'apikey', 'token', 'access_token']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, 'REDACTED');
      }
    }
    return parsed.toString();
  } catch {
    return String(rawUrl || '');
  }
}

function normalizeBraveWeb(data) {
  if (!data) return { web: { results: [] } };
  if (data.web?.results) return data;
  if (data.data?.web?.results) return data.data;
  if (Array.isArray(data.results)) return { web: { results: data.results } };
  return { web: { results: [] } };
}

function normalizeBraveNews(data) {
  if (!data) return { results: [] };
  if (Array.isArray(data.results)) return { results: data.results };
  if (Array.isArray(data.news?.results)) return { results: data.news.results };
  if (Array.isArray(data.data?.results)) return { results: data.data.results };
  if (Array.isArray(data.data?.news?.results)) return { results: data.data.news.results };
  return { results: [] };
}

function normalizeGdelt(data) {
  if (!data) return { articles: [] };
  if (Array.isArray(data.articles)) return data;
  if (Array.isArray(data.data?.articles)) return data.data;
  return { articles: [] };
}

function normalizeGoogle(data) {
  if (!data) return { items: [] };
  if (Array.isArray(data.items)) return data;
  if (Array.isArray(data.data?.items)) return data.data;
  return { items: [] };
}

function usesMaxCompletionTokens(model) {
  const normalized = String(model || '').toLowerCase();
  return normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getQuota(provider) {
  return Number.isFinite(LIVE_QUOTAS[provider]) ? LIVE_QUOTAS[provider] : 0;
}

function getRescueReserved(provider) {
  const quota = getQuota(provider);
  const requested = Number.isFinite(LIVE_RESCUE_RESERVED[provider]) ? Math.floor(LIVE_RESCUE_RESERVED[provider]) : 0;
  return Math.max(0, Math.min(quota, requested));
}

function getConfiguredPhaseCap(provider, phase) {
  const configured = Number(LIVE_PHASE_CAPS?.[provider]?.[phase]);
  if (!Number.isFinite(configured)) return null;
  return Math.max(0, Math.floor(configured));
}

function getLivePhaseCap(provider, phase) {
  const quota = getQuota(provider);
  const rescueReserved = getRescueReserved(provider);
  const configured = getConfiguredPhaseCap(provider, phase);
  if (configured !== null) return Math.min(quota, configured);

  if (phase === 'discovery') {
    return Math.max(0, quota - rescueReserved);
  }

  if (provider === 'brave') {
    const braveRescueCap = Math.max(0, Math.floor(Number.isFinite(BRAVE_RESCUE_MAX_LIVE_QUERIES) ? BRAVE_RESCUE_MAX_LIVE_QUERIES : 1));
    return Math.min(quota, braveRescueCap);
  }

  if (rescueReserved > 0) {
    return Math.min(quota, rescueReserved);
  }

  // Preserve prior behavior for non-Brave providers when no explicit rescue reservation exists.
  return quota;
}

function normalizeLivePhase(phase, label) {
  const normalized = String(phase || '').toLowerCase();
  if (normalized === 'rescue' || normalized === 'discovery') return normalized;
  return String(label || '').toLowerCase().includes('rescue') ? 'rescue' : 'discovery';
}

async function waitForSearchThrottle(provider, label) {
  const providerMinIntervalMs = PROVIDER_MIN_INTERVAL_MS[provider] || MIN_SEARCH_INTERVAL_MS;
  const now = Date.now();
  const globalDelta = now - lastSearchRequestAt;
  const providerDelta = now - (LAST_PROVIDER_SEARCH_AT[provider] || 0);
  const waitMs = Math.max(0, MIN_SEARCH_INTERVAL_MS - globalDelta, providerMinIntervalMs - providerDelta);
  if (waitMs > 0) {
    logProvider(provider, { label, status: 'throttle_wait', wait_ms: waitMs, min_interval_ms: providerMinIntervalMs });
    await sleep(waitMs);
  }
  const requestAt = Date.now();
  lastSearchRequestAt = requestAt;
  LAST_PROVIDER_SEARCH_AT[provider] = requestAt;
}

async function reserveLiveQuery(provider, label, { phase = null } = {}) {
  const quota = getQuota(provider);
  const livePhase = normalizeLivePhase(phase, label);
  const rescueReserved = getRescueReserved(provider);
  const phaseCap = getLivePhaseCap(provider, livePhase);
  const phaseUsed = Number(LIVE_USAGE_BY_PHASE?.[provider]?.[livePhase] || 0);

  if (phaseUsed >= phaseCap) {
    logProvider(provider, {
      label,
      status: 'phase_quota_exhausted',
      live_phase: livePhase,
      phase_used: phaseUsed,
      phase_cap: phaseCap,
      live_used: LIVE_USAGE[provider],
      live_quota: quota,
      rescue_reserved: rescueReserved,
    });
    return false;
  }

  if (LIVE_USAGE[provider] >= quota) {
    logProvider(provider, {
      label,
      status: PROVIDER_STATUS.LIVE_QUOTA_EXHAUSTED,
      live_phase: livePhase,
      live_used: LIVE_USAGE[provider],
      live_quota: quota,
      rescue_reserved: rescueReserved,
    });
    return false;
  }
  await waitForSearchThrottle(provider, label);
  LIVE_USAGE[provider] += 1;
  LIVE_USAGE_BY_PHASE[provider][livePhase] = Number(LIVE_USAGE_BY_PHASE?.[provider]?.[livePhase] || 0) + 1;
  logProvider(provider, {
    label,
    status: 'live_slot_reserved',
    live_phase: livePhase,
    live_used: LIVE_USAGE[provider],
    live_quota: quota,
    rescue_reserved: rescueReserved,
  });
  return true;
}

function extractRateLimitHeaders(response) {
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const policy = response.headers.get('x-ratelimit-policy');
  if (!limit && !remaining && !reset && !policy) return null;
  return { limit, remaining, reset, policy };
}

function getStaleFallbackResult({ provider, label, normalize, entry, result, reason }) {
  if (entry.reason !== 'expired' || !entry.data) return null;
  result.status = 'stale_cache_fallback';
  result.cacheHit = true;
  result.data = normalize(entry.data);
  result.error = reason;
  logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, reason });
  return result;
}

async function searchWithCacheRefresh({ provider, cacheKey, label, configPresent, normalize, buildRequest, parseResponse, livePhase = null }) {
  const result = baseResult(provider);

  if (!configPresent) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = `${provider} configuration missing`;
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  const entry = readCacheEntry(provider, cacheKey, { includeExpiredData: true });
  if (entry.hit) {
    result.status = PROVIDER_STATUS.CACHE_HIT;
    result.cacheHit = true;
    result.data = normalize(entry.data);
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: DEFAULT_TTL_HOURS, mode: 'fresh_cache' });
    return result;
  }

  if (entry.reason === 'expired' && entry.data) {
    result.status = PROVIDER_STATUS.STALE_CACHE_HIT;
    result.cacheHit = true;
    result.data = normalize(entry.data);
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: DEFAULT_TTL_HOURS, mode: 'stale_cache' });
    return result;
  }

  if (!SEARCH_NETWORK_ENABLED) {
    result.status = PROVIDER_STATUS.CACHE_MISS_NO_NETWORK;
    result.error = `search network disabled: ${entry.reason}`;
    logProvider(provider, { label, status: result.status, reason: entry.reason, network: 'disabled', mode: SEARCH_NETWORK_MODE });
    return result;
  }

  const reserved = await reserveLiveQuery(provider, label, { phase: livePhase });
  if (!reserved) {
    result.status = PROVIDER_STATUS.LIVE_QUOTA_EXHAUSTED;
    result.error = `live quota exhausted after cache ${entry.reason}`;
    return result;
  }

  let request;
  try {
    request = buildRequest();
  } catch (error) {
    result.status = PROVIDER_STATUS.REQUEST_CONSTRUCTION_FAILURE;
    result.error = `Failed to build request: ${error.message}`;
    result.errorType = 'request_construction';
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  logProvider(provider, { label, status: 'calling', cache_reason: entry.reason, url: request.url });

  let response;
  try {
    const fetchResult = await fetchWithRetry({ provider, label, url: request.url, options: request.options, log: logProvider });
    response = fetchResult.response;
    result.httpResponseCode = response.status;
    result.rateLimit = extractRateLimitHeaders(response);
    result.retryCount = fetchResult.retryCount;
    result.retryDelayMs = fetchResult.totalDelayMs;
  } catch (error) {
    result.status = PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.error = `Network error: ${error.message}`;
    result.retryCount = Number(error?.retryMeta?.retryCount || 0);
    result.retryDelayMs = Number(error?.retryMeta?.totalDelayMs || 0);
    result.errorType = 'network';
    const staleFallback = getStaleFallbackResult({ provider, label, normalize, entry, result, reason: result.error });
    if (staleFallback) return staleFallback;
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  if (!response.ok) {
    const errorText = await response.text();
    result.status = response.status === 401 || response.status === 403
      ? PROVIDER_STATUS.AUTH_FAILURE
      : response.status === 429
        ? PROVIDER_STATUS.RATE_LIMIT
        : PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.errorType = response.status === 401 || response.status === 403
      ? 'auth'
      : response.status === 429
        ? 'rate_limit'
        : 'upstream';
    result.error = `API error: ${response.status} ${errorText}`;
    const staleFallback = getStaleFallbackResult({ provider, label, normalize, entry, result, reason: result.error });
    if (staleFallback) return staleFallback;
    logProvider(provider, {
      label,
      status: result.status,
      code: response.status,
      rate_limit_remaining: result.rateLimit?.remaining,
      rate_limit_reset: result.rateLimit?.reset,
      error: result.error,
    });
    return result;
  }

  const rawData = await parseResponse(response);
  writeCache(provider, cacheKey, rawData);
  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = normalize(rawData);
  logProvider(provider, {
    label,
    status: result.status,
    code: response.status,
    rate_limit_remaining: result.rateLimit?.remaining,
    rate_limit_reset: result.rateLimit?.reset,
    retry_count: result.retryCount,
    retry_delay_ms: result.retryDelayMs,
    cache: 'written',
  });
  return result;
}

export async function braveSearch(query, apiKey, options = {}) {
  const normalizedOptions = {
    count: options.count || 10,
    freshness: options.freshness || null,
    country: options.country || 'us',
    lang: options.lang || 'en',
  };
  const cacheKey = JSON.stringify({ type: 'web', query, options: normalizedOptions });
  const result = await searchWithCacheRefresh({
    provider: 'brave',
    cacheKey,
    label: options.logLabel || 'brave_web',
    configPresent: !!apiKey,
    normalize: normalizeBraveWeb,
    buildRequest: () => {
      const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('count', String(normalizedOptions.count));
      endpoint.searchParams.set('country', normalizedOptions.country);
      endpoint.searchParams.set('search_lang', normalizedOptions.lang);
      if (normalizedOptions.freshness) endpoint.searchParams.set('freshness', normalizedOptions.freshness);
      return {
        url: endpoint.toString(),
        options: {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
            'User-Agent': 'Foseer/1.0 (Qwen Discovery)',
          },
        },
      };
    },
    parseResponse: async (response) => response.json(),
    livePhase: options.livePhase || null,
  });
  result.results = result.data?.web?.results || [];
  return result;
}

export async function braveNewsSearch(query, apiKey, options = {}) {
  const normalizedOptions = {
    count: options.count || 10,
    freshness: options.freshness || null,
    country: options.country || 'us',
    lang: options.lang || 'en',
  };
  const cacheKey = `news:${JSON.stringify({ query, options: normalizedOptions })}`;
  const result = await searchWithCacheRefresh({
    provider: 'brave',
    cacheKey,
    label: options.logLabel || 'brave_news',
    configPresent: !!apiKey,
    normalize: normalizeBraveNews,
    buildRequest: () => {
      const endpoint = new URL('https://api.search.brave.com/res/v1/news/search');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('count', String(normalizedOptions.count));
      endpoint.searchParams.set('country', normalizedOptions.country);
      endpoint.searchParams.set('search_lang', normalizedOptions.lang);
      if (normalizedOptions.freshness) endpoint.searchParams.set('freshness', normalizedOptions.freshness);
      return {
        url: endpoint.toString(),
        options: {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
            'User-Agent': 'Foseer/1.0 (Qwen Discovery)',
          },
        },
      };
    },
    parseResponse: async (response) => response.json(),
    livePhase: options.livePhase || null,
  });
  result.results = result.data?.results || [];
  return result;
}

export async function gdeltSearch(query, options = {}) {
  const label = options.logLabel || 'gdelt_search';
  const circuitState = getProviderRateLimitCircuitState('gdelt');
  if (circuitState.open) {
    const lockedResult = baseResult('gdelt', {
      status: PROVIDER_STATUS.RATE_LIMIT_CIRCUIT_OPEN,
      error: `GDELT circuit open after previous rate limit (locked until ${circuitState.lockedUntilIso})`,
      errorType: 'rate_limit',
      httpResponseCode: 429,
    });
    lockedResult.articles = [];
    logProvider('gdelt', {
      label,
      status: lockedResult.status,
      lock_until: circuitState.lockedUntilIso,
      reason: circuitState.reason,
    });
    return lockedResult;
  }

  const normalizedOptions = {
    maxRecords: Math.min(options.maxRecords || 50, 250),
    sort: options.sort || 'DateDesc',
    timespan: options.timespan || '2days',
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, source: 'api' });
  const result = await searchWithCacheRefresh({
    provider: 'gdelt',
    cacheKey,
    label,
    configPresent: true,
    normalize: normalizeGdelt,
    buildRequest: () => {
      const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('mode', 'ArtList');
      endpoint.searchParams.set('format', 'json');
      endpoint.searchParams.set('maxrecords', String(normalizedOptions.maxRecords));
      endpoint.searchParams.set('sort', normalizedOptions.sort);
      endpoint.searchParams.set('timespan', normalizedOptions.timespan);
      return {
        url: endpoint.toString(),
        options: {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Foseer/1.0 (Qwen Discovery)',
          },
        },
      };
    },
    parseResponse: async (response) => response.json(),
    livePhase: options.livePhase || null,
  });
  if (
    result.status === PROVIDER_STATUS.RATE_LIMIT
    || Number(result.httpResponseCode || 0) === 429
    || String(result.errorType || '') === 'rate_limit'
  ) {
    const lockMs = Math.max(60_000, Number(options.gdeltRateLimitLockMs || process.env.QWEN_GDELT_RATE_LIMIT_LOCK_MS || GDELT_RATE_LIMIT_LOCK_MS));
    const lock = openProviderRateLimitCircuit('gdelt', {
      lockMs,
      reason: result.error || 'gdelt_http_429',
      httpCode: Number(result.httpResponseCode || 429),
    });
    logProvider('gdelt', {
      label,
      status: 'rate_limit_circuit_opened',
      lock_ms: lock.lockMs,
      lock_until: lock.lockedUntilIso,
    });
  }
  result.articles = result.data?.articles || [];
  return result;
}

async function searchImageProviderWithCache({
  provider,
  cacheKey,
  label,
  configPresent,
  buildRequest,
  parseResponse = async (response) => response.json(),
}) {
  const result = baseResult(provider);
  if (!configPresent) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = `${provider} configuration missing`;
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  const entry = readCacheEntry(provider, cacheKey, { includeExpiredData: true });
  if (entry.hit) {
    result.status = PROVIDER_STATUS.CACHE_HIT;
    result.cacheHit = true;
    result.data = entry.data;
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: DEFAULT_TTL_HOURS, mode: 'fresh_cache' });
    return result;
  }

  const hasExpiredEntry = entry.reason === 'expired' && entry.data;
  if (hasExpiredEntry && !SEARCH_NETWORK_ENABLED) {
    result.status = PROVIDER_STATUS.STALE_CACHE_HIT;
    result.cacheHit = true;
    result.data = entry.data;
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: DEFAULT_TTL_HOURS, mode: 'stale_cache' });
    return result;
  }

  if (!SEARCH_NETWORK_ENABLED) {
    result.status = PROVIDER_STATUS.CACHE_MISS_NO_NETWORK;
    result.error = `search network disabled: ${entry.reason}`;
    logProvider(provider, { label, status: result.status, reason: entry.reason, network: 'disabled', mode: SEARCH_NETWORK_MODE });
    return result;
  }

  await waitForSearchThrottle(provider, label);

  let request;
  try {
    request = buildRequest();
  } catch (error) {
    result.status = PROVIDER_STATUS.REQUEST_CONSTRUCTION_FAILURE;
    result.error = `Failed to build request: ${error.message}`;
    result.errorType = 'request_construction';
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  logProvider(provider, { label, status: 'calling', cache_reason: entry.reason, url: request.url });

  let response;
  try {
    const fetchResult = await fetchWithRetry({ provider, label, url: request.url, options: request.options, log: logProvider });
    response = fetchResult.response;
    result.httpResponseCode = response.status;
    result.rateLimit = extractRateLimitHeaders(response);
    result.retryCount = fetchResult.retryCount;
    result.retryDelayMs = fetchResult.totalDelayMs;
  } catch (error) {
    result.status = PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.error = `Network error: ${error.message}`;
    result.retryCount = Number(error?.retryMeta?.retryCount || 0);
    result.retryDelayMs = Number(error?.retryMeta?.totalDelayMs || 0);
    result.errorType = 'network';
    const staleFallback = getStaleFallbackResult({
      provider,
      label,
      normalize: (value) => value,
      entry,
      result,
      reason: result.error,
    });
    if (staleFallback) return staleFallback;
    logProvider(provider, { label, status: result.status, error: result.error });
    return result;
  }

  if (!response.ok) {
    const errorText = await response.text();
    result.status = response.status === 401 || response.status === 403
      ? PROVIDER_STATUS.AUTH_FAILURE
      : response.status === 429
        ? PROVIDER_STATUS.RATE_LIMIT
        : PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.errorType = response.status === 401 || response.status === 403
      ? 'auth'
      : response.status === 429
        ? 'rate_limit'
        : 'upstream';
    result.error = `API error: ${response.status} ${errorText}`;
    const staleFallback = getStaleFallbackResult({
      provider,
      label,
      normalize: (value) => value,
      entry,
      result,
      reason: result.error,
    });
    if (staleFallback) return staleFallback;
    logProvider(provider, {
      label,
      status: result.status,
      code: response.status,
      rate_limit_remaining: result.rateLimit?.remaining,
      rate_limit_reset: result.rateLimit?.reset,
      error: result.error,
    });
    return result;
  }

  const rawData = await parseResponse(response);
  writeCache(provider, cacheKey, rawData);
  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = rawData;
  logProvider(provider, {
    label,
    status: result.status,
    code: response.status,
    rate_limit_remaining: result.rateLimit?.remaining,
    rate_limit_reset: result.rateLimit?.reset,
    retry_count: result.retryCount,
    retry_delay_ms: result.retryDelayMs,
  });
  return result;
}

export async function googleSearch(query, apiKey, cx, options = {}) {
  const normalizedOptions = {
    num: Math.min(options.num || 10, 10),
    dateRestrict: options.dateRestrict || null,
    sort: options.sort || null,
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, cx_present: !!cx });
  const result = await searchWithCacheRefresh({
    provider: 'google',
    cacheKey,
    label: options.logLabel || 'google_search',
    configPresent: !!apiKey && !!cx,
    normalize: normalizeGoogle,
    buildRequest: () => {
      const endpoint = new URL('https://customsearch.googleapis.com/customsearch/v1');
      endpoint.searchParams.set('key', apiKey);
      endpoint.searchParams.set('cx', cx);
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('num', String(normalizedOptions.num));
      if (normalizedOptions.dateRestrict) endpoint.searchParams.set('dateRestrict', normalizedOptions.dateRestrict);
      if (normalizedOptions.sort) endpoint.searchParams.set('sort', normalizedOptions.sort);
      return {
        url: endpoint.toString(),
        options: {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Foseer/1.0 (Qwen Discovery)',
          },
        },
      };
    },
    parseResponse: async (response) => response.json(),
    livePhase: options.livePhase || null,
  });
  result.items = result.data?.items || [];
  return result;
}

export async function pexelsSearch(query, apiKey, options = {}) {
  const label = options.logLabel || 'pexels_search';
  const normalizedOptions = {
    perPage: Number(options.perPage || 10),
    orientation: options.orientation || 'landscape',
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, source: 'api' });
  const result = await searchImageProviderWithCache({
    provider: 'pexels',
    cacheKey,
    label,
    configPresent: Boolean(apiKey),
    buildRequest: () => {
      const endpoint = new URL('https://api.pexels.com/v1/search');
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('per_page', String(normalizedOptions.perPage));
      endpoint.searchParams.set('orientation', normalizedOptions.orientation);
      return {
        url: endpoint.toString(),
        options: {
          headers: {
            Accept: 'application/json',
            Authorization: apiKey,
            'User-Agent': 'Foseer/1.0 (News Pipeline)',
          },
        },
      };
    },
  });
  if (result.status === PROVIDER_STATUS.CALLED_SUCCESS || result.status === PROVIDER_STATUS.CACHE_HIT || result.status === PROVIDER_STATUS.STALE_CACHE_HIT || result.status === 'stale_cache_fallback') {
    logProvider('pexels', { label, status: result.status, photos: result.data?.photos?.length || 0 });
  }
  return result;
}


export async function pixabaySearch(query, apiKey, options = {}) {
  const label = options.logLabel || 'pixabay_search';
  const normalizedOptions = {
    video: options.video === true,
    perPage: Number(options.perPage || 10),
    safesearch: options.safesearch === false ? false : true,
    order: options.order || 'popular',
    lang: options.lang || 'en',
    imageType: options.imageType || 'photo',
    orientation: options.orientation === 'portrait'
      ? 'vertical'
      : options.orientation === 'landscape'
        ? 'horizontal'
        : (options.orientation || 'horizontal'),
    minWidth: Number(options.minWidth || 1200),
    minHeight: Number(options.minHeight || 675),
    category: options.category || null,
    editorsChoice: options.editorsChoice === true,
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, source: 'api' });
  const result = await searchImageProviderWithCache({
    provider: 'pixabay',
    cacheKey,
    label,
    configPresent: Boolean(apiKey),
    buildRequest: () => {
      const endpoint = new URL(normalizedOptions.video ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/');
      endpoint.searchParams.set('key', apiKey);
      if (query) endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('per_page', String(normalizedOptions.perPage));
      endpoint.searchParams.set('safesearch', normalizedOptions.safesearch ? 'true' : 'false');
      endpoint.searchParams.set('order', normalizedOptions.order);
      endpoint.searchParams.set('lang', normalizedOptions.lang);
      if (!normalizedOptions.video) {
        endpoint.searchParams.set('image_type', normalizedOptions.imageType);
        endpoint.searchParams.set('orientation', normalizedOptions.orientation);
        endpoint.searchParams.set('min_width', String(normalizedOptions.minWidth));
        endpoint.searchParams.set('min_height', String(normalizedOptions.minHeight));
        if (normalizedOptions.category) endpoint.searchParams.set('category', normalizedOptions.category);
        if (normalizedOptions.editorsChoice) endpoint.searchParams.set('editors_choice', 'true');
      }
      return {
        url: endpoint.toString(),
        options: {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Foseer/1.0 (News Pipeline)',
          },
        },
      };
    },
  });
  if (result.status === PROVIDER_STATUS.CALLED_SUCCESS || result.status === PROVIDER_STATUS.CACHE_HIT || result.status === PROVIDER_STATUS.STALE_CACHE_HIT || result.status === 'stale_cache_fallback') {
    logProvider('pixabay', { label, status: result.status, hits: result.data?.hits?.length || 0 });
  }
  return result;
}

export async function unsplashSearch(query, apiKey, options = {}) {
  const label = options.logLabel || 'unsplash_search';
  const normalizedOptions = {
    perPage: Number(options.perPage || 10),
    orientation: options.orientation || 'landscape',
    contentFilter: options.contentFilter || 'high',
    orderBy: options.orderBy || 'relevant',
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, source: 'api' });
  const result = await searchImageProviderWithCache({
    provider: 'unsplash',
    cacheKey,
    label,
    configPresent: Boolean(apiKey),
    buildRequest: () => {
      const endpoint = new URL('https://api.unsplash.com/search/photos');
      endpoint.searchParams.set('query', query);
      endpoint.searchParams.set('per_page', String(normalizedOptions.perPage));
      endpoint.searchParams.set('orientation', normalizedOptions.orientation);
      endpoint.searchParams.set('content_filter', normalizedOptions.contentFilter);
      endpoint.searchParams.set('order_by', normalizedOptions.orderBy);
      return {
        url: endpoint.toString(),
        options: {
          headers: {
            Accept: 'application/json',
            Authorization: `Client-ID ${apiKey}`,
            'Accept-Version': 'v1',
            'User-Agent': 'Foseer/1.0 (News Pipeline)',
          },
        },
      };
    },
  });
  if (result.status === PROVIDER_STATUS.CALLED_SUCCESS || result.status === PROVIDER_STATUS.CACHE_HIT || result.status === PROVIDER_STATUS.STALE_CACHE_HIT || result.status === 'stale_cache_fallback') {
    logProvider('unsplash', { label, status: result.status, photos: result.data?.results?.length || 0 });
  }
  return result;
}

export async function openAIComplete(prompt, apiKey, options = {}) {
  const result = baseResult('openai');
  const model = options.model || 'gpt-4o-mini';
  const label = options.logLabel || 'openai_call';

  if (!apiKey) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = 'OpenAI API key not configured';
    logProvider('openai', { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  const tokenLimit = options.maxTokens || 2000;
  const tokenField = usesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens';
  const requestPayload = {
    model,
    messages: [
      { role: 'system', content: options.systemPrompt || 'You are a helpful editorial assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: options.temperature ?? 0.7,
  };
  requestPayload[tokenField] = tokenLimit;
  logProvider('openai', { label, status: 'calling', model, prompt_chars: prompt.length, token_field: tokenField, token_limit: tokenLimit, temperature: options.temperature ?? 0.7 });
  let response;
  try {
    const fetchResult = await fetchWithRetry({
      provider: 'openai',
      label,
      url: 'https://api.openai.com/v1/chat/completions',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'Foseer/1.0 (News Pipeline)',
        },
        body: JSON.stringify(requestPayload),
      },
      log: logProvider,
      classifyResponse: (candidateResponse) => isRetryableHttpStatus(candidateResponse?.status),
    });
    response = fetchResult.response;
    result.retryCount = fetchResult.retryCount;
    result.retryDelayMs = fetchResult.totalDelayMs;
    result.httpResponseCode = response.status;
  } catch (error) {
    result.status = PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.error = `Network error: ${error.message}`;
    result.retryCount = Number(error?.retryMeta?.retryCount || 0);
    result.retryDelayMs = Number(error?.retryMeta?.totalDelayMs || 0);
    result.errorType = 'network';
    logProvider('openai', { label, status: result.status, error: result.error });
    return result;
  }

  if (!response.ok) {
    const errorText = await response.text();
    result.status = response.status === 401 || response.status === 403 ? PROVIDER_STATUS.AUTH_FAILURE : response.status === 429 ? PROVIDER_STATUS.RATE_LIMIT : PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.errorType = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : 'upstream';
    result.error = `API error: ${response.status} ${errorText}`;
    logProvider('openai', { label, status: result.status, model, code: response.status, error: result.error });
    return result;
  }

  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = await response.json();
  logProvider('openai', { label, status: result.status, model, code: response.status, retry_count: result.retryCount, retry_delay_ms: result.retryDelayMs });
  return result;
}

export function getProviderStats() {
  const gdeltCircuit = getProviderRateLimitCircuitState('gdelt');
  return {
    mode: SEARCH_NETWORK_ENABLED ? 'cache_refresh_with_live_quota' : 'cache_only',
    retry_policy: getRetryPolicyStats(),
    search_network_enabled: SEARCH_NETWORK_ENABLED,
    min_search_interval_ms: MIN_SEARCH_INTERVAL_MS,
    live_quota: { ...LIVE_QUOTAS },
    live_rescue_reserved: {
      brave: getRescueReserved('brave'),
      gdelt: getRescueReserved('gdelt'),
      google: getRescueReserved('google'),
    },
    live_phase_caps: {
      brave: {
        discovery: getLivePhaseCap('brave', 'discovery'),
        rescue: getLivePhaseCap('brave', 'rescue'),
      },
      gdelt: {
        discovery: getLivePhaseCap('gdelt', 'discovery'),
        rescue: getLivePhaseCap('gdelt', 'rescue'),
      },
      google: {
        discovery: getLivePhaseCap('google', 'discovery'),
        rescue: getLivePhaseCap('google', 'rescue'),
      },
    },
    brave_rescue_max_live_queries: Math.max(0, Math.floor(Number.isFinite(BRAVE_RESCUE_MAX_LIVE_QUERIES) ? BRAVE_RESCUE_MAX_LIVE_QUERIES : 1)),
    live_usage: { ...LIVE_USAGE },
    live_usage_by_phase: {
      brave: { ...LIVE_USAGE_BY_PHASE.brave },
      gdelt: { ...LIVE_USAGE_BY_PHASE.gdelt },
      google: { ...LIVE_USAGE_BY_PHASE.google },
    },
    provider_circuits: {
      gdelt: {
        open: gdeltCircuit.open,
        locked_until: gdeltCircuit.lockedUntilIso,
        reason: gdeltCircuit.reason,
      },
    },
    cache: getCacheStats(),
  };
}

export { PROVIDER_STATUS };
