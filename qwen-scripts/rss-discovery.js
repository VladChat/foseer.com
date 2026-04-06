// File: qwen-scripts/rss-discovery.js
// Purpose: RSS discovery provider with feed-level resilience, candidate normalization, and coverage-aware intake.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getEnabledRssFeeds } from './utils/rss-feed-registry.js';
import { resolveProjectRoot } from './utils/project-root.js';
import { isTrustedDiscoveryDomain } from './config/trusted-publishers.js';
import { loadTaxonomyRegistry, matchTaxonomyHints } from './utils/taxonomy-registry.js';
import { detectPageKind, scoreArticleLikelihood, scoreGenericity } from './utils/page-kind.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const RSS_STATE_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'events', 'rss-provider-state.json');
const DISCOVERED_POOL_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'events', 'discovered-news-pool.json');
const NEWS_POOL_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'events', 'news-pool.json');
const PUBLISH_MANIFESTS_DIR = path.resolve(PROJECT_ROOT, 'qwen-data', 'publish-manifests');

const RSS_REQUEST_TIMEOUT_MS = 12000;
const RSS_BACKOFF_BASE_MS = 15 * 60 * 1000;
const RSS_BACKOFF_MAX_MS = 12 * 60 * 60 * 1000;
const RSS_SEEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const RSS_SEEN_MAX_PER_FEED = 500;
const COVERAGE_WINDOW_HOURS = 48;
const COVERAGE_SAMPLE_LIMIT = 200;
const DEFAULT_MAX_ACCEPTED_PER_FEED = 2;
const DEFAULT_MAX_ACCEPTED_PER_PUBLISHER = 3;
const DEFAULT_MAX_RSS_ACCEPTED = 24;
const DEFAULT_MAX_SHARE = 0.35;
const DEFAULT_ADAPTIVE_MAX_SHARE = 0.45;
const DEFAULT_ADAPTIVE_UNDERCOVERAGE_RATIO = 0.34;
const DEFAULT_ADAPTIVE_LOW_SUPPLY_THRESHOLD = 10;

const REGION_PATTERNS = [
  ['united states', 'us'], ['u.s.', 'us'], ['america', 'us'], ['white house', 'us'], ['congress', 'us'], ['senate', 'us'],
  ['europe', 'europe'], ['eu', 'europe'], ['ukraine', 'ukraine'], ['russia', 'russia'], ['china', 'china'], ['india', 'india'],
  ['middle east', 'middle-east'], ['israel', 'israel'], ['iran', 'iran'], ['gaza', 'middle-east'], ['syria', 'middle-east'],
  ['canada', 'canada'], ['mexico', 'mexico'], ['australia', 'australia'], ['africa', 'africa'],
];

const ANGLE_PATTERNS = [
  ['regulation', 'policy'], ['policy', 'policy'], ['court', 'legal'], ['judge', 'legal'], ['charged', 'legal'], ['lawsuit', 'legal'],
  ['earnings', 'earnings'], ['stocks', 'markets'], ['market', 'markets'], ['inflation', 'economy'], ['economy', 'economy'],
  ['launch', 'product'], ['released', 'product'], ['announced', 'announcement'], ['approval', 'regulation'], ['approved', 'regulation'],
  ['research', 'research'], ['study', 'research'], ['trial', 'research'], ['attack', 'conflict'], ['war', 'conflict'], ['ceasefire', 'conflict'],
  ['transfer', 'transfers'], ['tournament', 'events'], ['streaming', 'media'], ['celebrity', 'culture'], ['viral', 'culture'], ['shutdown', 'policy'], ['delays', 'consumer-impact'],
];

const ENTITY_TERMS = [
  'fda', 'sec', 'white house', 'congress', 'senate', 'supreme court', 'jpmorgan', 'goldman sachs', 'tesla', 'apple', 'microsoft',
  'google', 'meta', 'amazon', 'openai', 'nvidia', 'china', 'russia', 'ukraine', 'iran', 'israel', 'india', 'tiktok', 'bts', 'fifa', 'nba', 'nfl', 'tsa', 'faa',
];

