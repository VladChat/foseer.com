// File: qwen-scripts/utils/api-clients.js
// Purpose: Provider wrappers for Brave/GDELT/Google with 8-hour cache TTL, offline-first reads, and optional manual live refresh.

import { readCacheEntry, writeCache, getCacheStats } from './cache-manager.js';
import { fetchWithRetry, getRetryPolicyStats, isRetryableHttpStatus } from './retry-policy.js';

const PROVIDER_STATUS = {
  SKIPPED_CONFIG: 'skipped_config',
  CACHE_HIT: 'cache_hit',
  STALE_CACHE_HIT: 'stale_cache_hit',
  CACHE_MISS_NO_NETWORK: 'cache_miss_no_network',
  CALLED_SUCCESS: 'called_success',
  AUTH_FAILURE: 'auth_failure',
  RATE_LIMIT: 'rate_limit',
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
const LIVE_USAGE = {
  brave: 0,
  gdelt: 0,
  google: 0,
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

async function reserveLiveQuery(provider, label) {
  const quota = getQuota(provider);
  if (LIVE_USAGE[provider] >= quota) {
    logProvider(provider, { label, status: PROVIDER_STATUS.LIVE_QUOTA_EXHAUSTED, live_used: LIVE_USAGE[provider], live_quota: quota });
    return false;
  }
  await waitForSearchThrottle(provider, label);
  LIVE_USAGE[provider] += 1;
  logProvider(provider, { label, status: 'live_slot_reserved', live_used: LIVE_USAGE[provider], live_quota: quota });
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

async function searchWithCacheRefresh({ provider, cacheKey, label, configPresent, normalize, buildRequest, parseResponse }) {
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
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: 8, mode: 'fresh_cache' });
    return result;
  }

  if (entry.reason === 'expired' && entry.data) {
    result.status = PROVIDER_STATUS.STALE_CACHE_HIT;
    result.cacheHit = true;
    result.data = normalize(entry.data);
    logProvider(provider, { label, status: result.status, age_ms: entry.ageMs, ttl_hours: 8, mode: 'stale_cache' });
    return result;
  }

  if (!SEARCH_NETWORK_ENABLED) {
    result.status = PROVIDER_STATUS.CACHE_MISS_NO_NETWORK;
    result.error = `search network disabled: ${entry.reason}`;
    logProvider(provider, { label, status: result.status, reason: entry.reason, network: 'disabled', mode: SEARCH_NETWORK_MODE });
    return result;
  }

  const reserved = await reserveLiveQuery(provider, label);
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
  });
  result.results = result.data?.results || [];
  return result;
}

export async function gdeltSearch(query, options = {}) {
  const normalizedOptions = {
    maxRecords: Math.min(options.maxRecords || 50, 250),
    sort: options.sort || 'DateDesc',
    timespan: options.timespan || '2days',
  };
  const cacheKey = JSON.stringify({ query, options: normalizedOptions, source: 'api' });
  const result = await searchWithCacheRefresh({
    provider: 'gdelt',
    cacheKey,
    label: options.logLabel || 'gdelt_search',
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
  });
  result.articles = result.data?.articles || [];
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
  });
  result.items = result.data?.items || [];
  return result;
}

