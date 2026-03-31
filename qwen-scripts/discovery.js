// File: qwen-scripts/discovery.js
// Purpose: Taxonomy-driven staged discovery with early page-kind classification and softer material retention.

import fs from 'node:fs';
import path from 'node:path';
import { braveNewsSearch, gdeltSearch, googleSearch } from './utils/api-clients.js';
import { buildGoogleTrustedQueries, isTrustedDiscoveryDomain } from './config/trusted-publishers.js';
import { loadTaxonomyRegistry, getSectionDiscoveryQueries, getTopicDiscoveryQueries, getTopicIdsBySection, matchTaxonomyHints } from './utils/taxonomy-registry.js';
import { resolveProjectRoot } from './utils/project-root.js';
import { detectPageKind, scoreGenericity, scoreArticleLikelihood } from './utils/page-kind.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const CANDIDATE_FLOOR = 10;
const VIABLE_CANDIDATE_FLOOR = 5;
const CORE_BRAVE_SECTION_LIMIT = 7;
const EXPANSION_TOPIC_LIMIT = 4;
const GOOGLE_LANE_LIMIT = 3;
const GDELT_LANE_LIMIT = 3;
const DISCOVERY_STATE_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'events', 'discovery-lane-state.json');
const NEWS_POOL_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'events', 'news-pool.json');
const TARGETED_BRAVE_QUERY_LIMIT = 1;
const TARGETED_COVERAGE_WINDOW_HOURS = 48;
const TARGETED_COVERAGE_RECENT_LIMIT = 16;
const TARGETED_COVERAGE_MIN_SAMPLE = 8;
const TARGETED_COVERAGE_MIN_MAX_SECTION_COUNT = 4;
const TARGETED_COVERAGE_MIN_GAP = 3;
const TARGETED_SECTION_VIABLE_FLOOR = 1;

let targetedCoverageQueriesUsed = 0;

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
  'google', 'meta', 'amazon', 'openai', 'nvidia', 'china', 'russia', 'ukraine', 'iran', 'israel', 'india', 'tiktok', 'bts', 'fifa', 'nba', 'nfl', 'tsa', 'faa'
];


export async function discoverWithBrave(apiKey, queryEntries, options = {}) {
  const allBriefs = [];
  const statuses = [];

  for (const entry of normalizeQueryEntries(queryEntries)) {
    try {
      const results = await braveNewsSearch(entry.query, apiKey, {
        count: entry.count || options.count || 5,
        freshness: options.freshness || 'pd',
        logLabel: options.logLabel || entry.logLabel || 'discovery_brave_news',
      });
      const items = results.results || [];
      statuses.push({ query: entry.query, lane: entry.lane, status: results.status, items: items.length });
      console.log(`[discovery] Brave query status=${results.status} items=${items.length} lane=${entry.lane} query=${entry.query}`);
      const briefs = items.map((item, index) => buildBrief({
        id: `${entry.idPrefix || 'brave'}-${Date.now()}-${index}`,
        title: item.title,
        summary: item.description || item.snippet || '',
        when: item.published || item.age || '',
        url: item.url,
        provider: 'brave',
        trustedSource: isTrustedDiscoveryDomain(item.url),
        lane: entry.lane,
        sectionHint: entry.sectionId,
        topicHint: entry.topicId,
      }));
      allBriefs.push(...briefs);
    } catch (error) {
      statuses.push({ query: entry.query, lane: entry.lane, status: 'exception', items: 0, error: error.message });
      console.error(`[discovery] Brave query failed: ${entry.query} - ${error.message}`);
    }
  }

  return { briefs: allBriefs, statuses };
}