export async function discoverWithRss(options = {}) {
  const taxonomy = loadTaxonomyRegistry();
  const existingCandidates = Array.isArray(options.existingCandidates) ? options.existingCandidates : [];
  const feedsInput = Array.isArray(options.rssFeedOverrides)
    ? options.rssFeedOverrides
    : getEnabledRssFeeds({ forceReload: Boolean(options.forceReloadRssRegistry) });

  const coverage = buildCoverageSnapshot({
    taxonomy,
    windowHours: Number(options.rssCoverageWindowHours || COVERAGE_WINDOW_HOURS),
    sampleLimit: Number(options.rssCoverageSampleLimit || COVERAGE_SAMPLE_LIMIT),
  });

  const state = options.disableStatePersistence ? buildDefaultRssState() : readRssProviderState();
  const nowMs = Date.now();

  const runtimeFeeds = (Array.isArray(feedsInput) ? feedsInput : [])
    .map((feed) => normalizeRuntimeFeed(feed, taxonomy))
    .filter((feed) => feed && feed.enabled)
    .sort((left, right) => {
      const leftScore = computeFeedCoveragePriority(left, coverage);
      const rightScore = computeFeedCoveragePriority(right, coverage);
      if (rightScore !== leftScore) return rightScore - leftScore;
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.id.localeCompare(right.id);
    });

  const stats = {
    rss_feeds_configured: runtimeFeeds.length,
    rss_feeds_polled: 0,
    rss_items_seen: 0,
    rss_items_accepted: 0,
    rss_feed_failures: 0,
    rss_items_skipped_duplicate: 0,
    rss_items_skipped_stale: 0,
    rss_items_skipped_generic: 0,
    rss_items_skipped_invalid: 0,
    rss_items_skipped_coverage_caps: 0,
    rss_feeds_skipped_backoff: 0,
    rss_share_after_merge: 0,
    rss_max_share_base: DEFAULT_MAX_SHARE,
    rss_max_share_effective: DEFAULT_MAX_SHARE,
    rss_share_adaptive_applied: false,
    rss_share_adaptive_reason: 'none',
    rss_undercoverage_ratio: 0,
    rss_target_cap: 0,
    accepted_by_section: {},
    accepted_by_topic: {},
    skipped_feeds: [],
    backed_off_feeds: [],
    accepted_candidates: [],
  };

  const existingIndex = buildCandidateIndex(existingCandidates);
  const rssInternalIndex = buildCandidateIndex([]);
  const viableEntries = [];
  const seenToPersistByFeed = new Map();

  for (const feed of runtimeFeeds) {
    const feedState = ensureFeedState(state, feed.id);
    const backoffUntilMs = parseDateMs(feedState.backoffUntil);

    if (backoffUntilMs > nowMs) {
      stats.rss_feeds_skipped_backoff += 1;
      stats.skipped_feeds.push({
        feed_id: feed.id,
        reason: 'backoff_active',
        backoff_until: new Date(backoffUntilMs).toISOString(),
      });
      continue;
    }

    stats.rss_feeds_polled += 1;
    const pollResult = await pollSingleRssFeed(feed, feedState, options);

    if (!pollResult.success) {
      stats.rss_feed_failures += 1;
      const failureState = markFeedFailure(feedState, pollResult.errorType, pollResult.errorMessage);
      stats.skipped_feeds.push({
        feed_id: feed.id,
        reason: 'poll_failed',
        error: pollResult.errorMessage,
      });
      if (failureState.backoffUntil) {
        stats.backed_off_feeds.push({
          feed_id: feed.id,
          backoff_until: failureState.backoffUntil,
          consecutive_failures: failureState.consecutiveFailures,
          reason: pollResult.errorType || 'poll_failed',
        });
      }
      continue;
    }

    markFeedSuccess(feedState, pollResult);
    const feedSeenKeys = ensureSeenSet(seenToPersistByFeed, feed.id);

    const items = Array.isArray(pollResult.items) ? pollResult.items : [];
    stats.rss_items_seen += items.length;

    for (const item of items) {
      const normalized = normalizeFeedItemToEntry({ item, feed, taxonomy });
      if (!normalized) {
        stats.rss_items_skipped_invalid += 1;
        continue;
      }

      if (normalized.ageHours > feed.freshnessHours) {
        stats.rss_items_skipped_stale += 1;
        feedSeenKeys.add(normalized.stableKey);
        continue;
      }

      if (normalized.brief.genericPage || Number(normalized.brief.genericity_score || 0) >= 7) {
        stats.rss_items_skipped_generic += 1;
        feedSeenKeys.add(normalized.stableKey);
        continue;
      }

      if (hasSeenItemKey(feedState, normalized.stableKey)) {
        stats.rss_items_skipped_duplicate += 1;
        continue;
      }

      const duplicateCheck = classifyDuplicateAgainstIndexes(normalized.brief, existingIndex, rssInternalIndex);
      if (duplicateCheck.hardDuplicate) {
        stats.rss_items_skipped_duplicate += 1;
        feedSeenKeys.add(normalized.stableKey);
        continue;
      }

      viableEntries.push({
        ...normalized,
        duplicatePenalty: duplicateCheck.softPenalty,
      });
      addCandidateToIndex(normalized.brief, rssInternalIndex);
    }
  }

  const rssAdaptiveShareEnabled = parseBooleanLike(
    options.rssAdaptiveShare ?? process.env.QWEN_RSS_ADAPTIVE_SHARE ?? true,
    true,
  );
  const shareConfig = resolveAdaptiveRssShareConfig({
    coverage,
    existingCount: existingCandidates.length,
    baseShare: Number(options.rssMaxShare ?? process.env.QWEN_RSS_MAX_SHARE ?? DEFAULT_MAX_SHARE),
    maxShareUpperBound: Number(options.rssAdaptiveMaxShare ?? process.env.QWEN_RSS_ADAPTIVE_MAX_SHARE ?? DEFAULT_ADAPTIVE_MAX_SHARE),
    undercoverageRatioThreshold: Number(options.rssAdaptiveUndercoverageRatio ?? process.env.QWEN_RSS_ADAPTIVE_UNDERCOVERAGE_RATIO ?? DEFAULT_ADAPTIVE_UNDERCOVERAGE_RATIO),
    lowSupplyThreshold: Number(options.rssAdaptiveLowSupplyThreshold ?? process.env.QWEN_RSS_ADAPTIVE_LOW_SUPPLY_THRESHOLD ?? DEFAULT_ADAPTIVE_LOW_SUPPLY_THRESHOLD),
    adaptiveEnabled: rssAdaptiveShareEnabled,
  });

  const coverageAwareAccepted = selectCoverageAwareRssEntries(viableEntries, {
    coverage,
    existingCount: existingCandidates.length,
    maxAcceptedPerFeed: Number(options.rssMaxAcceptedPerFeed ?? process.env.QWEN_RSS_MAX_ACCEPTED_PER_FEED ?? DEFAULT_MAX_ACCEPTED_PER_FEED),
    maxAcceptedPerPublisher: Number(options.rssMaxAcceptedPerPublisher ?? process.env.QWEN_RSS_MAX_ACCEPTED_PER_PUBLISHER ?? DEFAULT_MAX_ACCEPTED_PER_PUBLISHER),
    maxAcceptedTotal: Number(options.rssMaxAcceptedTotal ?? process.env.QWEN_RSS_MAX_ACCEPTED_TOTAL ?? DEFAULT_MAX_RSS_ACCEPTED),
    maxShare: shareConfig.effectiveShare,
  });

  for (const entry of coverageAwareAccepted.accepted) {
    const feedSeenKeys = ensureSeenSet(seenToPersistByFeed, entry.feed.id);
    feedSeenKeys.add(entry.stableKey);

    const sectionId = String(entry.brief.detectedSectionId || '').trim().toLowerCase();
    const topicId = String(entry.brief.detectedTopicId || '').trim().toLowerCase();
    if (sectionId) stats.accepted_by_section[sectionId] = Number(stats.accepted_by_section[sectionId] || 0) + 1;
    if (topicId) stats.accepted_by_topic[topicId] = Number(stats.accepted_by_topic[topicId] || 0) + 1;

    stats.accepted_candidates.push({
      id: entry.brief.id,
      feed_id: entry.feed.id,
      publisher: entry.feed.publisher,
      section_id: sectionId || null,
      topic_id: topicId || null,
      title: entry.brief.title,
      url: entry.brief.canonicalUrl,
      discovery_score: entry.brief.discoveryScore,
      acceptance_score: Math.round(entry.acceptanceScore * 10) / 10,
    });
  }

  stats.rss_items_accepted = coverageAwareAccepted.accepted.length;
  stats.rss_items_skipped_coverage_caps = coverageAwareAccepted.rejectedByCaps;
  stats.rss_share_after_merge = computeRssShare(stats.rss_items_accepted, existingCandidates.length);
  stats.rss_max_share_base = shareConfig.baseShare;
  stats.rss_max_share_effective = shareConfig.effectiveShare;
  stats.rss_share_adaptive_applied = shareConfig.adaptiveApplied;
  stats.rss_share_adaptive_reason = shareConfig.reason;
  stats.rss_undercoverage_ratio = shareConfig.undercoverageRatio;
  stats.rss_target_cap = Number(coverageAwareAccepted.targetCap || 0);

  persistSeenEntries(state, seenToPersistByFeed);
  state.updatedAt = new Date().toISOString();
  if (!options.disableStatePersistence) {
    writeRssProviderState(state);
  }

  return {
    briefs: coverageAwareAccepted.accepted.map((entry) => entry.brief),
    stats,
  };
}