export async function pexelsSearch(query, apiKey, options = {}) {
  const result = baseResult('pexels');
  const label = options.logLabel || 'pexels_search';
  if (!apiKey) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = 'Pexels API key not configured';
    logProvider('pexels', { label, status: result.status, error: result.error });
    return result;
  }

  let endpoint;
  try {
    endpoint = new URL('https://api.pexels.com/v1/search');
    endpoint.searchParams.set('query', query);
    endpoint.searchParams.set('per_page', options.perPage || 10);
    endpoint.searchParams.set('orientation', options.orientation || 'landscape');
  } catch (error) {
    result.status = PROVIDER_STATUS.REQUEST_CONSTRUCTION_FAILURE;
    result.error = `Failed to build request: ${error.message}`;
    result.errorType = 'request_construction';
    logProvider('pexels', { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  logProvider('pexels', { label, status: 'calling', query });
  let response;
  try {
    const fetchResult = await fetchWithRetry({
      provider: 'pexels',
      label,
      url: endpoint.toString(),
      options: {
        headers: {
          Accept: 'application/json',
          Authorization: apiKey,
          'User-Agent': 'Foseer/1.0 (News Pipeline)',
        },
      },
      log: logProvider,
    });
    response = fetchResult.response;
    result.httpResponseCode = response.status;
    result.retryCount = fetchResult.retryCount;
    result.retryDelayMs = fetchResult.totalDelayMs;
  } catch (error) {
    result.status = PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.error = `Network error: ${error.message}`;
    result.retryCount = Number(error?.retryMeta?.retryCount || 0);
    result.retryDelayMs = Number(error?.retryMeta?.totalDelayMs || 0);
    result.errorType = 'network';
    logProvider('pexels', { label, status: result.status, error: result.error });
    return result;
  }

  if (!response.ok) {
    result.status = response.status === 401 || response.status === 403 ? PROVIDER_STATUS.AUTH_FAILURE : response.status === 429 ? PROVIDER_STATUS.RATE_LIMIT : PROVIDER_STATUS.UPSTREAM_RESPONSE_FAILURE;
    result.errorType = response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limit' : 'upstream';
    result.error = `API error: ${response.status} ${response.statusText}`;
    logProvider('pexels', { label, status: result.status, code: response.status, error: result.error });
    return result;
  }

  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = await response.json();
  logProvider('pexels', { label, status: result.status, code: response.status, photos: result.data?.photos?.length || 0, retry_count: result.retryCount, retry_delay_ms: result.retryDelayMs });
  return result;
}


export async function pixabaySearch(query, apiKey, options = {}) {
  const result = baseResult('pixabay');
  const label = options.logLabel || 'pixabay_search';
  if (!apiKey) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = 'Pixabay API key not configured';
    logProvider('pixabay', { label, status: result.status, error: result.error });
    return result;
  }

  let endpoint;
  try {
    endpoint = new URL(options.video === true ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/');
    endpoint.searchParams.set('key', apiKey);
    if (query) endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('per_page', String(options.perPage || 10));
    endpoint.searchParams.set('safesearch', options.safesearch === false ? 'false' : 'true');
    endpoint.searchParams.set('order', options.order || 'popular');
    endpoint.searchParams.set('lang', options.lang || 'en');
    if (!options.video) {
      endpoint.searchParams.set('image_type', options.imageType || 'photo');
      endpoint.searchParams.set('orientation', options.orientation === 'portrait' ? 'vertical' : options.orientation === 'landscape' ? 'horizontal' : (options.orientation || 'horizontal'));
      endpoint.searchParams.set('min_width', String(options.minWidth || 1200));
      endpoint.searchParams.set('min_height', String(options.minHeight || 675));
      if (options.category) endpoint.searchParams.set('category', options.category);
      if (options.editorsChoice) endpoint.searchParams.set('editors_choice', 'true');
    }
  } catch (error) {
    result.status = PROVIDER_STATUS.REQUEST_CONSTRUCTION_FAILURE;
    result.error = `Failed to build request: ${error.message}`;
    result.errorType = 'request_construction';
    logProvider('pixabay', { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  logProvider('pixabay', { label, status: 'calling', query, video: options.video === true });
  let response;
  try {
    const fetchResult = await fetchWithRetry({
      provider: 'pixabay',
      label,
      url: endpoint.toString(),
      options: {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Foseer/1.0 (News Pipeline)',
        },
      },
      log: logProvider,
    });
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
    logProvider('pixabay', { label, status: result.status, error: result.error });
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
    logProvider('pixabay', {
      label,
      status: result.status,
      code: response.status,
      rate_limit_remaining: result.rateLimit?.remaining,
      rate_limit_reset: result.rateLimit?.reset,
      error: result.error,
    });
    return result;
  }

  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = await response.json();
  logProvider('pixabay', {
    label,
    status: result.status,
    code: response.status,
    hits: result.data?.hits?.length || 0,
    rate_limit_remaining: result.rateLimit?.remaining,
    rate_limit_reset: result.rateLimit?.reset,
    retry_count: result.retryCount,
    retry_delay_ms: result.retryDelayMs,
  });
  return result;
}

export async function unsplashSearch(query, apiKey, options = {}) {
  const result = baseResult('unsplash');
  const label = options.logLabel || 'unsplash_search';
  if (!apiKey) {
    result.status = PROVIDER_STATUS.SKIPPED_CONFIG;
    result.error = 'Unsplash API key not configured';
    logProvider('unsplash', { label, status: result.status, error: result.error });
    return result;
  }

  let endpoint;
  try {
    endpoint = new URL('https://api.unsplash.com/search/photos');
    endpoint.searchParams.set('query', query);
    endpoint.searchParams.set('per_page', String(options.perPage || 10));
    endpoint.searchParams.set('orientation', options.orientation || 'landscape');
    endpoint.searchParams.set('content_filter', options.contentFilter || 'high');
    endpoint.searchParams.set('order_by', options.orderBy || 'relevant');
  } catch (error) {
    result.status = PROVIDER_STATUS.REQUEST_CONSTRUCTION_FAILURE;
    result.error = `Failed to build request: ${error.message}`;
    result.errorType = 'request_construction';
    logProvider('unsplash', { label, status: result.status, error: result.error });
    return result;
  }

  result.networkCall = true;
  logProvider('unsplash', { label, status: 'calling', query });
  let response;
  try {
    const fetchResult = await fetchWithRetry({
      provider: 'unsplash',
      label,
      url: endpoint.toString(),
      options: {
        headers: {
          Accept: 'application/json',
          Authorization: `Client-ID ${apiKey}`,
          'Accept-Version': 'v1',
          'User-Agent': 'Foseer/1.0 (News Pipeline)',
        },
      },
      log: logProvider,
    });
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
    logProvider('unsplash', { label, status: result.status, error: result.error });
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
    logProvider('unsplash', {
      label,
      status: result.status,
      code: response.status,
      rate_limit_remaining: result.rateLimit?.remaining,
      rate_limit_reset: result.rateLimit?.reset,
      error: result.error,
    });
    return result;
  }

  result.status = PROVIDER_STATUS.CALLED_SUCCESS;
  result.data = await response.json();
  logProvider('unsplash', {
    label,
    status: result.status,
    code: response.status,
    photos: result.data?.results?.length || 0,
    rate_limit_remaining: result.rateLimit?.remaining,
    rate_limit_reset: result.rateLimit?.reset,
    retry_count: result.retryCount,
    retry_delay_ms: result.retryDelayMs,
  });
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
  return {
    mode: SEARCH_NETWORK_ENABLED ? 'cache_refresh_with_live_quota' : 'cache_only',
    retry_policy: getRetryPolicyStats(),
    search_network_enabled: SEARCH_NETWORK_ENABLED,
    min_search_interval_ms: MIN_SEARCH_INTERVAL_MS,
    live_quota: { ...LIVE_QUOTAS },
    live_usage: { ...LIVE_USAGE },
    cache: getCacheStats(),
  };
}

export { PROVIDER_STATUS };