export async function discoverWithGdelt(queryEntries, options = {}) {
  const allBriefs = [];
  const statuses = [];

  for (const entry of normalizeQueryEntries(queryEntries)) {
    try {
      const results = await gdeltSearch(entry.query, {
        maxRecords: entry.maxRecords || 10,
        sort: 'DateDesc',
        timespan: options.timespan || entry.timespan || '2days',
        logLabel: options.logLabel || entry.logLabel || 'discovery_gdelt',
      });
      const items = results.articles || [];
      statuses.push({ query: entry.query, lane: entry.lane, status: results.status, items: items.length });
      console.log(`[discovery] GDELT query status=${results.status} items=${items.length} lane=${entry.lane} query=${entry.query}`);
      const briefs = items.map((item, index) => buildBrief({
        id: `${entry.idPrefix || 'gdelt'}-${Date.now()}-${index}`,
        title: item.title,
        summary: item.snippet || item.description || '',
        when: item.seendate || item.published_at || '',
        url: item.url,
        provider: 'gdelt',
        trustedSource: isTrustedDiscoveryDomain(item.url),
        lane: entry.lane,
        sectionHint: entry.sectionId,
        topicHint: entry.topicId,
      }));
      allBriefs.push(...briefs);
    } catch (error) {
      statuses.push({ query: entry.query, lane: entry.lane, status: 'exception', items: 0, error: error.message });
      console.error(`[discovery] GDELT query failed: ${entry.query} - ${error.message}`);
    }
  }

  return { briefs: allBriefs, statuses };
}

export async function discoverWithTrustedGoogle(apiKey, cx, queryEntries, options = {}) {
  const allBriefs = [];
  const statuses = [];

  for (const entry of normalizeQueryEntries(queryEntries)) {
    try {
      const results = await googleSearch(entry.query, apiKey, cx, {
        num: entry.num || 10,
        dateRestrict: options.dateRestrict || entry.dateRestrict || 'd2',
        logLabel: options.logLabel || entry.logLabel || 'discovery_google_trusted',
      });
      const items = results.items || [];
      statuses.push({ query: entry.query, lane: entry.lane, status: results.status, items: items.length });
      console.log(`[discovery] Google trusted query status=${results.status} items=${items.length} lane=${entry.lane}`);
      const briefs = items.map((item, index) => buildBrief({
        id: `${entry.idPrefix || 'google'}-${Date.now()}-${index}`,
        title: item.title,
        summary: item.snippet || '',
        when: item.pagemap?.metatags?.[0]?.['article:published_time'] || item.pagemap?.metatags?.[0]?.['og:updated_time'] || '',
        url: item.link,
        provider: 'google_trusted',
        trustedSource: isTrustedDiscoveryDomain(item.link),
        lane: entry.lane,
        sectionHint: entry.sectionId,
        topicHint: entry.topicId,
      }));
      allBriefs.push(...briefs);
    } catch (error) {
      statuses.push({ query: entry.query, lane: entry.lane, status: 'exception', items: 0, error: error.message });
      console.error(`[discovery] Google trusted query failed: ${entry.query} - ${error.message}`);
    }
  }

  return { briefs: allBriefs, statuses };
}