function selectCoverageAwareRssEntries(entries = [], {
  coverage,
  existingCount,
  maxAcceptedPerFeed,
  maxAcceptedPerPublisher,
  maxAcceptedTotal,
  maxShare,
} = {}) {
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map((entry) => {
    const coverageBoost = computeCoverageBoost(entry.brief, coverage);
    const freshnessBonus = Math.max(0, Number(entry.brief.freshness || 0) - 4) * 0.35;
    const duplicatePenalty = Number(entry.duplicatePenalty || 0);
    const acceptanceScore = Number(entry.brief.discoveryScore || 0) + coverageBoost + freshnessBonus - duplicatePenalty;
    return {
      ...entry,
      coverageBoost,
      acceptanceScore,
      freshnessBonus,
    };
  });

  const capFromShare = computeMaxAcceptedFromShare(existingCount, maxShare, maxAcceptedTotal);
  const targetCap = Math.max(0, Math.min(maxAcceptedTotal, capFromShare));
  const pool = normalizedEntries
    .sort((left, right) => right.acceptanceScore - left.acceptanceScore)
    .slice(0, Math.max(targetCap * 4, maxAcceptedTotal * 2, 30));

  const selected = [];
  const selectedKeys = new Set();
  const feedCounts = new Map();
  const publisherCounts = new Map();
  const sectionCounts = new Map();

  const undercoveredSections = Array.isArray(coverage?.undercoveredSections)
    ? coverage.undercoveredSections
    : [];

  const canTake = (entry) => {
    const feedCount = Number(feedCounts.get(entry.feed.id) || 0);
    const publisherCount = Number(publisherCounts.get(entry.feed.publisher) || 0);
    if (feedCount >= Math.max(1, maxAcceptedPerFeed)) return false;
    if (publisherCount >= Math.max(1, maxAcceptedPerPublisher)) return false;
    return true;
  };

  const take = (entry) => {
    selected.push(entry);
    selectedKeys.add(entry.stableKey);

    feedCounts.set(entry.feed.id, Number(feedCounts.get(entry.feed.id) || 0) + 1);
    publisherCounts.set(entry.feed.publisher, Number(publisherCounts.get(entry.feed.publisher) || 0) + 1);

    const sectionId = String(entry.brief.detectedSectionId || '').trim().toLowerCase();
    if (sectionId) {
      sectionCounts.set(sectionId, Number(sectionCounts.get(sectionId) || 0) + 1);
    }
  };

  for (const sectionId of undercoveredSections) {
    if (selected.length >= targetCap) break;
    const match = pool.find((entry) => {
      if (selectedKeys.has(entry.stableKey)) return false;
      if (!canTake(entry)) return false;
      const detected = String(entry.brief.detectedSectionId || '').trim().toLowerCase();
      const sectionCandidates = Array.isArray(entry.brief.sectionCandidates)
        ? entry.brief.sectionCandidates.map((value) => String(value || '').trim().toLowerCase())
        : [];
      if (detected === sectionId) return true;
      return sectionCandidates.includes(sectionId);
    });
    if (match) take(match);
  }

  while (selected.length < targetCap) {
    let bestEntry = null;
    let bestScore = -Infinity;

    for (const entry of pool) {
      if (selectedKeys.has(entry.stableKey)) continue;
      if (!canTake(entry)) continue;

      const publisherCount = Number(publisherCounts.get(entry.feed.publisher) || 0);
      const sectionId = String(entry.brief.detectedSectionId || '').trim().toLowerCase();
      const sectionCount = sectionId ? Number(sectionCounts.get(sectionId) || 0) : 0;

      const publisherDiversityPenalty = Math.max(0, publisherCount) * 1.2;
      const sectionRepetitionPenalty = Math.max(0, sectionCount - 1) * 0.6;
      const effectiveScore = entry.acceptanceScore - publisherDiversityPenalty - sectionRepetitionPenalty;

      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestEntry = entry;
      }
    }

    if (!bestEntry || bestScore < 3) break;
    take(bestEntry);
  }

  const rejectedByCaps = Math.max(0, pool.length - selected.length);
  return { accepted: selected, rejectedByCaps, targetCap };
}

function computeMaxAcceptedFromShare(existingCount, maxShare, absoluteCap) {
  const normalizedShare = Math.max(0.1, Math.min(0.5, Number(maxShare || DEFAULT_MAX_SHARE)));
  const cap = Math.max(1, Number(absoluteCap || DEFAULT_MAX_RSS_ACCEPTED));
  if (existingCount <= 0) return cap;

  const shareCap = Math.floor((normalizedShare * existingCount) / Math.max(0.0001, 1 - normalizedShare));
  return Math.max(1, Math.min(cap, shareCap));
}

