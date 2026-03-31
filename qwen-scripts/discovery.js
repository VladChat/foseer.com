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
      brave_expansion: 0,
      google_trusted: 0,
      gdelt: 0,
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

  const needsExpansion = filteredCandidates.length < CANDIDATE_FLOOR || viableCandidateCount < VIABLE_CANDIDATE_FLOOR;
  if (needsExpansion && allowExpansion && enableBrave && braveApiKey && plan.expansion.length > 0) {
    const shortageReason = filteredCandidates.length < CANDIDATE_FLOOR
      ? `raw_candidates=${filteredCandidates.length}<${CANDIDATE_FLOOR}`
      : `viable_candidates=${viableCandidateCount}<${VIABLE_CANDIDATE_FLOOR}`;
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
    if (!brief) return false;
    if (brief.crossTopicRisk) return false;
    if (brief.genericPage) return false;
    if (Number(brief.signalSpecificityScore || 0) < 6) return false;
    if (Number(brief.article_likelihood || 0) < 5) return false;

    const topicHints = Array.isArray(brief.topicCandidates) ? brief.topicCandidates.length : 0;
    const entities = Array.isArray(brief.entities) ? brief.entities.length : 0;
    return Boolean(brief.trustedSource) || topicHints > 0 || entities > 0;
  }).length;
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
  const genericPage = genericityScore >= 7;
  const trustedBoost = trustedSource ? 2 : 0;
  const taxonomyBoost = taxonomy.detectedTopicId ? 2 : taxonomy.detectedSectionId ? 1 : 0;
  const articleBonus = Math.max(0, articleLikelihood - 4) * 0.6;
  const genericPenalty = pageKind === 'homepage' ? 7 : Math.max(0, genericityScore - 5);
  const discoveryScore = freshness + urgency + trustedBoost + taxonomyBoost + articleBonus - genericPenalty;
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