export async function runDiscovery(options = {}) {
  console.log('[discovery] Starting taxonomy-driven signal discovery...');
  const braveApiKey = options.braveApiKey || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const googleApiKey = options.googleApiKey || process.env.SEARCH_WEB_API;
  const googleCx = options.googleCx || process.env.SEARCH_WEB_CX;
  const plan = buildDiscoveryPlan(options);
  const enableBrave = !Boolean(options.disableBrave);
  const enableGoogle = !Boolean(options.disableGoogle);
  const enableGdelt = !Boolean(options.disableGdelt);
  const allowExpansion = !Boolean(options.disableBraveExpansion);

  const stats = {
    candidate_floor: CANDIDATE_FLOOR,
    viable_candidate_floor: VIABLE_CANDIDATE_FLOOR,
    brave_queries: 0,
    targeted_brave_queries: 0,
    google_trusted_queries: 0,
    gdelt_queries: 0,
    total_candidates: 0,
    viable_candidates: 0,
    rejected_noise: 0,
    rejected_stale: 0,
    rejected_duplicate: 0,
    rejected_generic: 0,
    rejected_low_relevance: 0,
    rejected_cross_topic: 0,
    lanes: plan.core.map((entry) => entry.lane),
    channels: {
      brave_core: 0,
      brave_targeted: 0,
      brave_expansion: 0,
      google_trusted: 0,
      gdelt: 0,
    },
    targeted_coverage: {
      triggered: false,
      reason: null,
      section_id: null,
      topic_id: null,
      recent_window_hours: TARGETED_COVERAGE_WINDOW_HOURS,
      recent_sample_size: 0,
      section_counts: {},
      viable_in_target_section_before: 0,
      viable_in_target_section_after: 0,
      skipped_reason: null,
    },
  };

  const allCandidates = [];

  if (enableBrave && braveApiKey) {
    console.log('[discovery] Channel 1: Brave core discovery...');
    const braveCore = await discoverWithBrave(braveApiKey, plan.core, options);
    stats.brave_queries += plan.core.length;
    stats.channels.brave_core = braveCore.briefs.length;
    allCandidates.push(...braveCore.briefs);
    console.log(`[discovery] Brave core found ${braveCore.briefs.length} candidates across ${plan.core.length} lanes`);
  } else {
    console.log('[discovery] Skipping Brave (disabled or no API key)');
  }

  if (enableGoogle && googleApiKey && googleCx) {
    console.log('[discovery] Channel 2: Google trusted-source discovery...');
    const googlePlan = plan.google.length > 0 ? plan.google : buildFallbackGooglePlan();
    const googleTrusted = await discoverWithTrustedGoogle(googleApiKey, googleCx, googlePlan, options);
    stats.google_trusted_queries += googlePlan.length;
    stats.channels.google_trusted = googleTrusted.briefs.length;
    allCandidates.push(...googleTrusted.briefs);
    console.log(`[discovery] Google trusted-source found ${googleTrusted.briefs.length} candidates`);
  } else {
    console.log('[discovery] Skipping Google trusted-source discovery (disabled or missing API key/CX)');
  }

  if (enableGdelt && plan.gdelt.length > 0) {
    console.log('[discovery] Channel 3: GDELT signal discovery...');
    const gdeltSignals = await discoverWithGdelt(plan.gdelt, options);
    stats.gdelt_queries += plan.gdelt.length;
    stats.channels.gdelt = gdeltSignals.briefs.length;
    allCandidates.push(...gdeltSignals.briefs);
    console.log(`[discovery] GDELT signal discovery found ${gdeltSignals.briefs.length} candidates`);
  }

  let filteredCandidates = filterAndRankCandidates(allCandidates, stats);
  let viableCandidateCount = countViableCandidates(filteredCandidates);
  stats.viable_candidates = viableCandidateCount;
  const targetedCoveragePlan = buildTargetedCoveragePlan(options);
  if (targetedCoveragePlan?.sampleSize) {
    stats.targeted_coverage.recent_sample_size = targetedCoveragePlan.sampleSize;
    stats.targeted_coverage.section_counts = targetedCoveragePlan.sectionCounts;
    stats.targeted_coverage.section_id = targetedCoveragePlan.sectionId;
    stats.targeted_coverage.topic_id = targetedCoveragePlan.topicId || null;
    stats.targeted_coverage.reason = targetedCoveragePlan.reason;
  }

  if (
    targetedCoveragePlan
    && enableBrave
    && braveApiKey
    && targetedCoverageQueriesUsed < TARGETED_BRAVE_QUERY_LIMIT
  ) {
    const viableInTargetSection = countViableCandidatesBySection(filteredCandidates, targetedCoveragePlan.sectionId);
    stats.targeted_coverage.viable_in_target_section_before = viableInTargetSection;

    if (viableInTargetSection < TARGETED_SECTION_VIABLE_FLOOR) {
      console.log(`[discovery] Targeted coverage pass: section=${targetedCoveragePlan.sectionId}${targetedCoveragePlan.topicId ? ` topic=${targetedCoveragePlan.topicId}` : ''}`);
      const targetedResult = await discoverWithBrave(braveApiKey, [targetedCoveragePlan.queryEntry], {
        ...options,
        logLabel: 'discovery_brave_news_targeted',
      });
      targetedCoverageQueriesUsed += 1;
      stats.brave_queries += 1;
      stats.targeted_brave_queries += 1;
      stats.channels.brave_targeted = targetedResult.briefs.length;
      allCandidates.push(...targetedResult.briefs);
      filteredCandidates = filterAndRankCandidates(allCandidates, stats, true);
      viableCandidateCount = countViableCandidates(filteredCandidates);
      stats.viable_candidates = viableCandidateCount;
      stats.targeted_coverage.triggered = true;
      stats.targeted_coverage.viable_in_target_section_after = countViableCandidatesBySection(filteredCandidates, targetedCoveragePlan.sectionId);
    } else {
      stats.targeted_coverage.skipped_reason = `target_section_already_has_viable_candidates:${viableInTargetSection}`;
    }
  } else if (!targetedCoveragePlan) {
    stats.targeted_coverage.skipped_reason = 'no_clear_recent_imbalance';
  } else if (!(enableBrave && braveApiKey)) {
    stats.targeted_coverage.skipped_reason = 'brave_unavailable';
  } else if (targetedCoverageQueriesUsed >= TARGETED_BRAVE_QUERY_LIMIT) {
    stats.targeted_coverage.skipped_reason = 'targeted_query_limit_reached';
  }
  if (stats.targeted_coverage.triggered) {
    console.log(`[discovery] Targeted coverage applied: section=${stats.targeted_coverage.section_id}${stats.targeted_coverage.topic_id ? ` topic=${stats.targeted_coverage.topic_id}` : ''} fetched=${stats.channels.brave_targeted}`);
  } else if (stats.targeted_coverage.skipped_reason) {
    console.log(`[discovery] Targeted coverage skipped: ${stats.targeted_coverage.skipped_reason}`);
  }

  const needsExpansion = viableCandidateCount < VIABLE_CANDIDATE_FLOOR;
  if (needsExpansion && allowExpansion && enableBrave && braveApiKey && plan.expansion.length > 0) {
    const shortageReason = `viable_candidates=${viableCandidateCount}<${VIABLE_CANDIDATE_FLOOR}`;
    console.log(`[discovery] Candidate quality floor not met (${shortageReason}); running Brave expansion...`);
    const braveExpansion = await discoverWithBrave(braveApiKey, plan.expansion.map((entry) => ({ ...entry, logLabel: 'discovery_brave_news_expansion' })), options);
    stats.brave_queries += plan.expansion.length;
    stats.channels.brave_expansion = braveExpansion.briefs.length;
    allCandidates.push(...braveExpansion.briefs);
    console.log(`[discovery] Brave expansion found ${braveExpansion.briefs.length} candidates`);
    filteredCandidates = filterAndRankCandidates(allCandidates, stats, true);
    viableCandidateCount = countViableCandidates(filteredCandidates);
    stats.viable_candidates = viableCandidateCount;
  }

  stats.total_candidates = filteredCandidates.length;
  console.log(`[discovery] Discovery complete: ${stats.total_candidates} candidates after filtering (${stats.viable_candidates} viable)`);
  return { candidates: filteredCandidates, stats, discoveryPlan: plan };
}