function resolveAdaptiveRssShareConfig({
  coverage = {},
  existingCount = 0,
  baseShare = DEFAULT_MAX_SHARE,
  maxShareUpperBound = DEFAULT_ADAPTIVE_MAX_SHARE,
  undercoverageRatioThreshold = DEFAULT_ADAPTIVE_UNDERCOVERAGE_RATIO,
  lowSupplyThreshold = DEFAULT_ADAPTIVE_LOW_SUPPLY_THRESHOLD,
  adaptiveEnabled = true,
} = {}) {
  const normalizedBaseShare = clampNumber(baseShare, 0.1, 0.5, DEFAULT_MAX_SHARE);
  const normalizedAdaptiveMax = clampNumber(
    maxShareUpperBound,
    normalizedBaseShare,
    0.5,
    Math.max(DEFAULT_ADAPTIVE_MAX_SHARE, normalizedBaseShare),
  );
  const normalizedUndercoverageThreshold = clampNumber(
    undercoverageRatioThreshold,
    0.05,
    1,
    DEFAULT_ADAPTIVE_UNDERCOVERAGE_RATIO,
  );
  const normalizedLowSupplyThreshold = Math.max(
    1,
    Math.floor(clampNumber(lowSupplyThreshold, 1, 1000, DEFAULT_ADAPTIVE_LOW_SUPPLY_THRESHOLD)),
  );

  const sectionCounts = coverage?.sectionCounts && typeof coverage.sectionCounts === 'object'
    ? coverage.sectionCounts
    : {};
  const totalSections = Object.keys(sectionCounts).length;
  const undercoveredCount = Array.isArray(coverage?.undercoveredSections) ? coverage.undercoveredSections.length : 0;
  const undercoverageRatio = totalSections > 0 ? undercoveredCount / totalSections : 0;

  if (!adaptiveEnabled) {
    return {
      baseShare: normalizedBaseShare,
      effectiveShare: normalizedBaseShare,
      adaptiveApplied: false,
      reason: 'disabled',
      undercoverageRatio: Math.round(undercoverageRatio * 1000) / 1000,
    };
  }

  const reasons = [];
  let boost = 0;

  if (undercoverageRatio >= normalizedUndercoverageThreshold) {
    boost += 0.05;
    reasons.push('undercoverage');
    if (undercoverageRatio >= Math.min(1, normalizedUndercoverageThreshold + 0.2)) {
      boost += 0.03;
      reasons.push('severe_undercoverage');
    }
  }

  if (Number(existingCount || 0) < normalizedLowSupplyThreshold) {
    boost += 0.05;
    reasons.push('low_non_rss_supply');
  }

  const effectiveShare = clampNumber(
    normalizedBaseShare + boost,
    normalizedBaseShare,
    normalizedAdaptiveMax,
    normalizedBaseShare,
  );

  return {
    baseShare: normalizedBaseShare,
    effectiveShare,
    adaptiveApplied: effectiveShare > normalizedBaseShare + 1e-6,
    reason: reasons.length ? reasons.join('+') : 'none',
    undercoverageRatio: Math.round(undercoverageRatio * 1000) / 1000,
  };
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

function parseBooleanLike(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function computeRssShare(rssCount = 0, existingCount = 0) {
  const total = Number(rssCount || 0) + Number(existingCount || 0);
  if (total <= 0) return 0;
  return Math.round((Number(rssCount || 0) / total) * 1000) / 1000;
}

function computeFeedCoveragePriority(feed, coverage = {}) {
  const sectionBoost = Math.max(...feed.sectionHints.map((sectionId) => Number(coverage?.sectionDeficits?.[sectionId] || 0)), 0);
  const topicBoost = Math.max(...feed.topicHints.map((topicId) => Number(coverage?.topicDeficits?.[topicId] || 0)), 0);
  return Number(feed.priority || 1) + (sectionBoost * 0.15) + (topicBoost * 0.1);
}

function computeCoverageBoost(brief, coverage = {}) {
  const sectionId = String(brief?.detectedSectionId || '').trim().toLowerCase();
  const topicId = String(brief?.detectedTopicId || '').trim().toLowerCase();

  const sectionDeficit = sectionId ? Number(coverage?.sectionDeficits?.[sectionId] || 0) : 0;
  const topicDeficit = topicId ? Number(coverage?.topicDeficits?.[topicId] || 0) : 0;

  let boost = 0;
  boost += Math.min(3, sectionDeficit * 0.5);
  boost += Math.min(2.5, topicDeficit * 0.45);

  const undercoveredSections = new Set(Array.isArray(coverage?.undercoveredSections) ? coverage.undercoveredSections : []);
  const undercoveredTopics = new Set(Array.isArray(coverage?.undercoveredTopics) ? coverage.undercoveredTopics : []);

  if (sectionId && undercoveredSections.has(sectionId)) boost += 0.8;
  if (topicId && undercoveredTopics.has(topicId)) boost += 1.0;

  return Math.round(boost * 10) / 10;
}

function classifyDuplicateAgainstIndexes(brief, existingIndex, localIndex) {
  const canonical = String(brief?.canonicalUrl || '').trim().toLowerCase();
  const title = String(brief?.normalizedTitle || '').trim().toLowerCase();

  if (canonical && (existingIndex.canonicalSet.has(canonical) || localIndex.canonicalSet.has(canonical))) {
    return { hardDuplicate: true, softPenalty: 3 };
  }

  if (title && (existingIndex.titleSet.has(title) || localIndex.titleSet.has(title))) {
    return { hardDuplicate: true, softPenalty: 2.5 };
  }

  const titleTokens = tokenSetFromTitle(brief?.title || brief?.normalizedTitle || '');
  const strongCandidates = [...existingIndex.strongCandidates, ...localIndex.strongCandidates];

  let bestSoftPenalty = 0;
  for (const candidate of strongCandidates) {
    const overlap = tokenJaccard(titleTokens, candidate.tokens);
    if (overlap >= 0.86) {
      return { hardDuplicate: true, softPenalty: 3 };
    }
    if (overlap >= 0.68) {
      bestSoftPenalty = Math.max(bestSoftPenalty, 1.2);
    }
  }

  return { hardDuplicate: false, softPenalty: bestSoftPenalty };
}

function buildCandidateIndex(candidates = []) {
  const index = {
    canonicalSet: new Set(),
    titleSet: new Set(),
    strongCandidates: [],
  };

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    addCandidateToIndex(candidate, index);
  }

  return index;
}

function addCandidateToIndex(candidate, index) {
  const canonical = String(candidate?.canonicalUrl || candidate?.sourceUrls?.[0] || '').trim().toLowerCase();
  const normalizedTitle = String(candidate?.normalizedTitle || normalizeTitle(candidate?.title || '')).trim().toLowerCase();

  if (canonical) index.canonicalSet.add(canonical);
  if (normalizedTitle) index.titleSet.add(normalizedTitle);

  const discoveryScore = Number(candidate?.discoveryScore || 0);
  if (discoveryScore >= 8 || candidate?.provider !== 'rss') {
    index.strongCandidates.push({
      tokens: tokenSetFromTitle(candidate?.title || candidate?.normalizedTitle || ''),
      canonical,
      normalizedTitle,
    });
  }
}

function tokenSetFromTitle(value = '') {
  const tokens = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !['with', 'from', 'into', 'after', 'amid', 'news', 'latest', 'live', 'updates', 'report', 'reports'].includes(token));
  return new Set(tokens);
}

