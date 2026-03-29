// File: qwen-scripts/image-library/registry.js
// Purpose: Persistent image registry and local-library reuse logic for qwen article covers.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../utils/project-root.js';
import { applyEnrichmentToAsset, buildAssetSearchText, buildArticleSearchProfile, computeContextualEditorialFit, normalizeHintArray } from './enrichment.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const REGISTRY_DIR = path.resolve(PROJECT_ROOT, 'qwen-data/images');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'image-registry.json');
const POSTS_IMAGE_DIR = path.resolve(PROJECT_ROOT, 'src/assets/images/posts');

const DEFAULT_SCHEMA_VERSION = 3;
const DEFAULT_REUSE_COOLDOWN_DAYS = Number(process.env.QWEN_IMAGE_REUSE_COOLDOWN_DAYS || 60);

function buildEmptyRegistry() {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    assets: [],
    usage: [],
    maintenance: {
      lastLegacyImportAt: null,
      lastCooldownBackfillAt: null,
      lastMetadataEnrichmentAt: null,
    },
  };
}

function ensureRegistryDirectory() {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

function normalizeArray(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeAsset(asset) {
  const base = {
    assetKey: String(asset.assetKey || '').trim(),
    provider: String(asset.provider || 'unknown').trim(),
    providerAssetId: asset.providerAssetId ? String(asset.providerAssetId).trim() : null,
    sourcePageUrl: asset.sourcePageUrl ? String(asset.sourcePageUrl).trim() : null,
    sourceDownloadUrl: asset.sourceDownloadUrl ? String(asset.sourceDownloadUrl).trim() : null,
    authorName: asset.authorName ? String(asset.authorName).trim() : null,
    authorUrl: asset.authorUrl ? String(asset.authorUrl).trim() : null,
    license: asset.license ? String(asset.license).trim() : null,
    altText: asset.altText ? String(asset.altText).trim() : null,
    width: Number(asset.width || 0) || null,
    height: Number(asset.height || 0) || null,
    format: asset.format ? String(asset.format).trim() : 'jpg',
    localPath: asset.localPath ? String(asset.localPath).trim() : null,
    fileRelativePath: asset.fileRelativePath ? String(asset.fileRelativePath).trim() : null,
    metadataRelativePath: asset.metadataRelativePath ? String(asset.metadataRelativePath).trim() : null,
    publicUrl: asset.publicUrl ? String(asset.publicUrl).trim() : (asset.publicImageUrl ? String(asset.publicImageUrl).trim() : null),
    publicFileRelativePath: asset.publicFileRelativePath ? String(asset.publicFileRelativePath).trim() : null,
    sectionHints: normalizeArray(asset.sectionHints),
    queryHistory: normalizeArray(asset.queryHistory),
    tags: normalizeArray(asset.tags),
    topicHints: normalizeArray(asset.topicHints),
    entityHints: normalizeHintArray(asset.entityHints),
    sceneType: asset.sceneType ? String(asset.sceneType).trim() : null,
    geoHints: normalizeHintArray(asset.geoHints),
    visualType: asset.visualType ? String(asset.visualType).trim() : null,
    editorialFitScore: asset.editorialFitScore !== undefined
      && asset.editorialFitScore !== null
      && String(asset.editorialFitScore).trim() !== ''
      && Number.isFinite(Number(asset.editorialFitScore))
      ? Number(asset.editorialFitScore)
      : null,
    firstSeenAt: asset.firstSeenAt || new Date().toISOString(),
    lastFetchedAt: asset.lastFetchedAt || null,
    lastUsedAt: asset.lastUsedAt || null,
    useCount: Number(asset.useCount || 0) || 0,
    status: asset.status || 'ready',
    provenance: asset.provenance || 'runtime',
  };

  return applyEnrichmentToAsset(base);
}

function normalizeRegistry(registry) {
  const base = buildEmptyRegistry();
  const assets = Array.isArray(registry?.assets) ? registry.assets.map(normalizeAsset).filter((asset) => asset.assetKey) : [];
  const usage = Array.isArray(registry?.usage) ? registry.usage.map((entry) => ({
    assetKey: String(entry.assetKey || '').trim(),
    articleSlug: String(entry.articleSlug || '').trim(),
    articleTitle: entry.articleTitle ? String(entry.articleTitle).trim() : null,
    section: entry.section ? String(entry.section).trim() : null,
    topicId: entry.topicId ? String(entry.topicId).trim() : null,
    query: entry.query ? String(entry.query).trim() : null,
    usedAt: entry.usedAt || new Date().toISOString(),
    selectionMode: entry.selectionMode ? String(entry.selectionMode).trim() : 'unknown',
  })).filter((entry) => entry.assetKey && entry.articleSlug) : [];

  return {
    ...base,
    ...registry,
    assets,
    usage,
    maintenance: {
      ...base.maintenance,
      ...(registry?.maintenance || {}),
    },
    updatedAt: registry?.updatedAt || base.updatedAt,
  };
}

export function loadImageRegistry() {
  ensureRegistryDirectory();
  let registry = buildEmptyRegistry();
  let needsSaveFromNormalization = false;

  if (fs.existsSync(REGISTRY_PATH)) {
    try {
      const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      registry = normalizeRegistry(parsed);
      needsSaveFromNormalization = JSON.stringify(parsed) != JSON.stringify(registry);
      if (needsSaveFromNormalization) {
        registry.maintenance.lastMetadataEnrichmentAt = new Date().toISOString();
      }
    } catch (error) {
      console.warn(`[image-registry] Failed to read registry, rebuilding: ${error.message}`);
      registry = buildEmptyRegistry();
    }
  }

  const legacyImported = importLegacyPostAssets(registry);
  const cooldownBackfilled = backfillMissingLastUsedAt(registry);
  const metadataEnriched = backfillMetadataHints(registry);
  if (needsSaveFromNormalization || legacyImported > 0 || cooldownBackfilled > 0 || metadataEnriched > 0 || !fs.existsSync(REGISTRY_PATH)) {
    saveImageRegistry(registry);
  }

  return registry;
}

export function saveImageRegistry(registry) {
  ensureRegistryDirectory();
  registry.updatedAt = new Date().toISOString();
  const normalized = normalizeRegistry(registry);
  if (!normalized.maintenance?.lastMetadataEnrichmentAt && normalized.assets.some((asset) => (asset.entityHints || []).length > 0 || (asset.geoHints || []).length > 0 || asset.sceneType || asset.visualType || asset.editorialFitScore !== null)) {
    normalized.maintenance.lastMetadataEnrichmentAt = new Date().toISOString();
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function importLegacyPostAssets(registry) {
  if (!fs.existsSync(POSTS_IMAGE_DIR)) {
    return 0;
  }

  let imported = 0;
  const entries = fs.readdirSync(POSTS_IMAGE_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'fallback') continue;

    const imageFileRelativePath = path.posix.join('src/assets/images/posts', entry.name, 'cover.jpg');
    const imageFileAbsolutePath = path.resolve(PROJECT_ROOT, imageFileRelativePath);
    const metadataPath = path.join(POSTS_IMAGE_DIR, entry.name, 'image-metadata.json');
    if (!fs.existsSync(imageFileAbsolutePath) || !fs.existsSync(metadataPath)) {
      continue;
    }

    const localPath = `~/assets/images/posts/${entry.name}/cover.jpg`;
    const alreadyTracked = registry.assets.some((asset) => asset.localPath === localPath || asset.fileRelativePath === imageFileRelativePath);
    if (alreadyTracked) {
      continue;
    }

    let metadata = {};
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch {
      metadata = {};
    }

    const nestedSource = metadata.source || {};
    const nestedImage = metadata.image || {};
    const stat = fs.statSync(imageFileAbsolutePath);
    const legacyAsset = normalizeAsset({
      assetKey: `legacy:${entry.name}`,
      provider: pickFirst(metadata.provider, nestedSource.provider, 'legacy'),
      providerAssetId: pickFirst(metadata.providerAssetId, nestedSource.providerAssetId),
      sourcePageUrl: pickFirst(metadata.sourcePage, metadata.sourcePageUrl, nestedSource.sourcePage, nestedSource.pageURL),
      sourceDownloadUrl: pickFirst(metadata.sourceUrl, metadata.downloadUrl, nestedSource.originalUrl, nestedSource.sourceUrl),
      authorName: pickFirst(metadata.photographer, metadata.authorName, nestedSource.photographer, nestedSource.authorName),
      authorUrl: pickFirst(metadata.photographerUrl, metadata.authorUrl, nestedSource.photographerUrl, nestedSource.authorUrl),
      license: pickFirst(metadata.license, nestedSource.license),
      altText: pickFirst(metadata.altText, metadata.title, nestedSource.altText),
      width: pickFirst(nestedImage.width, metadata.width),
      height: pickFirst(nestedImage.height, metadata.height),
      format: pickFirst(nestedImage.format, metadata.format, 'jpg'),
      localPath,
      fileRelativePath: imageFileRelativePath,
      metadataRelativePath: path.posix.join('src/assets/images/posts', entry.name, 'image-metadata.json'),
      sectionHints: [pickFirst(metadata.section, nestedSource.section)].filter(Boolean),
      queryHistory: [pickFirst(metadata.searchQuery, nestedSource.searchQuery, metadata.title, nestedSource.title)].filter(Boolean),
      tags: normalizeArray([...(Array.isArray(metadata.tags) ? metadata.tags : []), ...(Array.isArray(nestedSource.tags) ? nestedSource.tags : [])]),
      topicHints: [pickFirst(metadata.topicId, metadata.topic_id, nestedSource.topicId, nestedSource.topic_id)].filter(Boolean),
      entityHints: normalizeHintArray([...(Array.isArray(metadata.entityHints) ? metadata.entityHints : []), ...(Array.isArray(nestedSource.entityHints) ? nestedSource.entityHints : [])]),
      sceneType: pickFirst(metadata.sceneType, nestedSource.sceneType),
      geoHints: normalizeHintArray([...(Array.isArray(metadata.geoHints) ? metadata.geoHints : []), ...(Array.isArray(nestedSource.geoHints) ? nestedSource.geoHints : [])]),
      visualType: pickFirst(metadata.visualType, nestedSource.visualType),
      editorialFitScore: pickFirst(metadata.editorialFitScore, nestedSource.editorialFitScore),
      firstSeenAt: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
      lastFetchedAt: pickFirst(metadata.downloadedAt, stat.mtime.toISOString()),
      lastUsedAt: stat.mtime.toISOString(),
      useCount: 1,
      status: 'ready',
      provenance: 'legacy_post_import',
    });

    registry.assets.push(legacyAsset);
    imported += 1;
  }

  if (imported > 0) {
    registry.maintenance.lastLegacyImportAt = new Date().toISOString();
    console.log(`[image-registry] Imported legacy post assets: ${imported}`);
  }

  return imported;
}

function backfillMissingLastUsedAt(registry) {
  let updated = 0;

  for (const asset of registry.assets) {
    if (asset.lastUsedAt) continue;
    const usageDates = (registry.usage || [])
      .filter((entry) => entry.assetKey === asset.assetKey && entry.usedAt)
      .map((entry) => new Date(entry.usedAt))
      .filter((value) => !Number.isNaN(value.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());

    const fallbackDate = usageDates[0]?.toISOString?.()
      || asset.lastFetchedAt
      || asset.firstSeenAt
      || null;

    if (!fallbackDate) continue;

    asset.lastUsedAt = fallbackDate;
    if ((asset.provenance === 'legacy_post_import' || asset.provider === 'legacy') && Number(asset.useCount || 0) < 1) {
      asset.useCount = 1;
    }
    updated += 1;
  }

  if (updated > 0) {
    registry.maintenance.lastCooldownBackfillAt = new Date().toISOString();
    console.log(`[image-registry] Backfilled lastUsedAt for ${updated} assets`);
  }

  return updated;
}

function backfillMetadataHints(registry) {
  let updated = 0;

  for (let index = 0; index < registry.assets.length; index += 1) {
    const current = registry.assets[index];
    const enriched = applyEnrichmentToAsset(normalizeAsset({ ...current, editorialFitScore: null }), { force: true });
    const changed = (
      JSON.stringify(current.entityHints || []) !== JSON.stringify(enriched.entityHints || [])
      || current.sceneType !== enriched.sceneType
      || JSON.stringify(current.geoHints || []) !== JSON.stringify(enriched.geoHints || [])
      || current.visualType !== enriched.visualType
      || Number(current.editorialFitScore || 0) !== Number(enriched.editorialFitScore || 0)
      || JSON.stringify(current.queryHistory || []) !== JSON.stringify(enriched.queryHistory || [])
      || JSON.stringify(current.sectionHints || []) !== JSON.stringify(enriched.sectionHints || [])
    );

    if (!changed) continue;

    registry.assets[index] = enriched;
    updated += 1;
  }

  if (updated > 0) {
    registry.maintenance.lastMetadataEnrichmentAt = new Date().toISOString();
    console.log(`[image-registry] Enriched metadata hints for ${updated} assets`);
  }

  return updated;
}

export function findExistingAssetForCandidate(registry, candidate) {
  if (!candidate) return null;
  const provider = String(candidate.provider || '').trim();
  const providerAssetId = candidate.providerAssetId ? String(candidate.providerAssetId).trim() : null;
  const sourcePageUrl = candidate.sourcePageUrl ? String(candidate.sourcePageUrl).trim() : null;
  const sourceDownloadUrl = candidate.sourceDownloadUrl ? String(candidate.sourceDownloadUrl).trim() : null;

  let match = null;

  if (provider && providerAssetId) {
    match = registry.assets.find((asset) => asset.provider === provider && asset.providerAssetId === providerAssetId) || null;
  }
  if (!match && sourcePageUrl) {
    match = registry.assets.find((asset) => asset.sourcePageUrl && asset.sourcePageUrl === sourcePageUrl) || null;
  }
  if (!match && sourceDownloadUrl) {
    match = registry.assets.find((asset) => asset.sourceDownloadUrl && asset.sourceDownloadUrl === sourceDownloadUrl) || null;
  }

  return match;
}

export function assetFileExists(asset) {
  if (!asset?.fileRelativePath) return false;
  return fs.existsSync(path.resolve(PROJECT_ROOT, asset.fileRelativePath));
}

export function getAssetCooldownDays() {
  return DEFAULT_REUSE_COOLDOWN_DAYS;
}

export function isAssetWithinCooldown(asset, referenceDate = new Date(), cooldownDays = getAssetCooldownDays()) {
  if (!asset?.lastUsedAt) return false;
  const lastUsedAt = new Date(asset.lastUsedAt);
  if (Number.isNaN(lastUsedAt.getTime())) return false;
  const ms = referenceDate.getTime() - lastUsedAt.getTime();
  return ms < cooldownDays * 24 * 60 * 60 * 1000;
}

export function registerAssetRecord(registry, assetInput) {
  const normalized = normalizeAsset(assetInput);
  const existingIndex = registry.assets.findIndex((asset) => asset.assetKey === normalized.assetKey);
  if (existingIndex >= 0) {
    const current = registry.assets[existingIndex];
    registry.assets[existingIndex] = normalizeAsset({
      ...current,
      ...normalized,
      sectionHints: normalizeArray([...(current.sectionHints || []), ...(normalized.sectionHints || [])]),
      queryHistory: normalizeArray([...(current.queryHistory || []), ...(normalized.queryHistory || [])]),
      tags: normalizeArray([...(current.tags || []), ...(normalized.tags || [])]),
      topicHints: normalizeArray([...(current.topicHints || []), ...(normalized.topicHints || [])]),
      entityHints: normalizeHintArray([...(current.entityHints || []), ...(normalized.entityHints || [])]),
      geoHints: normalizeHintArray([...(current.geoHints || []), ...(normalized.geoHints || [])]),
      firstSeenAt: current.firstSeenAt || normalized.firstSeenAt,
      useCount: Math.max(current.useCount || 0, normalized.useCount || 0),
      lastUsedAt: current.lastUsedAt || normalized.lastUsedAt || null,
      lastFetchedAt: normalized.lastFetchedAt || current.lastFetchedAt || null,
      sceneType: normalized.sceneType || current.sceneType || null,
      visualType: normalized.visualType || current.visualType || null,
      editorialFitScore: (() => {
        const candidates = [current.editorialFitScore, normalized.editorialFitScore]
          .filter((value) => value !== undefined && value !== null && Number.isFinite(Number(value)))
          .map((value) => Number(value));
        return candidates.length ? Math.max(...candidates) : null;
      })(),
    });
    return registry.assets[existingIndex];
  }

  registry.assets.push(normalized);
  return normalized;
}

export function recordImageUsage(registry, { asset, articleSlug, articleTitle, section, topicId, query, selectionMode }) {
  const usedAt = new Date().toISOString();
  registry.usage.unshift({
    assetKey: asset.assetKey,
    articleSlug,
    articleTitle: articleTitle || null,
    section: section || null,
    query: query || null,
    topicId: topicId || null,
    usedAt,
    selectionMode: selectionMode || 'unknown',
  });

  registry.usage = registry.usage
    .filter((entry) => entry.assetKey && entry.articleSlug)
    .slice(0, 4000);

  const assetRecord = registry.assets.find((entry) => entry.assetKey === asset.assetKey);
  if (assetRecord) {
    assetRecord.lastUsedAt = usedAt;
    assetRecord.useCount = Number(assetRecord.useCount || 0) + 1;
    assetRecord.sectionHints = normalizeArray([...(assetRecord.sectionHints || []), section].filter(Boolean));
    assetRecord.topicHints = normalizeArray([...(assetRecord.topicHints || []), topicId].filter(Boolean));
  }
}

export function findReusableAsset(registry, { articleSlug, section, topicId, title, excerpt, queries, entityHints = [] }) {
  const articleProfile = buildArticleSearchProfile({
    title,
    excerpt,
    queries,
    section,
    topicId,
    entityHints,
  });
  const searchTokens = new Set(articleProfile.tokens);
  const now = new Date();
  const candidates = [];

  for (const asset of registry.assets) {
    if (!asset.localPath || !assetFileExists(asset)) continue;
    if (isAssetWithinCooldown(asset, now)) continue;

    const usedByArticle = registry.usage.some((entry) => entry.articleSlug === articleSlug && entry.assetKey === asset.assetKey);
    if (usedByArticle) continue;

    const assetTokens = new Set(buildAssetSearchText(asset).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean));
    const overlap = Array.from(searchTokens).filter((token) => assetTokens.has(token)).length;
    const fit = computeContextualEditorialFit(asset, articleProfile);
    const strongSemanticMatch = overlap >= 2 || fit.entityOverlap >= 1 || fit.finalScore >= 68;
    if (!strongSemanticMatch) continue;

    const sizeScore = Number(asset.width || 0) * Number(asset.height || 0);
    const ageDays = asset.lastUsedAt ? Math.max(0, (now.getTime() - new Date(asset.lastUsedAt).getTime()) / (24 * 60 * 60 * 1000)) : 365;
    const usePenalty = Number(asset.useCount || 0) * 25;
    const score = fit.finalScore * 100000 + overlap * 10000 + Math.min(ageDays, 365) * 100 - usePenalty + sizeScore;

    candidates.push({ asset, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.asset || null;
}

export function getRegistryPath() {
  return REGISTRY_PATH;
}

export function getImageRegistrySummary(registry) {
  const current = normalizeRegistry(registry);
  return {
    assets: current.assets.length,
    usage: current.usage.length,
    providers: current.assets.reduce((acc, asset) => {
      acc[asset.provider] = Number(acc[asset.provider] || 0) + 1;
      return acc;
    }, {}),
    enriched_assets: current.assets.filter((asset) => (asset.entityHints || []).length > 0 || (asset.geoHints || []).length > 0 || asset.sceneType || asset.visualType || asset.editorialFitScore !== null).length,
    last_metadata_enrichment_at: current.maintenance?.lastMetadataEnrichmentAt || null,
  };
}