function buildDiscoveryPlan(options = {}) {
  const registry = loadTaxonomyRegistry();
  const state = readDiscoveryState();
  const sectionIds = registry.navigation?.coreSectionIds?.length
    ? registry.navigation.coreSectionIds.slice()
    : registry.sections.map((section) => section.id);
  const rotatedSections = rotate(sectionIds, state.sectionOffset || 0);
  const coreSectionLimit = Math.max(1, Number(options.coreSectionLimit || CORE_BRAVE_SECTION_LIMIT));
  const expansionTopicLimit = Math.max(0, Number(options.expansionTopicLimit || EXPANSION_TOPIC_LIMIT));
  const googleLaneLimit = Math.max(0, Number(options.googleLaneLimit || GOOGLE_LANE_LIMIT));
  const gdeltLaneLimit = Math.max(0, Number(options.gdeltLaneLimit || GDELT_LANE_LIMIT));

  const coreSections = rotatedSections.slice(0, coreSectionLimit);
  const omittedSections = rotatedSections.slice(coreSectionLimit);

  const core = coreSections.flatMap((sectionId) => {
    const query = getSectionDiscoveryQueries(sectionId)[0];
    if (!query) return [];
    return [{
      query,
      lane: `section:${sectionId}`,
      sectionId,
      idPrefix: 'brave-sec',
      count: 5,
    }];
  });

  const allTopicIds = rotate(registry.topics.map((topic) => topic.id), state.topicOffset || 0);
  const preferredExpansionTopics = [
    ...omittedSections.flatMap((sectionId) => getTopicIdsBySection(sectionId)),
    ...allTopicIds,
  ];
  const seenTopics = new Set();
  const expansion = [];
  for (const topicId of preferredExpansionTopics) {
    if (seenTopics.has(topicId)) continue;
    seenTopics.add(topicId);
    const query = getTopicDiscoveryQueries(topicId)[0];
    if (!query) continue;
    const topic = registry.topicById?.[topicId];
    expansion.push({
      query,
      lane: `topic:${topicId}`,
      sectionId: topic?.section_id || null,
      topicId,
      idPrefix: 'brave-topic',
      count: 5,
    });
    if (expansion.length >= expansionTopicLimit) break;
  }

  const gdelt = buildGdeltFallbackPlan(coreSections, omittedSections, gdeltLaneLimit);
  const google = buildGooglePlan(coreSections, omittedSections, state, googleLaneLimit);

  writeDiscoveryState({
    sectionOffset: (state.sectionOffset || 0) + 1,
    topicOffset: (state.topicOffset || 0) + Math.max(1, expansionTopicLimit || 1),
    googleOffset: (state.googleOffset || 0) + 1,
  });

  return { core, expansion, gdelt, google };
}