function tokenJaccard(leftSet, rightSet) {
  if (!(leftSet instanceof Set) || !(rightSet instanceof Set)) return 0;
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = leftSet.size + rightSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function normalizeRuntimeFeed(feed, taxonomy) {
  try {
    const id = String(feed?.id || '').trim().toLowerCase();
    const url = String(feed?.url || '').trim();
    const publisher = String(feed?.publisher || '').trim();
    if (!id || !url || !publisher) return null;

    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    const topicHints = uniqueStrings(Array.isArray(feed?.topicHints) ? feed.topicHints : []).map((value) => String(value).toLowerCase());
    const sectionHintsDirect = uniqueStrings(Array.isArray(feed?.sectionHints) ? feed.sectionHints : []).map((value) => String(value).toLowerCase());
    const topicSections = topicHints
      .map((topicId) => String(taxonomy.sectionByTopic?.[topicId] || '').trim().toLowerCase())
      .filter(Boolean);

    const sectionHints = uniqueStrings([...sectionHintsDirect, ...topicSections]);

    return {
      id,
      url: parsed.toString(),
      publisher,
      sectionHints,
      topicHints,
      enabled: feed.enabled !== false,
      priority: Number(feed.priority ?? 1),
      maxItemsPerPoll: Math.max(1, Number(feed.maxItemsPerPoll ?? 3)),
      freshnessHours: Math.max(1, Number(feed.freshnessHours ?? 72)),
      notes: feed.notes ? String(feed.notes).trim() : null,
    };
  } catch {
    return null;
  }
}

async function pollSingleRssFeed(feed, feedState, options = {}) {
  const timeoutMs = Number(options.rssRequestTimeoutMs || RSS_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs));

  const headers = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    'User-Agent': 'Foseer/1.0 (RSS Discovery)',
  };
  if (feedState.etag) headers['If-None-Match'] = String(feedState.etag);
  if (feedState.lastModified) headers['If-Modified-Since'] = String(feedState.lastModified);

  try {
    const response = await fetch(feed.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (response.status === 304) {
      return {
        success: true,
        statusCode: 304,
        etag: response.headers.get('etag') || feedState.etag || null,
        lastModified: response.headers.get('last-modified') || feedState.lastModified || null,
        items: [],
      };
    }

    if (!response.ok) {
      return {
        success: false,
        errorType: response.status >= 500 ? 'http_5xx' : response.status >= 400 ? 'http_4xx' : 'http_error',
        errorMessage: `HTTP ${response.status} while polling ${feed.url}`,
      };
    }

    const xml = await response.text();
    let items;
    try {
      items = parseFeedItems(xml, feed).slice(0, Math.max(1, feed.maxItemsPerPoll));
    } catch (error) {
      return {
        success: false,
        errorType: 'parse_error',
        errorMessage: `XML parse error for ${feed.url}: ${String(error?.message || error)}`,
      };
    }

    return {
      success: true,
      statusCode: response.status,
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null,
      items,
    };
  } catch (error) {
    const aborted = String(error?.name || '').toLowerCase() === 'aborterror';
    return {
      success: false,
      errorType: aborted ? 'timeout' : 'network_error',
      errorMessage: aborted
        ? `Timeout polling ${feed.url}`
        : `Network error polling ${feed.url}: ${String(error?.message || error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseFeedItems(xmlRaw, feed) {
  const xml = String(xmlRaw || '')
    .replace(/^[\uFEFF\u200B]+/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');

  if (!xml.trim()) return [];

  const isAtom = /<feed[\s>]/i.test(xml) || /<entry[\s>]/i.test(xml);
  const feedTitle = sanitizeFeedText(readFirstTagValue(xml, ['title']) || feed.publisher || '');

  if (isAtom) {
    const entries = extractTagBlocks(xml, 'entry');
    return entries.map((block) => ({
      title: sanitizeFeedText(readFirstTagValue(block, ['title']) || ''),
      summary: sanitizeFeedText(readFirstTagValue(block, ['summary', 'content']) || ''),
      link: sanitizeFeedText(readAtomEntryLink(block) || ''),
      guid: sanitizeFeedText(readFirstTagValue(block, ['id', 'guid']) || ''),
      publishedAt: sanitizeFeedText(readFirstTagValue(block, ['published', 'updated', 'dc:date']) || ''),
      feedTitle,
      publisher: feed.publisher,
    })).filter((item) => item.title && item.link);
  }

  const items = extractTagBlocks(xml, 'item');
  return items.map((block) => ({
    title: sanitizeFeedText(readFirstTagValue(block, ['title']) || ''),
    summary: sanitizeFeedText(readFirstTagValue(block, ['description', 'content:encoded', 'content', 'summary']) || ''),
    link: sanitizeFeedText(readFirstTagValue(block, ['link']) || ''),
    guid: sanitizeFeedText(readFirstTagValue(block, ['guid', 'id']) || ''),
    publishedAt: sanitizeFeedText(readFirstTagValue(block, ['pubDate', 'published', 'updated', 'dc:date']) || ''),
    feedTitle,
    publisher: feed.publisher,
  })).filter((item) => item.title && item.link);
}

function normalizeFeedItemToEntry({ item, feed, taxonomy }) {
  const title = cleanTitle(item.title || '');
  const summary = cleanSummary(item.summary || '');

  const canonicalUrl = canonicalizeUrl(item.link || '');
  if (!canonicalUrl) return null;

  const publishedAtMs = parseDateMs(item.publishedAt);
  const ageHours = publishedAtMs > 0
    ? Math.max(0, (Date.now() - publishedAtMs) / (60 * 60 * 1000))
    : 999;

  const taxonomyMatch = matchTaxonomyHints(`${title} ${summary}`, canonicalUrl);
  const fallbackTopicId = feed.topicHints[0] || null;
  const fallbackSectionId = feed.sectionHints[0] || null;

  const detectedTopicId = taxonomyMatch.detectedTopicId || fallbackTopicId || null;
  const detectedSectionFromTopic = detectedTopicId ? String(taxonomy.sectionByTopic?.[detectedTopicId] || '').trim().toLowerCase() : null;
  const detectedSectionId = detectedSectionFromTopic || taxonomyMatch.detectedSectionId || fallbackSectionId || null;

  const pageKind = detectPageKind({ url: canonicalUrl, title, snippet: summary });
  const genericityScore = scoreGenericity(pageKind, { url: canonicalUrl, title, snippet: summary });
  const articleLikelihood = scoreArticleLikelihood(pageKind, { url: canonicalUrl, title, snippet: summary });

  const freshness = scoreFreshness(item.publishedAt);
  const urgency = scoreUrgency(title, summary);
  const trustedSource = isTrustedDiscoveryDomain(canonicalUrl);
  const entities = extractParties(title, summary);
  const region = detectRegion(title, summary, canonicalUrl);
  const angle = detectAngle(title, summary);
  const normalizedTitle = normalizeTitle(title);

  const sectionCandidates = uniqueStrings([
    ...(Array.isArray(taxonomyMatch.sectionCandidates) ? taxonomyMatch.sectionCandidates : []),
    ...feed.sectionHints,
    detectedSectionId,
  ]).slice(0, 4);

  const topicCandidates = uniqueStrings([
    ...(Array.isArray(taxonomyMatch.topicCandidates) ? taxonomyMatch.topicCandidates : []),
    ...feed.topicHints,
    detectedTopicId,
  ]).slice(0, 4);

  const signalSpecificity = assessSignalSpecificity({
    title,
    summary,
    sectionCandidates,
    topicCandidates,
    pageKind,
    articleLikelihood,
  });

  const trustedBoost = trustedSource ? 2 : 0;
  const taxonomyBoost = detectedTopicId ? 2 : detectedSectionId ? 1 : 0;
  const articleBonus = Math.max(0, articleLikelihood - 4) * 0.6;
  const genericPenalty = pageKind === 'homepage' ? 7 : Math.max(0, genericityScore - 5);
  const discoveryScore = freshness + urgency + trustedBoost + taxonomyBoost + articleBonus - genericPenalty;

  const stableKeySource = buildStableItemIdentity(feed.id, item.guid, canonicalUrl, normalizedTitle, publishedAtMs);
  const stableKey = `${feed.id}:${stableKeySource.hash}`;

  const brief = {
    id: `rss-${feed.id}-${stableKeySource.hash}`,
    title,
    summary,
    whyItMatters: '',
    involvedParties: entities,
    entities,
    when: item.publishedAt || '',
    sourceUrls: [canonicalUrl],
    freshness,
    urgency,
    discoveredAt: new Date().toISOString(),
    provider: 'rss',
    trustedSource,
    discoveryLane: `rss:${feed.id}:${detectedSectionId || 'unassigned'}`,
    sectionCandidates,
    topicCandidates,
    detectedSectionId,
    detectedTopicId,
    region,
    angle,
    genericPage: genericityScore >= 7,
    page_kind: pageKind,
    genericity_score: genericityScore,
    article_likelihood: articleLikelihood,
    normalizedTitle,
    canonicalUrl,
    discoveryScore: Math.round(discoveryScore * 10) / 10,
    eventKey: `${(detectedTopicId || detectedSectionId || 'general')}:${normalizedTitle.slice(0, 80)}`,
    signalSpecificityScore: signalSpecificity.score,
    signalSpecificityNotes: signalSpecificity.notes,
    crossTopicRisk: signalSpecificity.crossTopicRisk,
  };

  return {
    feed,
    item,
    brief,
    stableKey,
    stableHash: stableKeySource.hash,
    ageHours,
    publishedAtMs,
  };
}

function buildStableItemIdentity(feedId, guid, canonicalUrl, normalizedTitle, publishedAtMs) {
  const normalizedGuid = String(guid || '').trim();
  const publishedToken = Number.isFinite(publishedAtMs) && publishedAtMs > 0
    ? new Date(publishedAtMs).toISOString()
    : 'unknown-published';

  const base = normalizedGuid
    || canonicalUrl
    || `${feedId}|${normalizedTitle}|${publishedToken}`;

  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
  return {
    base,
    hash,
  };
}

function buildCoverageSnapshot({ taxonomy, windowHours, sampleLimit } = {}) {
  const sectionIds = (taxonomy.sections || []).map((section) => String(section.id || '').trim().toLowerCase()).filter(Boolean);
  const topicIds = (taxonomy.topics || []).map((topic) => String(topic.id || '').trim().toLowerCase()).filter(Boolean);

  const sectionCounts = Object.fromEntries(sectionIds.map((id) => [id, 0]));
  const topicCounts = Object.fromEntries(topicIds.map((id) => [id, 0]));

  const nowMs = Date.now();
  const windowMs = Math.max(1, Number(windowHours || COVERAGE_WINDOW_HOURS)) * 60 * 60 * 1000;

  const applyCount = (sectionId, topicId, observedAtMs) => {
    if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) return;
    if ((nowMs - observedAtMs) > windowMs) return;

    const normalizedTopicId = String(topicId || '').trim().toLowerCase();
    const normalizedSectionId = String(sectionId || '').trim().toLowerCase() || String(taxonomy.sectionByTopic?.[normalizedTopicId] || '').trim().toLowerCase();

    if (normalizedSectionId && sectionCounts[normalizedSectionId] !== undefined) {
      sectionCounts[normalizedSectionId] += 1;
    }
    if (normalizedTopicId && topicCounts[normalizedTopicId] !== undefined) {
      topicCounts[normalizedTopicId] += 1;
    }
  };

  const discoveredPool = safeReadJson(DISCOVERED_POOL_PATH, { items: [] });
  for (const wrapper of (Array.isArray(discoveredPool.items) ? discoveredPool.items : []).slice(0, sampleLimit)) {
    const item = wrapper?.item || {};
    const observedAtMs = parseDateMs(item.discoveredAt || wrapper?.discoveredAt || wrapper?.lastSeenAt);
    applyCount(item.detectedSectionId, item.detectedTopicId, observedAtMs);
  }

  const newsPool = safeReadJson(NEWS_POOL_PATH, { items: [] });
  for (const wrapper of (Array.isArray(newsPool.items) ? newsPool.items : []).slice(0, sampleLimit)) {
    const brief = wrapper?.brief || {};
    const observedAtMs = parseDateMs(wrapper?.lastPublishedAt || wrapper?.lastSeenAt || wrapper?.discoveredAt || brief?.discoveredAt);
    applyCount(
      wrapper?.section_id || brief?.section_id || brief?.detectedSectionId,
      wrapper?.topic_id || brief?.topic_id || brief?.detectedTopicId,
      observedAtMs,
    );
  }

  if (fs.existsSync(PUBLISH_MANIFESTS_DIR)) {
    const files = fs.readdirSync(PUBLISH_MANIFESTS_DIR)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .slice(-Math.max(30, sampleLimit));

    for (const fileName of files) {
      const manifest = safeReadJson(path.resolve(PUBLISH_MANIFESTS_DIR, fileName), null);
      if (!manifest) continue;
      const observedAtMs = parseDateMs(manifest.published_at || manifest.generated_at);
      applyCount(manifest.section_id, manifest.topic_id, observedAtMs);
    }
  }

  const sectionValues = Object.values(sectionCounts);
  const topicValues = Object.values(topicCounts);
  const maxSectionCount = Math.max(...sectionValues, 0);
  const minSectionCount = Math.min(...sectionValues, 0);
  const maxTopicCount = Math.max(...topicValues, 0);
  const minTopicCount = Math.min(...topicValues, 0);

  const sectionDeficits = Object.fromEntries(Object.entries(sectionCounts).map(([sectionId, count]) => [sectionId, Math.max(0, maxSectionCount - Number(count || 0))]));
  const topicDeficits = Object.fromEntries(Object.entries(topicCounts).map(([topicId, count]) => [topicId, Math.max(0, maxTopicCount - Number(count || 0))]));

  const undercoveredSections = Object.entries(sectionCounts)
    .filter(([, count]) => Number(count || 0) <= minSectionCount + 1)
    .map(([sectionId]) => sectionId);

  const undercoveredTopics = Object.entries(topicCounts)
    .filter(([, count]) => Number(count || 0) <= minTopicCount)
    .map(([topicId]) => topicId)
    .slice(0, 12);

  return {
    windowHours: Number(windowHours || COVERAGE_WINDOW_HOURS),
    sectionCounts,
    topicCounts,
    sectionDeficits,
    topicDeficits,
    undercoveredSections,
    undercoveredTopics,
  };
}

function buildDefaultRssState() {
  return {
    version: 1,
    updatedAt: null,
    feeds: {},
  };
}

function readRssProviderState() {
  const parsed = safeReadJson(RSS_STATE_PATH, null);
  if (!parsed || typeof parsed !== 'object') {
    return buildDefaultRssState();
  }

  return {
    version: Number(parsed.version || 1),
    updatedAt: parsed.updatedAt || null,
    feeds: parsed.feeds && typeof parsed.feeds === 'object' ? parsed.feeds : {},
  };
}

function writeRssProviderState(state) {
  fs.mkdirSync(path.dirname(RSS_STATE_PATH), { recursive: true });
  fs.writeFileSync(RSS_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function ensureFeedState(state, feedId) {
  if (!state.feeds || typeof state.feeds !== 'object') state.feeds = {};

  const raw = state.feeds[feedId] && typeof state.feeds[feedId] === 'object'
    ? state.feeds[feedId]
    : {};

  const normalizedSeen = Array.isArray(raw.seenItems)
    ? raw.seenItems
      .map((entry) => ({
        key: String(entry?.key || '').trim(),
        seenAt: parseDateMs(entry?.seenAt) > 0 ? new Date(parseDateMs(entry?.seenAt)).toISOString() : null,
      }))
      .filter((entry) => entry.key && entry.seenAt)
    : [];

  const normalized = {
    lastAttemptAt: raw.lastAttemptAt || null,
    lastSuccessfulPollAt: raw.lastSuccessfulPollAt || null,
    consecutiveFailures: Math.max(0, Number(raw.consecutiveFailures || 0)),
    backoffUntil: raw.backoffUntil || null,
    lastStatus: raw.lastStatus || null,
    lastError: raw.lastError || null,
    etag: raw.etag || null,
    lastModified: raw.lastModified || null,
    seenItems: pruneSeenItems(normalizedSeen),
  };

  state.feeds[feedId] = normalized;
  return normalized;
}

function markFeedSuccess(feedState, pollResult) {
  const nowIso = new Date().toISOString();
  feedState.lastAttemptAt = nowIso;
  feedState.lastSuccessfulPollAt = nowIso;
  feedState.consecutiveFailures = 0;
  feedState.backoffUntil = null;
  feedState.lastStatus = pollResult.statusCode === 304 ? 'not_modified' : 'ok';
  feedState.lastError = null;
  feedState.etag = pollResult.etag || feedState.etag || null;
  feedState.lastModified = pollResult.lastModified || feedState.lastModified || null;
}

function markFeedFailure(feedState, errorType = 'unknown_error', errorMessage = 'RSS polling failed') {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nextFailures = Math.max(0, Number(feedState.consecutiveFailures || 0)) + 1;
  const backoffMs = computeBackoffMs(nextFailures, errorType);
  const backoffUntil = new Date(nowMs + backoffMs).toISOString();

  feedState.lastAttemptAt = nowIso;
  feedState.consecutiveFailures = nextFailures;
  feedState.backoffUntil = backoffUntil;
  feedState.lastStatus = 'failed';
  feedState.lastError = `${errorType}: ${String(errorMessage || 'RSS polling failed').slice(0, 400)}`;

  return {
    consecutiveFailures: nextFailures,
    backoffUntil,
  };
}

function computeBackoffMs(consecutiveFailures = 1, errorType = 'unknown_error') {
  const base = Math.min(RSS_BACKOFF_MAX_MS, RSS_BACKOFF_BASE_MS * (2 ** Math.max(0, Number(consecutiveFailures || 1) - 1)));
  if (String(errorType || '').startsWith('parse_') || errorType === 'parse_error') {
    return Math.min(RSS_BACKOFF_MAX_MS, Math.max(base, 2 * 60 * 60 * 1000));
  }
  if (errorType === 'http_4xx') {
    return Math.min(RSS_BACKOFF_MAX_MS, Math.max(base, 60 * 60 * 1000));
  }
  return base;
}

function persistSeenEntries(state, seenByFeed) {
  const nowIso = new Date().toISOString();

  for (const [feedId, keysSet] of seenByFeed.entries()) {
    if (!(keysSet instanceof Set) || keysSet.size === 0) continue;

    const feedState = ensureFeedState(state, feedId);
    const existing = Array.isArray(feedState.seenItems) ? feedState.seenItems : [];
    const mergedMap = new Map(existing.map((entry) => [entry.key, entry.seenAt]));

    for (const key of keysSet) {
      if (!key) continue;
      mergedMap.set(String(key), nowIso);
    }

    feedState.seenItems = pruneSeenItems(
      Array.from(mergedMap.entries()).map(([key, seenAt]) => ({ key, seenAt }))
    );
  }
}

function hasSeenItemKey(feedState, key) {
  if (!feedState || !key) return false;
  return (Array.isArray(feedState.seenItems) ? feedState.seenItems : [])
    .some((entry) => entry?.key === key);
}

function pruneSeenItems(items = []) {
  const nowMs = Date.now();
  return (Array.isArray(items) ? items : [])
    .map((entry) => ({
      key: String(entry?.key || '').trim(),
      seenAt: parseDateMs(entry?.seenAt) > 0 ? new Date(parseDateMs(entry?.seenAt)).toISOString() : null,
    }))
    .filter((entry) => entry.key && entry.seenAt)
    .filter((entry) => (nowMs - parseDateMs(entry.seenAt)) <= RSS_SEEN_MAX_AGE_MS)
    .sort((left, right) => parseDateMs(right.seenAt) - parseDateMs(left.seenAt))
    .slice(0, RSS_SEEN_MAX_PER_FEED);
}

function ensureSeenSet(map, feedId) {
  if (!map.has(feedId)) map.set(feedId, new Set());
  return map.get(feedId);
}

function extractTagBlocks(xml = '', tagName = '') {
  const escaped = escapeRegex(String(tagName || '').trim());
  if (!escaped) return [];

  const patterns = [
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi'),
    new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${escaped}>`, 'gi'),
  ];

  for (const pattern of patterns) {
    const blocks = [];
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      blocks.push(String(match[1] || ''));
    }
    if (blocks.length > 0) return blocks;
  }

  return [];
}

