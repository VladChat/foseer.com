// File: qwen-scripts/utils/news-pool.js
// Purpose: Persist discovered/normalized news briefs for 48 hours and rank them with diversity-aware selection logic.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

import { buildCoverageContext, scoreBriefForSelection, scoreCandidateWithSourcePack } from '../nodes/selection-node.js';

const NEWS_POOL_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/events/news-pool.json');
const DISCOVERED_POOL_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/events/discovered-news-pool.json');
const READY_CANDIDATES_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/events/ready-article-candidates.json');
const TTL_MS = 48 * 60 * 60 * 1000;
const COOLDOWN_MS = 18 * 60 * 60 * 1000;

function ensurePoolDir() {
  const dir = path.dirname(NEWS_POOL_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTitleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|or|for|with|from|into|amid|after|before|over|under|latest|breaking|news|report|reports|live|updates|today|story|stories)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function briefSelectionDedupeKey(brief) {
  const canonicalSourceUrl = normalizeUrl(brief?.canonicalUrl || brief?.sourceUrls?.[0] || brief?.url || brief?.link || '');
  const titleKey = normalizeTitleKey(brief?.normalizedTitle || brief?.title || '');
  if (brief?.cluster_id || brief?.clusterId) return `cluster:${brief.cluster_id || brief.clusterId}`;
  if (brief?.eventKey) return `event:${brief.eventKey}`;
  if (canonicalSourceUrl) return `url:${canonicalSourceUrl}`;
  return `title:${titleKey}`;
}

function dedupeBriefArrayBySelectionIdentity(briefs = []) {
  const kept = [];
  const byKey = new Map();
  const byTitle = new Map();

  const isBetter = (candidate, existing) => {
    const candidateScore = Number(candidate?.selectionScore || candidate?.publishabilityScore || 0);
    const existingScore = Number(existing?.selectionScore || existing?.publishabilityScore || 0);
    if (candidateScore !== existingScore) return candidateScore > existingScore;

    const candidateFreshness = Number(candidate?.freshness || 0);
    const existingFreshness = Number(existing?.freshness || 0);
    if (candidateFreshness !== existingFreshness) return candidateFreshness > existingFreshness;

    const candidateSourceCount = Array.isArray(candidate?.sourceUrls) ? candidate.sourceUrls.length : 0;
    const existingSourceCount = Array.isArray(existing?.sourceUrls) ? existing.sourceUrls.length : 0;
    if (candidateSourceCount !== existingSourceCount) return candidateSourceCount > existingSourceCount;

    return String(candidate?.title || '').length > String(existing?.title || '').length;
  };

  for (const brief of briefs) {
    if (!brief) continue;
    const key = briefSelectionDedupeKey(brief);
    const titleKey = normalizeTitleKey(brief?.normalizedTitle || brief?.title || '');

    let existingIndex = byKey.has(key) ? byKey.get(key) : undefined;
    if (existingIndex === undefined && titleKey && byTitle.has(titleKey)) {
      existingIndex = byTitle.get(titleKey);
    }

    if (existingIndex === undefined) {
      const index = kept.length;
      kept.push(brief);
      byKey.set(key, index);
      if (titleKey) byTitle.set(titleKey, index);
      continue;
    }

    const existing = kept[existingIndex];
    if (isBetter(brief, existing)) {
      kept[existingIndex] = brief;
      byKey.set(key, existingIndex);
      if (titleKey) byTitle.set(titleKey, existingIndex);
    }
  }

  return kept.filter(Boolean);
}

function getIdentityKey(brief) {
  if (brief?.cluster_id || brief?.clusterId) {
    return `cluster:${brief.cluster_id || brief.clusterId}`;
  }
  if (brief?.eventKey) {
    return `event:${brief.eventKey}`;
  }
  const primaryUrl = brief.sourceUrls?.[0] || '';
  const title = String(brief.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return primaryUrl ? `url:${normalizeUrl(primaryUrl)}` : `title:${title.slice(0, 120)}`;
}

export function loadNewsPool() {
  ensurePoolDir();
  if (!fs.existsSync(NEWS_POOL_PATH)) {
    return { updatedAt: nowIso(), items: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(NEWS_POOL_PATH, 'utf-8'));
    return { updatedAt: parsed.updatedAt || nowIso(), items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { updatedAt: nowIso(), items: [] };
  }
}

export function saveNewsPool(pool) {
  ensurePoolDir();
  const payload = { ...pool, updatedAt: nowIso() };
  fs.writeFileSync(NEWS_POOL_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

export function loadReadyArticleCandidates() {
  ensurePoolDir();
  if (!fs.existsSync(READY_CANDIDATES_PATH)) {
    return { updatedAt: nowIso(), items: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(READY_CANDIDATES_PATH, 'utf-8'));
    return { updatedAt: parsed.updatedAt || nowIso(), items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { updatedAt: nowIso(), items: [] };
  }
}

export function saveReadyArticleCandidates(pool) {
  ensurePoolDir();
  const payload = { ...pool, updatedAt: nowIso() };
  fs.writeFileSync(READY_CANDIDATES_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

function reconcileReadyCandidatePool(readyPool = loadReadyArticleCandidates(), newsPool = loadNewsPool()) {
  const poolItemsByKey = new Map((newsPool.items || []).map((item) => [item.identityKey, item]));
  const items = (readyPool.items || []).map((item) => {
    const matchingPoolItem = poolItemsByKey.get(item.identityKey);
    if (!matchingPoolItem) return item;

    if (matchingPoolItem.status === 'published') {
      return {
        ...item,
        status: 'published',
        lastPublishedAt: matchingPoolItem.lastPublishedAt || item.lastPublishedAt || nowIso(),
        publishedSlug: matchingPoolItem.publishedSlug || item.publishedSlug || null,
      };
    }

    if (item.status === 'published' && matchingPoolItem.status !== 'published') {
      return {
        ...item,
        status: matchingPoolItem.status === 'selected' ? 'selected' : 'ready',
        lastPublishedAt: item.lastPublishedAt || null,
        publishedSlug: item.publishedSlug || null,
      };
    }

    if (matchingPoolItem.status === 'selected' && item.status === 'ready') {
      return {
        ...item,
        status: 'selected',
        lastSelectedAt: matchingPoolItem.lastSelectedAt || item.lastSelectedAt || nowIso(),
      };
    }

    return item;
  });

  return { ...readyPool, items };
}

function pruneReadyArticleCandidates(pool = loadReadyArticleCandidates()) {
  const now = Date.now();
  const reconciled = reconcileReadyCandidatePool(pool, loadNewsPool());
  const items = (reconciled.items || []).filter((item) => {
    const relevantTs = new Date(item.lastQueuedAt || item.lastSelectedAt || item.lastPublishedAt || item.firstQueuedAt || 0).getTime();
    if (!Number.isFinite(relevantTs) || relevantTs <= 0) return false;
    return (now - relevantTs) <= TTL_MS;
  });
  return saveReadyArticleCandidates({ ...reconciled, items });
}

function updateReadyCandidateStatus(identityKey, patch = {}) {
  if (!identityKey) return loadReadyArticleCandidates();
  const pool = pruneReadyArticleCandidates();
  const items = (pool.items || []).map((item) => item.identityKey === identityKey ? { ...item, ...patch } : item);
  return saveReadyArticleCandidates({ ...pool, items });
}

function normalizeCandidateTitle(value) {
  return normalizeTitleKey(value).slice(0, 180);
}

function summarizeReadyCandidate(candidate, coverageContext, rank = 0, selectedIdentityKeys = []) {
  const brief = candidate?.brief || {};
  const sourcePack = candidate?.sourcePack || {};
  const scoreInfo = scoreCandidateWithSourcePack(candidate, coverageContext);
  const identityKey = brief.poolIdentityKey || getIdentityKey(brief);
  const directEventSourceCount = Number(sourcePack.metrics?.directEventSourceCount || 0);
  const independentEventDomains = Number(sourcePack.metrics?.independentEventDomains || 0);
  return {
    identityKey,
    briefId: brief.id || null,
    title: brief.title || sourcePack.topic || 'Untitled candidate',
    normalizedTitle: normalizeCandidateTitle(brief.title || sourcePack.topic || ''),
    section_id: sourcePack.section_id || brief.section_id || brief.detectedSectionId || null,
    topic_id: sourcePack.topic_id || brief.topic_id || brief.detectedTopicId || null,
    articleType: sourcePack.articleType || brief.articleType || 'report',
    selectionOrigin: brief._selectionOrigin || 'pool',
    poolIdentityKey: brief.poolIdentityKey || null,
    rank,
    score: scoreInfo.score,
    scoreNotes: scoreInfo.notes || [],
    sourceCount: Array.isArray(sourcePack.sources) ? sourcePack.sources.length : 0,
    uniqueDomains: Number(sourcePack.uniqueDomains || 0),
    directEventSourceCount,
    independentEventDomains,
    gateDecision: sourcePack.passesGate ? 'PASS' : 'FAIL',
    gateNotes: Array.isArray(sourcePack.gateNotes) ? sourcePack.gateNotes : [],
    discoveredAt: brief.discoveredAt || null,
    firstQueuedAt: nowIso(),
    lastQueuedAt: nowIso(),
    status: identityKey && selectedIdentityKeys.includes(identityKey) ? 'selected' : 'ready',
    lastSelectedAt: identityKey && selectedIdentityKeys.includes(identityKey) ? nowIso() : null,
    lastPublishedAt: null,
    publishedSlug: null,
  };
}

export function recordReadyArticleCandidates(candidates = [], { selectedIdentityKey = null, selectedIdentityKeys = [], limit = 12 } = {}) {
  const readyPool = pruneReadyArticleCandidates();
  const newsPool = loadNewsPool();
  const coverageContext = buildCoverageContext(newsPool.items || []);
  const publishable = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.sourcePack?.passesGate)
    .map((candidate) => ({
      candidate,
      scoreInfo: scoreCandidateWithSourcePack(candidate, coverageContext),
    }))
    .sort((a, b) => b.scoreInfo.score - a.scoreInfo.score)
    .slice(0, Math.max(1, limit));

  const byKey = new Map((readyPool.items || []).map((item) => [item.identityKey, item]));
  const freshItems = [];

  const selectedKeys = Array.from(new Set([
    ...selectedIdentityKeys.filter(Boolean),
    ...(selectedIdentityKey ? [selectedIdentityKey] : []),
  ]));

  publishable.forEach(({ candidate }, index) => {
    const summary = summarizeReadyCandidate(candidate, coverageContext, index + 1, selectedKeys);
    const existing = byKey.get(summary.identityKey);
    freshItems.push({
      ...existing,
      ...summary,
      firstQueuedAt: existing?.firstQueuedAt || summary.firstQueuedAt,
      lastPublishedAt: existing?.lastPublishedAt || null,
      publishedSlug: existing?.publishedSlug || null,
    });
  });

  const merged = [
    ...freshItems,
    ...(readyPool.items || []).filter((item) => !freshItems.some((fresh) => fresh.identityKey === item.identityKey)),
  ]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, Math.max(limit * 3, limit));

  const saved = saveReadyArticleCandidates({ ...readyPool, items: merged });
  const selectedKeySet = new Set(selectedKeys);
  const readyItems = merged.filter((item) => !selectedKeySet.has(item.identityKey) && item.status !== 'published');
  const selectedCandidates = merged.filter((item) => selectedKeySet.has(item.identityKey));

  return {
    total: merged.length,
    readyCount: readyItems.length,
    additionalReadyCandidates: readyItems.slice(0, Math.max(0, limit - selectedCandidates.length)),
    selectedCandidate: selectedKeys[0] ? merged.find((item) => item.identityKey === selectedKeys[0]) || null : null,
    selectedCandidates,
    filePath: READY_CANDIDATES_PATH,
    updatedAt: saved.updatedAt,
  };
}


export function pruneExpiredNews(pool = loadNewsPool()) {
  const now = Date.now();
  const items = pool.items.filter((item) => {
    const expiresAt = item.expiresAt ? new Date(item.expiresAt).getTime() : 0;
    return expiresAt > now;
  });
  return saveNewsPool({ ...pool, items });
}

export function mergeBriefsIntoPool(briefs = [], pool = loadNewsPool()) {
  const pruned = pruneExpiredNews(pool);
  const itemsByKey = new Map(pruned.items.map((item) => [item.identityKey, item]));
  const now = Date.now();

  for (const brief of briefs) {
    const identityKey = getIdentityKey(brief);
    const existing = itemsByKey.get(identityKey);
    const discoveredAt = brief.discoveredAt || nowIso();
    const expiresAt = new Date(now + TTL_MS).toISOString();

    if (existing) {
      const mergedBrief = {
        ...existing.brief,
        ...brief,
        sourceUrls: Array.from(new Set([...(existing.brief?.sourceUrls || []), ...(brief.sourceUrls || [])])),
        discoveryContext: Array.from(new Set([...(existing.brief?.discoveryContext || []), ...(brief.discoveryContext || [])])),
      };
      itemsByKey.set(identityKey, {
        ...existing,
        brief: mergedBrief,
        publishabilityScore: Math.max(existing.publishabilityScore || 0, brief.publishabilityScore || 0),
        discoveredAt: existing.discoveredAt || discoveredAt,
        lastSeenAt: nowIso(),
        expiresAt,
      });
      continue;
    }

    itemsByKey.set(identityKey, {
      identityKey,
      brief,
      briefId: brief.id,
      publishabilityScore: brief.publishabilityScore || 0,
      discoveredAt,
      lastSeenAt: nowIso(),
      expiresAt,
      status: 'candidate',
      lastSelectedAt: null,
      lastPublishedAt: null,
    });
  }

  return saveNewsPool({ ...pruned, items: Array.from(itemsByKey.values()) });
}

function scorePoolItem(item, pool) {
  const brief = item.brief || {};
  const discoveredTs = new Date(item.discoveredAt || brief.discoveredAt || 0).getTime() || 0;
  const hoursOld = Math.max(0, (Date.now() - discoveredTs) / 3600000);
  const freshnessBonus = Math.max(0, 18 - hoursOld) * 0.25;
  const coverageContext = buildCoverageContext((pool.items || []).filter((candidate) => candidate.identityKey !== item.identityKey));
  const coverageScore = scoreBriefForSelection(brief, coverageContext, item);
  const cooldownPenalty = item.lastSelectedAt && (Date.now() - new Date(item.lastSelectedAt).getTime()) < COOLDOWN_MS ? 4 : 0;
  const publishedPenalty = item.lastPublishedAt ? 8 : 0;
  return {
    score: coverageScore.score + freshnessBonus - cooldownPenalty - publishedPenalty,
    notes: coverageScore.notes,
  };
}

export function getReadySelectableBriefs({ limit = 8, includeSelected = true } = {}, pool = loadNewsPool(), readyPool = pruneReadyArticleCandidates()) {
  const pruned = pruneExpiredNews(pool);
  const byKey = new Map((pruned.items || []).map((item) => [item.identityKey, item]));

  return dedupeBriefArrayBySelectionIdentity(
    (readyPool.items || [])
      .filter((item) => item.status !== 'published')
      .filter((item) => includeSelected || item.status !== 'selected')
      .map((item) => {
        const poolItem = byKey.get(item.identityKey);
        if (!poolItem || poolItem.status === 'published' || !poolItem.brief) return null;
        const scored = scorePoolItem(poolItem, pruned);
        const readyRank = Math.max(0, 8 - Number(item.rank || 99));
        return {
          ...poolItem.brief,
          poolIdentityKey: poolItem.identityKey,
          selectionScore: Math.max(Number(item.score || 0), scored.score) + readyRank,
          selectionNotes: [...(scored.notes || []), `ready-backlog:${item.rank || 'na'}`],
          readyCandidateStatus: item.status,
          readyCandidateRank: Number(item.rank || 0) || null,
          readyCandidateScore: Number(item.score || 0) || 0,
          _selectionOrigin: 'ready_backlog',
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const rankDiff = Number(a.readyCandidateRank || 999) - Number(b.readyCandidateRank || 999);
        if (rankDiff !== 0) return rankDiff;
        return Number(b.selectionScore || 0) - Number(a.selectionScore || 0);
      })
  ).slice(0, limit);
}

export function getSelectableBriefs({ limit = 8, prioritizeReady = true, readyBoost = 10 } = {}, pool = loadNewsPool()) {
  const pruned = pruneExpiredNews(pool);
  const readyPool = prioritizeReady ? pruneReadyArticleCandidates() : { items: [] };
  const readyMap = new Map(
    (readyPool.items || [])
      .filter((item) => item.status !== 'published')
      .map((item) => [item.identityKey, item])
  );

  const ranked = pruned.items
    .filter((item) => item.status !== 'published')
    .map((item) => {
      const scored = scorePoolItem(item, pruned);
      const readyMeta = readyMap.get(item.identityKey) || null;
      const readyRankBoost = readyMeta ? Math.max(0, 6 - Number(readyMeta.rank || 99)) : 0;
      const adjustedScore = scored.score + (readyMeta ? Number(readyBoost || 0) + readyRankBoost : 0);
      return {
        ...item.brief,
        poolIdentityKey: item.identityKey,
        selectionScore: adjustedScore,
        selectionNotes: readyMeta ? [...(scored.notes || []), `ready-priority:${readyMeta.rank || 'na'}`] : scored.notes,
        readyCandidateStatus: readyMeta?.status || null,
        readyCandidateRank: readyMeta ? Number(readyMeta.rank || 0) || null : null,
        _selectionOrigin: readyMeta ? 'pool_ready_prioritized' : (item.brief?._selectionOrigin || 'pool'),
      };
    })
    .sort((a, b) => {
      const leftReady = a.readyCandidateStatus && a.readyCandidateStatus !== 'published' ? 1 : 0;
      const rightReady = b.readyCandidateStatus && b.readyCandidateStatus !== 'published' ? 1 : 0;
      if (rightReady !== leftReady) return rightReady - leftReady;
      if (rightReady && leftReady) {
        const rankDiff = Number(a.readyCandidateRank || 999) - Number(b.readyCandidateRank || 999);
        if (rankDiff !== 0) return rankDiff;
      }
      return Number(b.selectionScore || 0) - Number(a.selectionScore || 0);
    });

  return dedupeBriefArrayBySelectionIdentity(ranked).slice(0, limit);
}

export function dedupeBriefCandidates(briefs = []) {
  return dedupeBriefArrayBySelectionIdentity(Array.isArray(briefs) ? briefs : []);
}

export function markBriefSelected(identityKey) {
  const pool = loadNewsPool();
  const items = pool.items.map((item) => item.identityKey === identityKey ? { ...item, lastSelectedAt: nowIso(), status: 'selected' } : item);
  updateReadyCandidateStatus(identityKey, { status: 'selected', lastSelectedAt: nowIso(), lastQueuedAt: nowIso() });
  return saveNewsPool({ ...pool, items });
}

export function markBriefPublished(identityKey, articleSlug = null) {
  const pool = loadNewsPool();
  const items = pool.items.map((item) => item.identityKey === identityKey ? {
    ...item,
    lastSelectedAt: nowIso(),
    lastPublishedAt: nowIso(),
    publishedSlug: articleSlug,
    status: 'published',
  } : item);
  updateReadyCandidateStatus(identityKey, { status: 'published', lastSelectedAt: nowIso(), lastPublishedAt: nowIso(), publishedSlug: articleSlug, lastQueuedAt: nowIso() });
  return saveNewsPool({ ...pool, items });
}

export function getNewsPoolStats(pool = loadNewsPool()) {
  const active = pool.items.filter((item) => item.status !== 'published').length;
  const readyPool = loadReadyArticleCandidates();
  return {
    total: pool.items.length,
    active,
    published: pool.items.filter((item) => item.status === 'published').length,
    ready_candidates: (readyPool.items || []).filter((item) => item.status !== 'published').length,
  };
}

function getDiscoveredIdentityKey(item) {
  if (item?.cluster_id || item?.clusterId) return `cluster:${item.cluster_id || item.clusterId}`;
  if (item?.eventKey) return `event:${item.eventKey}`;
  const primaryUrl = item.sourceUrls?.[0] || '';
  const title = String(item.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return primaryUrl ? `url:${normalizeUrl(primaryUrl)}` : `title:${title.slice(0, 120)}`;
}

export function mergeDiscoveredNews(items = []) {
  ensurePoolDir();
  let pool = { updatedAt: nowIso(), items: [] };
  if (fs.existsSync(DISCOVERED_POOL_PATH)) {
    try {
      pool = JSON.parse(fs.readFileSync(DISCOVERED_POOL_PATH, 'utf-8'));
      if (!Array.isArray(pool.items)) pool.items = [];
    } catch {
      pool = { updatedAt: nowIso(), items: [] };
    }
  }

  const now = Date.now();
  const freshItems = pool.items.filter((item) => new Date(item.expiresAt || 0).getTime() > now);
  const byKey = new Map(freshItems.map((item) => [item.identityKey, item]));

  for (const item of items) {
    const identityKey = getDiscoveredIdentityKey(item);
    const existing = byKey.get(identityKey);
    const next = {
      identityKey,
      item,
      discoveredAt: item.discoveredAt || nowIso(),
      lastSeenAt: nowIso(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
    };
    byKey.set(identityKey, existing ? { ...existing, ...next } : next);
  }

  const payload = { updatedAt: nowIso(), items: Array.from(byKey.values()) };
  fs.writeFileSync(DISCOVERED_POOL_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  return { total: payload.items.length };
}

export function loadDiscoveredNewsPool() {
  ensurePoolDir();
  if (!fs.existsSync(DISCOVERED_POOL_PATH)) {
    return { updatedAt: nowIso(), items: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DISCOVERED_POOL_PATH, 'utf-8'));
    return { updatedAt: parsed.updatedAt || nowIso(), items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { updatedAt: nowIso(), items: [] };
  }
}

export function findDiscoveredMatchesForBrief(brief, { limit = 8 } = {}, pool = loadDiscoveredNewsPool()) {
  const now = Date.now();
  const freshItems = (pool.items || []).filter((item) => new Date(item.expiresAt || 0).getTime() > now);
  const topicTokens = getTopicTokensFromBrief(brief);
  const briefTitleTokens = getTitleTokens(brief.title);
  const sourceUrlSet = new Set((brief.sourceUrls || []).map((url) => normalizeUrl(url)));
  const briefEntities = new Set(normalizeEntityList(brief.entities || brief.involvedParties));

  return freshItems
    .map((wrapper) => {
      const item = wrapper.item || {};
      const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
      const primaryUrl = normalizeUrl(item.sourceUrls?.[0] || item.url || '');
      const itemTitleTokens = getTitleTokens(item.title);
      let score = 0;
      if (brief.cluster_id && item.cluster_id && brief.cluster_id === item.cluster_id) score += 10;
      if (brief.eventKey && item.eventKey && brief.eventKey === item.eventKey) score += 8;
      if (brief.topic_id && item.detectedTopicId && brief.topic_id === item.detectedTopicId) score += 4;
      if (brief.section_id && item.detectedSectionId && brief.section_id === item.detectedSectionId) score += 2;
      if (brief.region && item.region && brief.region === item.region) score += 1;
      if (brief.angle && item.angle && brief.angle === item.angle) score += 1;
      if (primaryUrl && sourceUrlSet.has(primaryUrl)) score += 6;

      const tokenHits = topicTokens.filter((token) => text.includes(token)).length;
      score += Math.min(tokenHits, 4);

      const itemEntities = normalizeEntityList(item.entities || item.involvedParties);
      const entityHits = itemEntities.filter((entity) => briefEntities.has(entity)).length;
      score += Math.min(entityHits * 2, 4);

      const titleHits = briefTitleTokens.filter((token) => itemTitleTokens.includes(token)).length;
      const titleOverlapRatio = titleHits / Math.max(briefTitleTokens.length, itemTitleTokens.length, 1);
      if (titleHits >= 2 && titleOverlapRatio >= 0.25) {
        score += Math.min(6, titleHits + 1);
      }

      return { wrapper, score, tokenHits, entityHits, titleHits, titleOverlapRatio };
    })
    .filter((entry) => entry.score >= 5 || (entry.titleHits >= 2 && entry.titleOverlapRatio >= 0.25) || entry.entityHits >= 1)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.titleOverlapRatio !== a.titleOverlapRatio) return b.titleOverlapRatio - a.titleOverlapRatio;
      return new Date(b.wrapper.discoveredAt || 0) - new Date(a.wrapper.discoveredAt || 0);
    })
    .slice(0, limit)
    .map((entry) => entry.wrapper.item);
}


function getTitleTokens(value) {
  const stop = new Set(['the','and','for','with','amid','from','that','this','into','after','over','under','have','has','had','are','was','were','will','would','could','should','news','latest','breaking','report','reports','live','updates','today','story','stories','first','time']);
  return Array.from(new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 4 && !stop.has(token))));
}

function getTopicTokensFromBrief(brief) {
  const values = [brief.title, brief.whatHappened, brief.whoIsInvolved, ...(Array.isArray(brief.involvedParties) ? brief.involvedParties : [])];
  const stop = new Set(['the','and','for','with','amid','from','that','this','into','after','over','under','have','has','had','are','was','were','will','would','could','should','news','latest','breaking','report','reports','calls','call','says','said','amid']);
  return Array.from(new Set(values
    .flatMap((value) => String(value || '').toLowerCase().split(/[^a-z0-9]+/))
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stop.has(token))
  )).slice(0, 12);
}

function normalizeEntityList(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/,|;/);
  return Array.from(new Set(raw
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  ));
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}