function buildGooglePlan(coreSections, omittedSections, state = {}, laneLimit = GOOGLE_LANE_LIMIT) {
  const fallbackQueries = buildGoogleTrustedQueries();
  const plan = [];
  const preferredSections = Array.from(new Set([
    ...omittedSections,
    ...rotate(coreSections, state.googleOffset || state.sectionOffset || 0),
  ])).slice(0, Math.min(Math.max(0, laneLimit), fallbackQueries.length));

  preferredSections.forEach((sectionId, index) => {
    const sectionQuery = getSectionDiscoveryQueries(sectionId)[0];
    const baseQuery = fallbackQueries[index];
    if (!baseQuery) return;
    plan.push({
      query: sectionQuery ? `${baseQuery} (${sectionQuery})` : baseQuery,
      lane: `google:${sectionId}`,
      sectionId,
      idPrefix: 'google-sec',
      num: 10,
      dateRestrict: 'd2',
    });
  });
  return plan;
}

function buildFallbackGooglePlan() {
  return buildGoogleTrustedQueries().map((query, index) => ({
    query,
    lane: `google:fallback:${index}`,
    idPrefix: 'google',
    num: 10,
  }));
}

function buildGdeltFallbackPlan(coreSections, omittedSections, laneLimit = GDELT_LANE_LIMIT) {
  const fallbackSections = Array.from(new Set([...omittedSections, ...coreSections.slice(-1)]));
  return fallbackSections.slice(0, Math.max(0, laneLimit)).map((sectionId) => ({
    query: buildGdeltSectionQuery(sectionId),
    lane: `gdelt:${sectionId}`,
    sectionId,
    idPrefix: 'gdelt-sec',
    maxRecords: 10,
    timespan: '2days',
  }));
}

function buildGdeltSectionQuery(sectionId) {
  const sectionQuery = getSectionDiscoveryQueries(sectionId)[0] || sectionId;
  const compactTerms = Array.from(new Set(
    String(sectionQuery || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => token.length >= 3)
  )).slice(0, 7);
  const usableTerms = compactTerms.length > 0 ? compactTerms : [String(sectionId || 'news')];
  return `(${usableTerms.join(' OR ')}) AND sourcelang:english`;
}

function buildTargetedCoveragePlan(options = {}) {
  const disableTargetedCoverage = parseBooleanOption(
    options.disableTargetedCoverage
      ?? options.disable_targeted_coverage
      ?? process.env.QWEN_DISABLE_TARGETED_COVERAGE,
  );
  if (disableTargetedCoverage === true) return null;

  const registry = loadTaxonomyRegistry();
  const sample = loadRecentPublishedCoverageSample(registry, {
    windowHours: Number(options.coverageWindowHours || TARGETED_COVERAGE_WINDOW_HOURS),
    limit: Number(options.coverageRecentLimit || TARGETED_COVERAGE_RECENT_LIMIT),
  });
  if (sample.length < TARGETED_COVERAGE_MIN_SAMPLE) return null;

  const sectionIds = (registry.sections || []).map((section) => String(section.id || '').trim().toLowerCase()).filter(Boolean);
  if (sectionIds.length === 0) return null;

  const sectionCounts = Object.fromEntries(sectionIds.map((sectionId) => [sectionId, 0]));
  for (const record of sample) {
    if (!record.sectionId || sectionCounts[record.sectionId] === undefined) continue;
    sectionCounts[record.sectionId] += 1;
  }

  const maxCount = Math.max(...Object.values(sectionCounts));
  const minCount = Math.min(...Object.values(sectionCounts));
  const imbalanceGap = maxCount - minCount;
  if (maxCount < TARGETED_COVERAGE_MIN_MAX_SECTION_COUNT || imbalanceGap < TARGETED_COVERAGE_MIN_GAP) {
    return null;
  }

  const underfilledSections = sectionIds.filter((sectionId) => (sectionCounts[sectionId] || 0) === minCount);
  if (underfilledSections.length === 0) return null;
  const sectionId = underfilledSections[0];

  const sectionTopicIds = getTopicIdsBySection(sectionId).map((topicId) => String(topicId || '').trim().toLowerCase()).filter(Boolean);
  const topicCounts = Object.fromEntries(sectionTopicIds.map((topicId) => [topicId, 0]));
  for (const record of sample) {
    if (!record.topicId || topicCounts[record.topicId] === undefined) continue;
    topicCounts[record.topicId] += 1;
  }

  const topicId = pickTargetTopic(sectionTopicIds, topicCounts);
  const query = (topicId && getTopicDiscoveryQueries(topicId)[0]) || getSectionDiscoveryQueries(sectionId)[0] || null;
  if (!query) return null;

  return {
    sectionId,
    topicId: topicId || null,
    sampleSize: sample.length,
    sectionCounts,
    reason: `recent_section_imbalance:${sectionId}:${minCount}_vs_${maxCount}`,
    queryEntry: {
      query,
      lane: topicId ? `targeted:section:${sectionId}:topic:${topicId}` : `targeted:section:${sectionId}`,
      sectionId,
      topicId: topicId || null,
      idPrefix: 'brave-targeted',
      count: 5,
    },
  };
}