function readFirstTagValue(xmlBlock = '', tagNames = []) {
  for (const tagName of Array.isArray(tagNames) ? tagNames : []) {
    const raw = readFirstTagValueByName(xmlBlock, tagName);
    if (raw) return raw;
  }
  return '';
}

function readFirstTagValueByName(xmlBlock = '', tagName = '') {
  const escaped = escapeRegex(String(tagName || '').trim());
  if (!escaped) return '';

  const patterns = [
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'),
    new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${escaped}>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(xmlBlock);
    if (match?.[1]) return String(match[1]);
  }

  return '';
}

function readAtomEntryLink(entryBlock = '') {
  const withHref = /<link\b[^>]*?href=["']([^"']+)["'][^>]*>/i.exec(entryBlock);
  if (withHref?.[1]) return withHref[1];

  const simple = readFirstTagValue(entryBlock, ['link']);
  return simple || '';
}

function sanitizeFeedText(value = '') {
  const withoutCdata = String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const withoutHtml = withoutCdata
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decodeHtmlEntities(withoutHtml);
}

function decodeHtmlEntities(value = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (full, name) => named[String(name || '').toLowerCase()] || full)
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-|:]\s*$/, '')
    .trim()
    .substring(0, 160);
}

function cleanSummary(summary) {
  return String(summary || '').replace(/\s+/g, ' ').trim().substring(0, 420);
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().toLowerCase();
  } catch {
    return '';
  }
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function scoreFreshness(value) {
  const parsed = parseDateMs(value);
  if (!parsed) return 4;
  const hours = Math.max(0, (Date.now() - parsed) / 3600000);
  if (hours <= 3) return 9;
  if (hours <= 8) return 8;
  if (hours <= 18) return 7;
  if (hours <= 30) return 6;
  if (hours <= 48) return 5;
  if (hours <= 72) return 3;
  return 2;
}

