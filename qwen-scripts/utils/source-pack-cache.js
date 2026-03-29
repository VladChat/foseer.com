// File: qwen-scripts/utils/source-pack-cache.js
// Purpose: Persist normalized source-pack snapshots for 8 hours so one story assembles to the same publish-ready source set across nearby runs, with seed-cache fallback.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RUNTIME_CACHE_ROOT = path.resolve(PROJECT_ROOT, 'qwen-cache/source-packs');
const SEED_CACHE_ROOT = path.resolve(PROJECT_ROOT, 'qwen-data/cache-seed/source-packs');
const TTL_HOURS = 8;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureRuntimeCacheDir() {
  return ensureDir(RUNTIME_CACHE_ROOT);
}

function ensureSeedCacheDir() {
  return ensureDir(SEED_CACHE_ROOT);
}

function hashText(value) {
  const input = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function buildIdentitySeed(eventBrief = {}) {
  const title = normalizeTitle(eventBrief.title || '');
  const sourceUrls = (Array.isArray(eventBrief.sourceUrls) ? eventBrief.sourceUrls : [])
    .map((url) => canonicalizeUrl(url))
    .filter(Boolean)
    .slice(0, 6)
    .sort();

  return JSON.stringify({
    cluster_id: eventBrief.cluster_id || eventBrief.clusterId || null,
    event_key: eventBrief.eventKey || null,
    topic_id: eventBrief.topic_id || null,
    section_id: eventBrief.section_id || null,
    title,
    region: eventBrief.region || null,
    angle: eventBrief.angle || null,
    source_urls: sourceUrls,
  });
}

function buildMaterialFingerprint(materials = []) {
  const compact = (Array.isArray(materials) ? materials : [])
    .map((source) => ({
      url: canonicalizeUrl(source?.canonical_url || source?.url || ''),
      title: normalizeTitle(source?.title || ''),
      domain: String(source?.canonical_domain || source?.domain || '').toLowerCase(),
      page_kind: String(source?.page_kind || '').toLowerCase(),
      topic_id: source?.topic_id || null,
      section_id: source?.section_id || null,
    }))
    .filter((source) => source.url)
    .sort((left, right) => left.url.localeCompare(right.url));
  return hashText(JSON.stringify(compact));
}

export function buildSourcePackSnapshotIdentity(eventBrief = {}, materials = []) {
  const identitySeed = buildIdentitySeed(eventBrief);
  return {
    cacheKey: `source-pack-${hashText(identitySeed)}`,
    identitySeed,
    materialFingerprint: buildMaterialFingerprint(materials),
  };
}

function getRuntimeCacheFilePath(cacheKey) {
  ensureRuntimeCacheDir();
  return path.join(RUNTIME_CACHE_ROOT, `${cacheKey}.json`);
}

function getSeedCacheFilePath(cacheKey) {
  ensureSeedCacheDir();
  return path.join(SEED_CACHE_ROOT, `${cacheKey}.json`);
}

function readSnapshotFile(cacheFile, identity, source) {
  if (!fs.existsSync(cacheFile)) {
    return { hit: false, reason: 'missing', snapshot: null, cacheFile, ageMs: null, source };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const ageMs = Date.now() - Number(parsed.timestamp || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0) {
      return { hit: false, reason: 'corrupt', snapshot: null, cacheFile, ageMs: null, source };
    }
    if (ageMs > TTL_MS) {
      return { hit: false, reason: 'expired', snapshot: null, cacheFile, ageMs, source, payload: parsed };
    }
    if (parsed.identity_seed !== identity.identitySeed) {
      return { hit: false, reason: 'identity_mismatch', snapshot: null, cacheFile, ageMs, source };
    }
    if (parsed.material_fingerprint !== identity.materialFingerprint) {
      return { hit: false, reason: 'material_changed', snapshot: null, cacheFile, ageMs, source };
    }
    return {
      hit: true,
      reason: 'fresh',
      snapshot: parsed.snapshot || null,
      cacheFile,
      ageMs,
      source,
      writtenAt: parsed.written_at || null,
      payload: parsed,
    };
  } catch {
    return { hit: false, reason: 'corrupt', snapshot: null, cacheFile, ageMs: null, source };
  }
}

function hydrateRuntimeSnapshot(cacheKey, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const cacheFile = getRuntimeCacheFilePath(cacheKey);
  fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf-8');
  return cacheFile;
}

export function readSourcePackSnapshot(identity, options = {}) {
  const cacheKey = identity?.cacheKey;
  if (!cacheKey) {
    return { hit: false, reason: 'missing_cache_key', snapshot: null, cacheFile: null, ageMs: null, source: null };
  }

  const runtimeEntry = readSnapshotFile(getRuntimeCacheFilePath(cacheKey), identity, 'runtime');
  if (runtimeEntry.hit) {
    return runtimeEntry;
  }
  if (runtimeEntry.reason === 'expired') {
    return runtimeEntry;
  }

  const seedEntry = readSnapshotFile(getSeedCacheFilePath(cacheKey), identity, 'seed');
  if (seedEntry.hit && options.hydrateRuntime !== false) {
    try {
      hydrateRuntimeSnapshot(cacheKey, seedEntry.payload);
    } catch {
      // Seed fallback remains usable even if runtime hydration fails.
    }
  }
  return seedEntry.hit || seedEntry.reason !== 'missing' ? seedEntry : runtimeEntry;
}

export function writeSourcePackSnapshot(identity, snapshot) {
  const cacheKey = identity?.cacheKey;
  if (!cacheKey || !snapshot) return null;
  const cacheFile = getRuntimeCacheFilePath(cacheKey);
  const payload = {
    timestamp: Date.now(),
    written_at: new Date().toISOString(),
    ttl_hours: TTL_HOURS,
    cache_key: cacheKey,
    identity_seed: identity.identitySeed,
    material_fingerprint: identity.materialFingerprint,
    snapshot,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf-8');
  return { cacheFile, cacheKey, source: 'runtime' };
}

function getStatsForRoot(rootPath) {
  ensureDir(rootPath);
  const files = fs.readdirSync(rootPath).filter((file) => file.endsWith('.json'));
  let fresh = 0;
  let expired = 0;
  let corrupt = 0;
  for (const file of files) {
    const filePath = path.join(rootPath, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const ageMs = Date.now() - Number(parsed.timestamp || 0);
      if (!Number.isFinite(ageMs) || ageMs < 0) corrupt += 1;
      else if (ageMs <= TTL_MS) fresh += 1;
      else expired += 1;
    } catch {
      corrupt += 1;
    }
  }
  return {
    total_files: files.length,
    fresh_files: fresh,
    expired_files: expired,
    corrupt_files: corrupt,
  };
}

export function getSourcePackCacheStats() {
  return {
    ttl_hours: TTL_HOURS,
    runtime_root: RUNTIME_CACHE_ROOT,
    seed_root: SEED_CACHE_ROOT,
    runtime: getStatsForRoot(RUNTIME_CACHE_ROOT),
    seed: getStatsForRoot(SEED_CACHE_ROOT),
  };
}