function loadRecentPublishedCoverageSample(registry, { windowHours = TARGETED_COVERAGE_WINDOW_HOURS, limit = TARGETED_COVERAGE_RECENT_LIMIT } = {}) {
  try {
    const raw = fs.readFileSync(NEWS_POOL_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const maxAgeMs = Math.max(1, Number(windowHours || TARGETED_COVERAGE_WINDOW_HOURS)) * 60 * 60 * 1000;
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .map((item) => {
        const publishedAt = parsePublishedTimestamp(item?.lastPublishedAt || item?.publishedAt || item?.updatedAt || null);
        if (!publishedAt) return null;
        if (now - publishedAt > maxAgeMs) return null;
        const brief = item?.brief || {};
        const sectionId = normalizeSectionId(
          item?.section_id || brief?.section_id || brief?.detectedSectionId || null,
          registry,
        );
        const topicId = String(item?.topic_id || brief?.topic_id || brief?.detectedTopicId || '')
          .trim()
          .toLowerCase();
        if (!sectionId) return null;
        return {
          publishedAt,
          sectionId,
          topicId: topicId || null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.publishedAt - left.publishedAt)
      .slice(0, Math.max(1, Number(limit || TARGETED_COVERAGE_RECENT_LIMIT)));
    return items;
  } catch {
    return [];
  }
}

function pickTargetTopic(topicIds = [], topicCounts = {}) {
  if (!Array.isArray(topicIds) || topicIds.length === 0) return null;
  const withQueries = topicIds.filter((topicId) => Boolean(getTopicDiscoveryQueries(topicId)[0]));
  if (withQueries.length === 0) return null;
  const minCount = Math.min(...withQueries.map((topicId) => Number(topicCounts[topicId] || 0)));
  const underfilledTopics = withQueries.filter((topicId) => Number(topicCounts[topicId] || 0) === minCount);
  return underfilledTopics[0] || withQueries[0] || null;
}

function normalizeQueryEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => {
    if (typeof entry === 'string') {
      return { query: entry, lane: `generic:${index}` };
    }
    return entry;
  }).filter((entry) => entry?.query);
}

function filterAndRankCandidates(candidates, stats, recompute = false) {
  if (recompute) {
    stats.rejected_noise = 0;
    stats.rejected_stale = 0;
    stats.rejected_duplicate = 0;
    stats.rejected_generic = 0;
    stats.rejected_low_relevance = 0;
    stats.rejected_cross_topic = 0;
  }

  const seenKeys = new Set();
  const filtered = [];
  for (const brief of candidates) {
    if (isNoise(brief)) {
      stats.rejected_noise += 1;
      continue;
    }
    if (brief.freshness < 3) {
      stats.rejected_stale += 1;
      continue;
    }

    const dedupeKey = brief.eventKey || brief.canonicalUrl || brief.normalizedTitle || brief.title.toLowerCase().substring(0, 120);
    if (seenKeys.has(dedupeKey)) {
      stats.rejected_duplicate += 1;
      continue;
    }
    seenKeys.add(dedupeKey);

    if (brief.page_kind === 'homepage' || brief.page_kind === 'video' || brief.page_kind === 'audio') {
      stats.rejected_generic += 1;
      continue;
    }

    if (brief.crossTopicRisk) {
      stats.rejected_cross_topic += 1;
      continue;
    }

    if ((brief.signalSpecificityScore || 0) < 4) {
      stats.rejected_low_relevance += 1;
      continue;
    }

    filtered.push(brief);
  }

  filtered.sort((a, b) => (b.discoveryScore || 0) - (a.discoveryScore || 0));
  return filtered;
}

function countViableCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).filter((brief) => {
    return isViableCandidate(brief);
  }).length;
}