function scoreUrgency(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  let score = 4;
  if (/(breaking|developing|just in|warns|alert|urgent)/.test(text)) score += 2;
  if (/(charges|charged|lawsuit|court|attack|approves|approval|launches|announces|earnings|ceasefire|shutdown|delays)/.test(text)) score += 2;
  if (/(today|this morning|tonight|hours after|amid)/.test(text)) score += 1;
  return Math.min(9, score);
}

function extractParties(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  const parties = [];
  for (const entity of ENTITY_TERMS) {
    if (textContainsPattern(text, entity)) parties.push(entity);
  }
  return uniqueStrings(parties).slice(0, 8);
}

function detectRegion(title, summary, url) {
  const text = `${title} ${summary} ${url}`.toLowerCase();
  const match = REGION_PATTERNS.find(([pattern]) => textContainsPattern(text, pattern));
  return match?.[1] || 'global';
}

function detectAngle(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  const match = ANGLE_PATTERNS.find(([pattern]) => textContainsPattern(text, pattern));
  return match?.[1] || 'general';
}

function textContainsPattern(text, pattern) {
  const normalizedText = String(text || '').toLowerCase();
  const normalizedPattern = String(pattern || '').toLowerCase().trim();
  if (!normalizedPattern) return false;
  const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(normalizedText);
}

