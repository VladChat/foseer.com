// File: qwen-scripts/utils/cache-manager.js
// Purpose: Runtime cache manager for Brave, GDELT, and Google with seed-cache fallback and overwrite-on-refresh behavior.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RUNTIME_CACHE_ROOT = path.resolve(PROJECT_ROOT, 'qwen-cache');
const SEED_CACHE_ROOT = path.resolve(PROJECT_ROOT, 'qwen-data/cache-seed');

const DEFAULT_TTL_HOURS = Math.max(1, Number(process.env.QWEN_CACHE_TTL_HOURS || 6));
const TTL_MS = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function normalizeCacheMetadata(cacheFile, cached) {
  if (!cached || typeof cached !== 'object') return cached;
  if (cached.ttl_hours === DEFAULT_TTL_HOURS) return cached;
  const normalized = { ...cached, ttl_hours: DEFAULT_TTL_HOURS };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(normalized, null, 2), 'utf-8');
  } catch {
    return cached;
  }
  return normalized;
}

function getRuntimeCacheDir(provider) {
  return ensureDir(path.join(RUNTIME_CACHE_ROOT, provider.toLowerCase()));
}

function getSeedCacheDir(provider) {
  return ensureDir(path.join(SEED_CACHE_ROOT, provider.toLowerCase()));
}

function getRuntimeCacheFilePath(provider, queryHash) {
  return path.join(getRuntimeCacheDir(provider), `${queryHash}.json`);
}

function getSeedCacheFilePath(provider, queryHash) {
  return path.join(getSeedCacheDir(provider), `${queryHash}.json`);
}

function hashQuery(query) {
  let hash = 0;
  const normalized = String(query || '');
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function buildMiss(queryHash, cacheFile, reason = 'missing') {
  return { hit: false, reason, data: null, ageMs: null, cacheFile, queryHash, source: 'runtime' };
}

function readExistingCacheFile(cacheFile, queryHash, source, options = {}) {
  const includeExpiredData = options.includeExpiredData === true;
  if (!fs.existsSync(cacheFile)) {
    return buildMiss(queryHash, cacheFile, 'missing');
  }

  try {
    let cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    cached = normalizeCacheMetadata(cacheFile, cached);
    const ageMs = Date.now() - cached.timestamp;
    if (!Number.isFinite(ageMs) || cached.timestamp == null) {
      return { hit: false, reason: 'corrupt', data: null, ageMs: null, cacheFile, queryHash, source };
    }
    if (ageMs > TTL_MS) {
      return {
        hit: false,
        reason: 'expired',
        data: includeExpiredData ? cached.data : null,
        ageMs,
        cacheFile,
        queryHash,
        source,
        payload: cached,
      };
    }
    return { hit: true, reason: 'fresh', data: cached.data, ageMs, cacheFile, queryHash, source, payload: cached };
  } catch {
    return { hit: false, reason: 'corrupt', data: null, ageMs: null, cacheFile, queryHash, source };
  }
}

function hydrateRuntimeCacheFromPayload(provider, queryHash, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const runtimeCacheFile = getRuntimeCacheFilePath(provider, queryHash);
  const normalizedPayload = {
    ...payload,
    ttl_hours: DEFAULT_TTL_HOURS,
    provider,
    query_hash: queryHash,
  };
  fs.writeFileSync(runtimeCacheFile, JSON.stringify(normalizedPayload, null, 2), 'utf-8');
  return runtimeCacheFile;
}

export function readCacheEntry(provider, query, options = {}) {
  const queryHash = hashQuery(query);
  const runtimeCacheFile = getRuntimeCacheFilePath(provider, queryHash);
  const runtimeEntry = readExistingCacheFile(runtimeCacheFile, queryHash, 'runtime', options);

  if (runtimeEntry.hit) {
    return runtimeEntry;
  }

  if (runtimeEntry.reason === 'expired' && runtimeEntry.data) {
    return runtimeEntry;
  }

  const seedCacheFile = getSeedCacheFilePath(provider, queryHash);
  const seedEntry = readExistingCacheFile(seedCacheFile, queryHash, 'seed', options);

  if (seedEntry.hit && options.hydrateRuntime !== false) {
    try {
      hydrateRuntimeCacheFromPayload(provider, queryHash, seedEntry.payload);
    } catch {
      // Seed fallback still counts as usable even if runtime hydration fails.
    }
  }

  return seedEntry.hit || seedEntry.reason !== 'missing'
    ? seedEntry
    : { ...runtimeEntry, cacheFile: runtimeCacheFile };
}

export function readCache(provider, query) {
  const entry = readCacheEntry(provider, query);
  return entry.hit ? entry.data : null;
}

export function writeCache(provider, query, data) {
  const queryHash = hashQuery(query);
  const cacheFile = getRuntimeCacheFilePath(provider, queryHash);
  const cached = {
    timestamp: Date.now(),
    ttl_hours: DEFAULT_TTL_HOURS,
    provider,
    query_hash: queryHash,
    data,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(cached, null, 2), 'utf-8');
  return { cacheFile, queryHash, source: 'runtime' };
}

export function deleteCacheEntry(provider, query, options = {}) {
  const queryHash = hashQuery(query);
  const runtimeCacheFile = getRuntimeCacheFilePath(provider, queryHash);
  const seedCacheFile = getSeedCacheFilePath(provider, queryHash);
  let deleted = false;

  if (fs.existsSync(runtimeCacheFile)) {
    fs.unlinkSync(runtimeCacheFile);
    deleted = true;
  }

  if (options.includeSeed === true && fs.existsSync(seedCacheFile)) {
    fs.unlinkSync(seedCacheFile);
    deleted = true;
  }

  return deleted;
}

export function clearProviderCache(provider, options = {}) {
  const runtimeCacheDir = getRuntimeCacheDir(provider);
  if (fs.existsSync(runtimeCacheDir)) {
    for (const file of fs.readdirSync(runtimeCacheDir)) {
      fs.unlinkSync(path.join(runtimeCacheDir, file));
    }
  }

  if (options.includeSeed === true) {
    const seedCacheDir = getSeedCacheDir(provider);
    if (fs.existsSync(seedCacheDir)) {
      for (const file of fs.readdirSync(seedCacheDir)) {
        fs.unlinkSync(path.join(seedCacheDir, file));
      }
    }
  }
}

function getRootStats(rootPath, providers) {
  const stats = {};

  for (const provider of providers) {
    const cacheDir = ensureDir(path.join(rootPath, provider));
    const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((file) => file.endsWith('.json')) : [];
    let sizeBytes = 0;
    let freshFiles = 0;
    let expiredFiles = 0;
    let corruptFiles = 0;

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      const stat = fs.statSync(filePath);
      sizeBytes += stat.size;
      try {
        const parsed = normalizeCacheMetadata(filePath, JSON.parse(fs.readFileSync(filePath, 'utf-8')));
        const ageMs = Date.now() - parsed.timestamp;
        if (!Number.isFinite(ageMs) || parsed.timestamp == null) corruptFiles += 1;
        else if (ageMs <= TTL_MS) freshFiles += 1;
        else expiredFiles += 1;
      } catch {
        corruptFiles += 1;
      }
    }

    stats[provider] = {
      files: files.length,
      fresh_files: freshFiles,
      expired_files: expiredFiles,
      corrupt_files: corruptFiles,
      size_bytes: sizeBytes,
    };
  }

  return stats;
}