function countViableCandidatesBySection(candidates = [], sectionId = null) {
  if (!sectionId) return 0;
  return (Array.isArray(candidates) ? candidates : []).filter((brief) => {
    if (!isViableCandidate(brief)) return false;
    const detected = String(brief.detectedSectionId || '').trim().toLowerCase();
    if (detected === sectionId) return true;
    const sectionHints = Array.isArray(brief.sectionCandidates)
      ? brief.sectionCandidates.map((value) => String(value || '').trim().toLowerCase())
      : [];
    return sectionHints.includes(sectionId);
  }).length;
}

function isViableCandidate(brief = null) {
  if (!brief) return false;
  if (brief.crossTopicRisk) return false;
  if (brief.genericPage) return false;
  if (Number(brief.signalSpecificityScore || 0) < 6) return false;
  if (Number(brief.article_likelihood || 0) < 5) return false;

  const topicHints = Array.isArray(brief.topicCandidates) ? brief.topicCandidates.length : 0;
  const entities = Array.isArray(brief.entities) ? brief.entities.length : 0;
  return Boolean(brief.trustedSource) || topicHints > 0 || entities > 0;
}

function buildBrief({ id, title, summary, when, url, provider, trustedSource, lane, sectionHint, topicHint }) {
  const cleanedTitle = cleanTitle(title);
  const taxonomy = matchTaxonomyHints(`${cleanedTitle} ${summary || ''}`, url || '');
  const entities = extractParties(cleanedTitle, summary || '');
  const region = detectRegion(cleanedTitle, summary || '', url || '');
  const angle = detectAngle(cleanedTitle, summary || '');
  const freshness = scoreFreshness(when);
  const urgency = scoreUrgency(cleanedTitle, summary || '');
  const pageKind = detectPageKind({ url, title: cleanedTitle, snippet: summary || '' });
  const genericityScore = scoreGenericity(pageKind, { url, title: cleanedTitle, snippet: summary || '' });
  const articleLikelihood = scoreArticleLikelihood(pageKind, { url, title: cleanedTitle, snippet: summary || '' });
  const targetedLane = String(lane || '').startsWith('targeted:');
  const genericPage = genericityScore >= 7;
  const trustedBoost = trustedSource ? 2 : 0;
  const taxonomyBoost = taxonomy.detectedTopicId ? 2 : taxonomy.detectedSectionId ? 1 : 0;
  const articleBonus = Math.max(0, articleLikelihood - 4) * 0.6;
  const targetedBoost = targetedLane ? 0.8 : 0;
  const genericPenalty = pageKind === 'homepage' ? 7 : Math.max(0, genericityScore - 5);
  const discoveryScore = freshness + urgency + trustedBoost + taxonomyBoost + articleBonus + targetedBoost - genericPenalty;
  const detectedSectionId = taxonomy.detectedSectionId || sectionHint || null;
  const detectedTopicId = taxonomy.detectedTopicId || topicHint || null;
  const normalizedTitle = cleanedTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const signalQuality = assessSignalSpecificity({
    title: cleanedTitle,
    summary: summary || '',
    sectionCandidates: taxonomy.sectionCandidates || [],
    topicCandidates: taxonomy.topicCandidates || [],
    pageKind,
    articleLikelihood,
  });

  return {
    id,
    title: cleanedTitle,
    summary: summary || '',
    whyItMatters: '',
    involvedParties: entities,
    entities,
    when: when || '',
    sourceUrls: [url].filter(Boolean),
    freshness,
    urgency,
    discoveredAt: new Date().toISOString(),
    provider,
    trustedSource: Boolean(trustedSource),
    discoveryLane: lane || (detectedTopicId ? `topic:${detectedTopicId}` : detectedSectionId ? `section:${detectedSectionId}` : 'unassigned'),
    sectionCandidates: uniqueStrings([...(taxonomy.sectionCandidates || []), sectionHint].filter(Boolean)).slice(0, 3),
    topicCandidates: uniqueStrings([...(taxonomy.topicCandidates || []), topicHint].filter(Boolean)).slice(0, 3),
    detectedSectionId,
    detectedTopicId,
    region,
    angle,
    genericPage,
    page_kind: pageKind,
    genericity_score: genericityScore,
    article_likelihood: articleLikelihood,
    normalizedTitle,
    canonicalUrl: canonicalizeUrl(url),
    discoveryScore: Math.round(discoveryScore * 10) / 10,
    targetedCoverage: targetedLane,
    eventKey: `${(detectedTopicId || detectedSectionId || 'general')}:${normalizedTitle.slice(0, 80)}`,
    signalSpecificityScore: signalQuality.score,
    signalSpecificityNotes: signalQuality.notes,
    crossTopicRisk: signalQuality.crossTopicRisk,
  };
}