function assessSignalSpecificity({ title = '', summary = '', sectionCandidates = [], topicCandidates = [], pageKind = 'unknown', articleLikelihood = 0 } = {}) {
  const text = `${title} ${summary}`.toLowerCase();
  const notes = [];
  let score = 0;

  if (title.length >= 32) {
    score += 2;
    notes.push('title_specificity');
  }

  if (Number(articleLikelihood || 0) >= 6) {
    score += 2;
    notes.push('article_likelihood');
  } else if (Number(articleLikelihood || 0) >= 4) {
    score += 1;
  }

  if (topicCandidates.length > 0) {
    score += 2;
    notes.push('topic_hint');
  } else if (sectionCandidates.length > 0) {
    score += 1;
  }

  if (/(^|\b)(live updates?|latest news|at a glance|roundup|watch live|newsletter|digest)($|\b)/i.test(text)) {
    score -= 3;
    notes.push('generic_container_phrase');
  }

  if (['section', 'topic', 'homepage', 'live', 'roundup'].includes(String(pageKind || '').toLowerCase())) {
    score -= 2;
    notes.push(`container_kind:${pageKind}`);
  }

  const hasNamedEventMarker = /([A-Z][a-z]+\s+[A-Z][a-z]+|\b[A-Z]{2,5}\b|\b(nfl|nba|mlb|fda|sec|congress|white house|supreme court|olympic|trump|biden)\b)/i.test(title);
  if (hasNamedEventMarker) {
    score += 1;
    notes.push('named_marker');
  }

  const crossTopicRisk = topicCandidates.length >= 2 && sectionCandidates.length >= 2;
  if (crossTopicRisk) {
    score -= 2;
    notes.push('cross_topic_risk');
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    notes,
    crossTopicRisk,
  };
}

function parseDateMs(value) {
  const parsed = new Date(value || 0).getTime();
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function safeReadJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) return fallbackValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallbackValue;
  }
}