export function getCacheStats() {
  const providers = ['brave', 'gdelt', 'google'];
  return {
    ttl_hours: DEFAULT_TTL_HOURS,
    runtime_root: RUNTIME_CACHE_ROOT,
    seed_root: SEED_CACHE_ROOT,
    runtime: getRootStats(RUNTIME_CACHE_ROOT, providers),
    seed: getRootStats(SEED_CACHE_ROOT, providers),
  };
}

export function normalizeAllCacheTTLs() {
  const providers = ['brave', 'gdelt', 'google'];
  const roots = [
    { label: 'runtime', rootPath: RUNTIME_CACHE_ROOT },
    { label: 'seed', rootPath: SEED_CACHE_ROOT },
  ];
  const summary = { ttl_hours: DEFAULT_TTL_HOURS, rewritten_files: 0, roots: {} };

  for (const { label, rootPath } of roots) {
    summary.roots[label] = {};

    for (const provider of providers) {
      const cacheDir = ensureDir(path.join(rootPath, provider));
      const files = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((file) => file.endsWith('.json')) : [];
      let providerRewritten = 0;

      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (parsed?.ttl_hours !== DEFAULT_TTL_HOURS) {
            normalizeCacheMetadata(filePath, parsed);
            providerRewritten += 1;
          }
        } catch {
          // Ignore corrupt cache files here; cache stats surfaces them separately.
        }
      }

      summary.roots[label][provider] = { files: files.length, rewritten_files: providerRewritten };
      summary.rewritten_files += providerRewritten;
    }
  }

  return summary;
}

export {
  DEFAULT_TTL_HOURS,
  TTL_MS,
  RUNTIME_CACHE_ROOT,
  SEED_CACHE_ROOT,
};