function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').replace(/\s*[-|:]\s*$/, '').trim().substring(0, 120);
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

function isNoise(brief) {
  const text = `${brief.title || ''} ${brief.summary || ''}`.toLowerCase();
  return /(podcast|newsletter|watch live|video:|audio:|photo gallery)/.test(text);
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

function scoreFreshness(value) {
  const parsed = parsePublishedTime(value);
  if (!parsed) return 4;
  const hours = Math.max(0, (Date.now() - parsed.getTime()) / 3600000);
  if (hours <= 3) return 9;
  if (hours <= 8) return 8;
  if (hours <= 18) return 7;
  if (hours <= 30) return 6;
  if (hours <= 48) return 5;
  if (hours <= 72) return 3;
  return 2;
}

function parsePublishedTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  const clean = String(value).trim().toLowerCase();
  const hourMatch = clean.match(/(\d+)\s*h/);
  if (hourMatch) return new Date(Date.now() - Number(hourMatch[1]) * 3600000);
  const dayMatch = clean.match(/(\d+)\s*d/);
  if (dayMatch) return new Date(Date.now() - Number(dayMatch[1]) * 86400000);
  return null;
}

function scoreUrgency(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  let score = 4;
  if (/(breaking|developing|just in|warns|alert|urgent)/.test(text)) score += 2;
  if (/(charges|charged|lawsuit|court|attack|approves|approval|launches|announces|earnings|ceasefire|shutdown|delays)/.test(text)) score += 2;
  if (/(today|this morning|tonight|hours after|amid)/.test(text)) score += 1;
  return Math.min(9, score);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function parseBooleanOption(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parsePublishedTimestamp(value) {
  const parsed = new Date(value || 0).getTime();
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function normalizeSectionId(value, registry = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const taxonomy = registry || loadTaxonomyRegistry();
  const direct = (taxonomy.sections || []).find((section) => String(section.id || '').trim().toLowerCase() === raw);
  if (direct) return String(direct.id).trim().toLowerCase();
  const byLabel = (taxonomy.sections || []).find((section) => String(section.label || '').trim().toLowerCase() === raw);
  if (byLabel) return String(byLabel.id).trim().toLowerCase();
  return raw;
}

function rotate(items, offset) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(normalizedOffset), ...items.slice(0, normalizedOffset)];
}

function readDiscoveryState() {
  try {
    const raw = fs.readFileSync(DISCOVERY_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return { sectionOffset: Number(parsed.sectionOffset || 0), topicOffset: Number(parsed.topicOffset || 0), googleOffset: Number(parsed.googleOffset || 0) };
  } catch {
    return { sectionOffset: 0, topicOffset: 0, googleOffset: 0 };
  }
}

function writeDiscoveryState(state) {
  fs.mkdirSync(path.dirname(DISCOVERY_STATE_PATH), { recursive: true });
  fs.writeFileSync(DISCOVERY_STATE_PATH, JSON.stringify({
    sectionOffset: Number(state.sectionOffset || 0),
    topicOffset: Number(state.topicOffset || 0),
    googleOffset: Number(state.googleOffset || 0),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}
