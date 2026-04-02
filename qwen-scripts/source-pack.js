// File: qwen-scripts/source-pack.js
// Purpose: Assemble a one-event source pack with role-aware source classification instead of hard dropping useful materials.

import { loadNewsPool, findDiscoveredMatchesForBrief } from './utils/news-pool.js';
import { buildCoverageContext, scoreCandidateWithSourcePack } from './nodes/selection-node.js';
import { normalizeSourceMaterial } from './utils/source-normalization.js';
import { classifySourceRole } from './nodes/source-role-node.js';
import { loadTaxonomyRegistry, matchTaxonomyHints } from './utils/taxonomy-registry.js';
import {
  isOfficialPrimaryDomain,
  isStrictSingleSourceWhitelistDomain,
  isTrustedReportingDomain,
  normalizeDomain,
} from './config/trusted-publishers.js';

const GENERIC_TOPIC_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'from', 'with', 'amid', 'over', 'under', 'after', 'before', 'into', 'onto', 'across', 'about',
  'this', 'that', 'these', 'those', 'latest', 'updates', 'breaking', 'news', 'live', 'coverage', 'report', 'reports', 'reporting',
  'story', 'stories', 'today', 'world', 'international', 'national'
]);

const PRIMARYISH_TITLE_HINTS = [
  'statement', 'press release', 'order', 'opinion', 'filing', 'complaint', 'memo', 'transcript', 'official', 'agency', 'department', 'ministry', 'court'
];

export async function assembleSourcePack(eventBrief, options = {}) {
  console.log(`[source-pack] topic=${eventBrief.title}`);

  const collected = [];
  const seenUrls = new Set();
  const topicSignals = buildTopicSignals(eventBrief);

  const relatedItems = [
    ...(Array.isArray(eventBrief.discoveryContext) ? eventBrief.discoveryContext : []),
    ...findDiscoveredMatchesForBrief(eventBrief, { limit: options.poolMatchLimit || 14 }),
  ];

  for (const item of relatedItems) {
    collectDiscoveryItem(item, collected, seenUrls);
  }

  for (const url of eventBrief.sourceUrls || []) {
    collectDiscoveryItem({
      title: eventBrief.title,
      summary: eventBrief.whatHappened || eventBrief.whyItMatters || '',
      sourceUrls: [url],
      when: eventBrief.when || '',
      provider: eventBrief.provider || 'brief',
      detectedSectionId: eventBrief.section_id,
      detectedTopicId: eventBrief.topic_id,
      entities: eventBrief.entities,
      region: eventBrief.region,
      angle: eventBrief.angle,
      cluster_id: eventBrief.cluster_id,
      eventKey: eventBrief.eventKey,
    }, collected, seenUrls, true);
  }

  const normalized = collected
    .map((source) => normalizeSourceMaterial(source, { sourceId: source.id || source.source_id }))
    .filter(Boolean);

  const deduped = dedupeNormalizedSources(normalized);
  const initialRoleResults = classifyAgainstBrief(deduped, eventBrief, topicSignals);
  const initialPlacement = resolveRoleAwarePlacement(initialRoleResults, eventBrief);
  const effectiveBrief = initialPlacement.topic_id || initialPlacement.section_id
    ? {
        ...eventBrief,
        topic_id: initialPlacement.topic_id || eventBrief.topic_id || null,
        section_id: initialPlacement.section_id || eventBrief.section_id || null,
      }
    : eventBrief;
  const roleResults = classifyAgainstBrief(deduped, effectiveBrief, topicSignals);
  const finalPlacement = resolveRoleAwarePlacement(roleResults, effectiveBrief);
  const packTopicId = finalPlacement.topic_id || effectiveBrief.topic_id || eventBrief.topic_id || null;
  const packSectionId = finalPlacement.section_id || effectiveBrief.section_id || eventBrief.section_id || null;
  const resolvedBrief = {
    ...effectiveBrief,
    topic_id: packTopicId,
    section_id: packSectionId,
  };

  const finalizedPublishable = finalizePublishableSources(roleResults, resolvedBrief);
  const coreSources = finalizedPublishable.coreSources;
  const supportingSources = finalizedPublishable.supportingSources;
  const backgroundSources = limitSourcesPerDomain(roleResults.filter((result) => result.role === 'background').map((result) => result.source), 4, 2);
  const signalSources = limitSourcesPerDomain(roleResults.filter((result) => result.role === 'signal_only').map((result) => result.source), 4, 2);
  const excludedSources = roleResults.filter((result) => result.role === 'reject').map((result) => result.source);

  const sources = dedupeSourceList([...coreSources, ...supportingSources]);
  const uniqueDomains = countUniqueDomains(sources);
  const publishableRoleResults = getRoleResultsForSources(roleResults, sources);
  const directEventRoleResults = publishableRoleResults.filter((result) => isDirectEventRoleResult(result));
  const strongMatchCount = publishableRoleResults.filter((result) => ['core', 'supporting'].includes(result.role) && result.same_event_score >= 4).length;
  const primaryishCount = sources.filter((source) => source.isPrimary).length;
  const averageSourceScore = sources.length
    ? Math.round((sources.reduce((sum, source) => sum + (source.sourceQualityScore || 0), 0) / sources.length) * 10) / 10
    : 0;
  const sourceConsistencyScore = computeSourceConsistencyScore(sources, resolvedBrief);
  const gate = applySourcePackGate({
    eventBrief: resolvedBrief,
    sources,
    coreSources,
    supportingSources,
    backgroundSources,
    roleResults,
    publishableRoleResults,
    directEventRoleResults,
    uniqueDomains,
    strongMatchCount,
    sourceConsistencyScore,
    options,
  });

  return {
    eventId: eventBrief.id,
    topic: eventBrief.title,
    articleType: options.articleType || eventBrief.articleType || 'report',
    section_id: packSectionId,
    topic_id: packTopicId,
    sources,
    primarySources: coreSources,
    supportingSources,
    backgroundSources,
    signalSources,
    excludedSources,
    sourceRoleResults: roleResults,
    // Canonical public/article sources. Background sources remain internal only.
    publishReadySources: sources,
    publicSources: sources,
    canonicalPublicSources: sources,
    publishReadyNotes: finalizedPublishable.notes,
    uniqueDomains,
    credibilityScore: null,
    tierMix: {},
    passesGate: gate.passes,
    gateNotes: gate.notes,
    gateDecision: gate.passes ? 'PASS' : 'FAIL',
    placementConfidence: finalPlacement.confidence || 'low',
    placementReason: finalPlacement.reason || [],
    metrics: {
      totalSources: sources.length,
      uniqueDomains,
      relatedItemsConsidered: relatedItems.length,
      sourceUrlsSeeded: (eventBrief.sourceUrls || []).length,
      cleanCollectedCount: deduped.length,
      primaryishCount,
      averageSourceScore,
      strongMatchCount,
      sourceConsistencyScore,
      directEventSourceCount: directEventRoleResults.length,
      independentEventDomains: countUniqueDomains(directEventRoleResults.map((result) => result.source)),
      backgroundDomainCount: countUniqueDomains(backgroundSources),
      coreSourceCount: coreSources.length,
      supportingSourceCount: supportingSources.length,
      backgroundSourceCount: backgroundSources.length,
      signalSourceCount: signalSources.length,
      rejectedSourceCount: excludedSources.length,
      clusterArticleRichCount: Number(eventBrief.article_rich_count || eventBrief.articleRichCount || 0),
      clusterGenericSignalCount: Number(eventBrief.generic_page_count || eventBrief.genericPageCount || 0),
    },
    assembledAt: new Date().toISOString(),
  };
}

function collectDiscoveryItem(item, collected, seenUrls, forceKeep = false) {
  const url = item.sourceUrls?.[0] || item.url || item.link;
  const title = String(item.title || '').trim();
  const snippet = item.summary || item.description || item.snippet || '';

  if (!isValidHttpUrl(url)) return;

  const canonicalUrl = getCanonicalUrl(url);
  const canonicalDomain = getCanonicalDomain(url);

  if (!canonicalUrl || seenUrls.has(canonicalUrl)) return;
  if (!forceKeep && isObviousJunk(url, title, snippet)) return;

  seenUrls.add(canonicalUrl);
  collected.push({
    url,
    title: title || canonicalDomain || 'Source',
    summary: snippet,
    snippet,
    domain: canonicalDomain,
    canonicalDomain,
    canonicalUrl,
    tier: 'kept',
    credibility: null,
    isPrimary: false,
    publishedAt: item.when || item.published || item.age || item.discoveredAt || '',
    provider: item.provider || 'pool',
    section_id: item.detectedSectionId || item.section_id || null,
    topic_id: item.detectedTopicId || item.topic_id || null,
    cluster_id: item.cluster_id || item.clusterId || null,
    eventKey: item.eventKey || null,
    entities: item.entities || item.involvedParties || [],
    region: item.region || 'global',
    angle: item.angle || 'general',
    page_kind: item.page_kind || item.pageKind,
    genericity_score: item.genericity_score,
    article_likelihood: item.article_likelihood,
  });
}

function applySourcePackGate({ eventBrief, sources, coreSources, supportingSources, backgroundSources, roleResults, publishableRoleResults = [], directEventRoleResults = [], uniqueDomains, strongMatchCount, sourceConsistencyScore, options = {} }) {
  const notes = [];
  let passes = true;
  const articleType = String(eventBrief?.articleType || eventBrief?.article_type || 'report').toLowerCase();
  const crossTopicMismatchCount = publishableRoleResults.filter((result) => isHardCrossTopicMismatch(result, eventBrief)).length;
  const storyCoherenceScore = computePublishableStoryCoherence(eventBrief, publishableRoleResults);
  const publishableCount = coreSources.length + supportingSources.length;
  const singleSourceDecision = evaluateSingleSourceWhitelistEligibility({
    eventBrief,
    publishableSources: [...coreSources, ...supportingSources],
    articleType,
    storyCoherenceScore,
    crossTopicMismatchCount,
    sourceConsistencyScore,
    directEventSourceCount: directEventRoleResults.length,
    options,
  });

  if (coreSources.length < 1) {
    passes = false;
    notes.push(`Need at least 1 core source, found ${coreSources.length}`);
  }
  if (publishableCount < 2) {
    if (singleSourceDecision.pass) {
      notes.push(`Single-source whitelist exception passed (${singleSourceDecision.reason})`);
    } else {
      passes = false;
      notes.push(`Need at least 2 publishable sources, found ${publishableCount}`);
      if (singleSourceDecision.enabled && publishableCount === 1 && singleSourceDecision.reason) {
        notes.push(`Single-source whitelist rejected: ${singleSourceDecision.reason}`);
      }
    }
  }
  if (uniqueDomains < 2 && publishableCount >= 2) {
    passes = false;
    notes.push(`Need at least 2 different domains among publishable sources, found ${uniqueDomains}`);
  }
  const moderateMatchCount = publishableRoleResults.filter((result) => Number(result.same_event_score || 0) >= 3).length;
  const hasStrongEventPack = strongMatchCount >= 2 || (strongMatchCount >= 1 && moderateMatchCount >= 2);
  if (!hasStrongEventPack && sources.length >= 2) {
    passes = false;
    notes.push(`Need stronger same-event alignment among publishable sources, found ${strongMatchCount} strong / ${moderateMatchCount} moderate`);
  }
  if (crossTopicMismatchCount > 0) {
    passes = false;
    notes.push(`Publish-ready source pack has ${crossTopicMismatchCount} cross-topic mismatch source(s)`);
  }
  if (storyCoherenceScore < 0.45) {
    passes = false;
    notes.push(`Publish-ready source pack coherence too low (${storyCoherenceScore.toFixed(2)})`);
  }
  const directEventSourceCount = directEventRoleResults.length;
  const independentEventDomains = countUniqueDomains(directEventRoleResults.map((result) => result.source));
  if (articleType === 'report') {
    if (directEventSourceCount < 2) {
      passes = false;
      notes.push(`Need at least 2 direct-event sources for report, found ${directEventSourceCount}`);
    }
    if (independentEventDomains < 2 && directEventSourceCount >= 2) {
      passes = false;
      notes.push(`Need at least 2 independent direct-event domains for report, found ${independentEventDomains}`);
    }
  }
  if (sourceConsistencyScore < 3.5) {
    passes = false;
    notes.push(`Source consistency too weak (${sourceConsistencyScore})`);
  }
  const hasTrustedReporting = sources.some((source) => isTrustedReportingDomain(source?.canonical_domain || source?.domain));
  const hasOfficialPrimary = sources.some((source) => isOfficialPrimaryDomain(source?.canonical_domain || source?.domain));
  if (!hasTrustedReporting && !hasOfficialPrimary) {
    passes = false;
    notes.push('Need at least one trusted reporting source or official primary source');
  }

  const publishIntegrityIssues = [...coreSources, ...supportingSources].flatMap((source) => getPublishableIntegrityIssues(source));
  if (publishIntegrityIssues.length > 0) {
    passes = false;
    notes.push(`Publishable pack contains invalid evidence: ${Array.from(new Set(publishIntegrityIssues)).join(', ')}`);
  }

  if ((eventBrief.cluster_size || 1) >= 4 && publishableCount < 3) {
    notes.push('Large cluster retained extra materials as background/signal; publishable pack remains thin');
  }
  if (passes) notes.push('Role-aware one-event source-pack gate passed');

  return { passes, notes, directEventSourceCount, independentEventDomains };
}

function buildTopicSignals(eventBrief) {
  const raw = [eventBrief?.title, eventBrief?.whatHappened, eventBrief?.whyItMatters]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const signalTokens = raw
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !GENERIC_TOPIC_TOKENS.has(token));

  return Array.from(new Set(signalTokens)).slice(0, 12);
}

function countUniqueDomains(sources = []) {
  return new Set((sources || []).map((source) => source?.canonical_domain || source?.domain).filter(Boolean)).size;
}

function getRoleResultsForSources(roleResults = [], sources = []) {
  const finalUrlSet = new Set((sources || []).map((source) => source?.canonical_url || source?.url).filter(Boolean));
  return (roleResults || []).filter((result) => finalUrlSet.has(result?.source?.canonical_url || result?.source?.url));
}

function isDirectEventRoleResult(result) {
  if (!result || !['core', 'supporting'].includes(result.role)) return false;
  return Number(result.same_event_score || 0) >= 3;
}

function evaluateSingleSourceWhitelistEligibility({
  eventBrief = {},
  publishableSources = [],
  articleType = 'analysis',
  storyCoherenceScore = 0,
  crossTopicMismatchCount = 0,
  sourceConsistencyScore = 0,
  directEventSourceCount = 0,
  options = {},
} = {}) {
  const enabled = parseBooleanFlag(
    options.enableSingleSourceWhitelist
    ?? options.singleSourceWhitelist
    ?? process.env.QWEN_ENABLE_SINGLE_SOURCE_WHITELIST
  ) === true;

  if (!enabled) return { enabled: false, pass: false, reason: 'disabled' };
  if (!Array.isArray(publishableSources) || publishableSources.length !== 1) {
    return { enabled: true, pass: false, reason: 'publishable_count_not_one' };
  }
  if (String(articleType || '').toLowerCase() === 'report') {
    return { enabled: true, pass: false, reason: 'report_requires_multi_source' };
  }
  if (isHighRiskBrief(eventBrief)) {
    return { enabled: true, pass: false, reason: 'high_risk_topic_requires_multi_source' };
  }

  const source = publishableSources[0] || {};
  const sourceDomain = source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || '';
  if (!isStrictSingleSourceWhitelistDomain(sourceDomain)) {
    return { enabled: true, pass: false, reason: 'domain_not_in_strict_single_source_whitelist' };
  }
  if (!isTrustedReportingDomain(sourceDomain) && !isOfficialPrimaryDomain(sourceDomain)) {
    return { enabled: true, pass: false, reason: 'domain_not_trusted_or_official' };
  }
  if (getPublishableIntegrityIssues(source).length > 0) {
    return { enabled: true, pass: false, reason: 'source_integrity_not_publishable' };
  }
  if (crossTopicMismatchCount > 0) {
    return { enabled: true, pass: false, reason: 'cross_topic_mismatch_detected' };
  }
  if (directEventSourceCount < 1) {
    return { enabled: true, pass: false, reason: 'direct_event_signal_missing' };
  }

  const minSingleSourceCoherence = Number(
    options.singleSourceWhitelistMinCoherence
    ?? process.env.QWEN_SINGLE_SOURCE_WHITELIST_MIN_COHERENCE
    ?? 0.72
  );
  const minSingleSourceConsistency = Number(
    options.singleSourceWhitelistMinConsistency
    ?? process.env.QWEN_SINGLE_SOURCE_WHITELIST_MIN_CONSISTENCY
    ?? 6.0
  );

  if (Number.isFinite(minSingleSourceCoherence) && Number(storyCoherenceScore || 0) < minSingleSourceCoherence) {
    return { enabled: true, pass: false, reason: `coherence_below_threshold:${Number(storyCoherenceScore || 0).toFixed(2)}<${minSingleSourceCoherence}` };
  }
  if (Number.isFinite(minSingleSourceConsistency) && Number(sourceConsistencyScore || 0) < minSingleSourceConsistency) {
    return { enabled: true, pass: false, reason: `consistency_below_threshold:${Number(sourceConsistencyScore || 0).toFixed(2)}<${minSingleSourceConsistency}` };
  }

  return { enabled: true, pass: true, reason: 'strict_whitelist_single_source_ok' };
}

function isHighRiskBrief(brief = {}) {
  const highRiskTopicIds = new Set([
    'world-geopolitics',
    'us-politics',
    'law-crime',
    'climate-extreme-weather',
  ]);
  if (highRiskTopicIds.has(String(brief?.topic_id || '').toLowerCase())) return true;
  const text = `${brief?.title || ''} ${brief?.whatHappened || ''} ${brief?.whyItMatters || ''}`.toLowerCase();
  return /(killed|dead|deaths|war|attack|airstrike|hostage|terror|indicted|charged|sanction|lawsuit|verdict|court)/.test(text);
}

function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function containsAny(text, terms) {
  const lower = String(text || '').toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function isNonPublishableContainerKind(pageKind) {
  return ['homepage', 'section', 'topic', 'video', 'audio', 'live', 'roundup'].includes(String(pageKind || '').toLowerCase());
}

function getPublishableIntegrityIssues(source = {}) {
  const issues = [];
  const pageKind = String(source.page_kind || '').toLowerCase();
  const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();

  if (isNonPublishableContainerKind(pageKind)) issues.push(`non_publishable_kind:${pageKind}`);
  if (Number(source.genericity_score || 0) >= 7) issues.push('high_genericity');
  if ((pageKind === 'unknown' || pageKind === 'analysis' || pageKind === 'article' || pageKind === 'official_release') && Number(source.article_likelihood || 0) < 4) {
    issues.push('thin_article_signal');
  }
  if (source.title_url_mismatch) issues.push('title_url_mismatch');
  if (/(suggested search|browse all|see all results|latest updates?|watch live)/.test(text)) issues.push('generic_container_text');

  return issues;
}

function isStrictPublishableRoleResult(result = {}, brief = {}, options = {}) {
  const source = result.source || {};
  const requireStrongEvent = Boolean(options.requireStrongEvent);
  if (getPublishableIntegrityIssues(source).length > 0) return false;
  if (requireStrongEvent && Number(result.same_event_score || 0) < 4) return false;
  if (!requireStrongEvent && Number(result.same_event_score || 0) < 3) return false;
  if (brief.topic_id && source.topic_id && brief.topic_id !== source.topic_id && Number(result.same_event_score || 0) < 6) return false;
  if (brief.section_id && source.section_id && brief.section_id !== source.section_id && Number(result.same_event_score || 0) < 4) return false;
  if (!hasBriefTitleAnchor(source, brief) && Number(result.same_event_score || 0) < 5) return false;
  if (isHardCrossTopicMismatch(result, brief)) return false;
  return true;
}

function scoreSourceForBrief(source, topicSignals, eventBrief) {
  const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
  const url = String(source.url || '').toLowerCase();
  let score = 0;

  for (const token of topicSignals) {
    if (text.includes(token)) score += 2.5;
    if (url.includes(token)) score += 1;
  }

  const briefEntities = new Set((eventBrief.entities || []).map((entity) => String(entity || '').toLowerCase()));
  const sourceEntities = Array.isArray(source.entities) ? source.entities : [];
  for (const entity of sourceEntities) {
    if (briefEntities.has(String(entity || '').toLowerCase())) score += 2;
  }

  if (eventBrief.topic_id && source.topic_id && eventBrief.topic_id === source.topic_id) score += 3;
  if (eventBrief.section_id && source.section_id && eventBrief.section_id === source.section_id) score += 1.5;
  if (eventBrief.region && source.region && eventBrief.region === source.region) score += 1;
  if (eventBrief.angle && source.angle && eventBrief.angle === source.angle) score += 1;
  if (eventBrief.cluster_id && source.cluster_id && eventBrief.cluster_id === source.cluster_id) score += 4;
  if (eventBrief.eventKey && source.event_key && eventBrief.eventKey === source.event_key) score += 4;

  if (detectPrimaryishSource(source)) score += 3;
  if (source.provider === 'brief') score += 2;
  if ((source.article_likelihood || 0) >= 6) score += 2;
  if (source.page_kind === 'article' || source.page_kind === 'analysis') score += 2;
  if (source.page_kind === 'official_release') score += 2;
  if (source.page_kind === 'live' || source.page_kind === 'roundup') score -= 1;
  if (source.page_kind === 'homepage' || source.page_kind === 'section' || source.page_kind === 'topic') score -= 5;

  return Math.round(score * 10) / 10;
}


function classifyAgainstBrief(dedupedSources, brief, topicSignals) {
  return dedupedSources
    .map((source) => {
      const enriched = {
        ...source,
        sourceQualityScore: scoreSourceForBrief(source, topicSignals, brief),
        isPrimary: detectPrimaryishSource(source),
        sourceRoleHint: detectPrimaryishSource(source) ? 'primaryish' : 'secondary',
      };
      return classifySourceRole(enriched, brief);
    })
    .sort(compareRoleResults);
}

function resolveRoleAwarePlacement(roleResults = [], eventBrief = {}) {
  const registry = loadTaxonomyRegistry();
  const textSignals = [
    eventBrief.title,
    eventBrief.whatHappened,
    eventBrief.whyItMatters,
    ...roleResults.filter((result) => ['core', 'supporting'].includes(result.role)).slice(0, 4).map((result) => result.source?.title || ''),
  ].filter(Boolean).join(' ');
  const hint = matchTaxonomyHints(textSignals);

  const publishable = roleResults.filter((result) => ['core', 'supporting'].includes(result.role) && (result.source?.article_likelihood || 0) >= 4);
  const candidates = publishable.length ? publishable : roleResults.filter((result) => result.role !== 'reject');
  if (!candidates.length) {
    return {
      topic_id: eventBrief.topic_id || hint.detectedTopicId || null,
      section_id: eventBrief.section_id || hint.detectedSectionId || null,
      confidence: 'low',
      reason: ['fallback_existing_brief'],
    };
  }

  const topicScores = new Map();
  const sectionScores = new Map();
  for (const result of candidates) {
    const source = result.source || {};
    const roleWeight = result.role === 'core' ? 6 : result.role === 'supporting' ? 4 : result.role === 'background' ? 2 : 1;
    const weight = roleWeight
      + Number(source.article_likelihood || 0) * 0.6
      + Number(source.sourceQualityScore || source.source_quality_score || 0) * 0.08
      - Number(source.genericity_score || 0) * 0.25
      + (source.page_kind === 'article' || source.page_kind === 'analysis' || source.page_kind === 'official_release' ? 1.25 : 0);

    const topicId = source.topic_id || null;
    const sectionId = source.section_id || (topicId ? registry.sectionByTopic?.[topicId] : null) || null;
    if (topicId) topicScores.set(topicId, (topicScores.get(topicId) || 0) + weight);
    if (sectionId) sectionScores.set(sectionId, (sectionScores.get(sectionId) || 0) + weight);
  }

  if (hint.detectedTopicId) topicScores.set(hint.detectedTopicId, (topicScores.get(hint.detectedTopicId) || 0) + 3.5);
  if (hint.detectedSectionId) sectionScores.set(hint.detectedSectionId, (sectionScores.get(hint.detectedSectionId) || 0) + 1.5);

  const publishableTitles = candidates.map((result) => result.source?.title || '').join(' ').toLowerCase();
  const fullPlacementText = `${eventBrief.title || ''} ${eventBrief.whatHappened || ''} ${eventBrief.whyItMatters || ''} ${publishableTitles}`.toLowerCase();
  const hasTravelSignals = containsAny(fullPlacementText, [
    'tsa', 'airport', 'airports', 'flight', 'flights', 'airline', 'airlines',
    'travel delay', 'travel delays', 'security line', 'wait time', 'wait times',
    'terminal', 'shutdown'
  ]);
  const hasGeoSignals = containsAny(fullPlacementText, [
    'war', 'ceasefire', 'missile', 'troops', 'military', 'foreign minister',
    'sanctions', 'diplomacy', 'ukraine', 'russia', 'gaza', 'israel', 'iran'
  ]);

  if ((eventBrief.topic_id === 'world-geopolitics' || hint.detectedTopicId === 'world-geopolitics') && hasTravelSignals && !hasGeoSignals) {
    topicScores.set('travel-consumer-issues', (topicScores.get('travel-consumer-issues') || 0) + 100);
  }

  const rankedTopics = Array.from(topicScores.entries()).sort((a, b) => b[1] - a[1]);
  const rankedSections = Array.from(sectionScores.entries()).sort((a, b) => b[1] - a[1]);
  const [topTopicId, topTopicScore = 0] = rankedTopics[0] || [];
  const secondTopicScore = rankedTopics[1]?.[1] || 0;
  const [topSectionId, topSectionScore = 0] = rankedSections[0] || [];
  const secondSectionScore = rankedSections[1]?.[1] || 0;

  let topic_id = eventBrief.topic_id || null;
  let section_id = eventBrief.section_id || null;
  const reason = [];

  if (topTopicId && topTopicScore >= 6 && (secondTopicScore === 0 || topTopicScore >= secondTopicScore * 1.35)) {
    topic_id = topTopicId;
    section_id = registry.sectionByTopic?.[topic_id] || topSectionId || section_id;
    reason.push('dominant_publishable_topic');
  } else if (eventBrief.topic_id) {
    topic_id = eventBrief.topic_id;
    section_id = registry.sectionByTopic?.[topic_id] || section_id;
    reason.push('kept_existing_topic');
  } else if (hint.detectedTopicId) {
    topic_id = hint.detectedTopicId;
    section_id = registry.sectionByTopic?.[topic_id] || hint.detectedSectionId || section_id;
    reason.push('taxonomy_text_hint');
  }

  if (!section_id && topSectionId && topSectionScore >= 4) {
    section_id = topSectionId;
    reason.push('dominant_publishable_section');
  }

  const confidence = topic_id && topTopicId === topic_id && topTopicScore >= Math.max(6, secondTopicScore * 1.35)
    ? 'high'
    : section_id && topSectionId === section_id && topSectionScore >= Math.max(4, secondSectionScore * 1.25)
      ? 'medium'
      : 'low';

  return { topic_id: topic_id || null, section_id: section_id || null, confidence, reason, rankedTopics, rankedSections };
}

function computeSourceConsistencyScore(sources, eventBrief) {
  if (!Array.isArray(sources) || sources.length === 0) return 0;
  const topicMatches = sources.filter((source) => !eventBrief.topic_id || source.topic_id === eventBrief.topic_id).length;
  const regionMatches = sources.filter((source) => !eventBrief.region || source.region === eventBrief.region).length;
  const angleMatches = sources.filter((source) => !eventBrief.angle || source.angle === eventBrief.angle).length;
  const cleanEvidenceCount = sources.filter((source) => getPublishableIntegrityIssues(source).length === 0).length;
  const average = (topicMatches + regionMatches + angleMatches + cleanEvidenceCount) / (sources.length * 4);
  return Math.round(average * 100) / 10;
}

function detectPrimaryishSource(source) {
  const domain = String(source.canonical_domain || source.canonicalDomain || '').toLowerCase();
  const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
  const url = String(source.url || '').toLowerCase();

  if (/\.(gov|mil)$/.test(domain)) return true;
  if (/(supremecourt|uscourts|courtlistener|sec\.gov|justice\.gov|whitehouse\.gov|congress\.gov|europa\.eu)/.test(domain)) return true;
  if (PRIMARYISH_TITLE_HINTS.some((hint) => text.includes(hint))) return true;
  if (/(\/press-release\/|\/press\/|\/releases\/|\/media\/|\/statement\/|\/orders?\/|\/filings?\/)/.test(url)) return true;
  return false;
}

function dedupeNormalizedSources(sources = []) {
  const byKey = new Map();
  for (const source of sources) {
    const key = `${source.canonical_url}|${source.normalized_title}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, source);
      continue;
    }
    const existingScore = (existing.sourceQualityScore || 0) + (existing.article_likelihood || 0) - (existing.genericity_score || 0);
    const nextScore = (source.sourceQualityScore || 0) + (source.article_likelihood || 0) - (source.genericity_score || 0);
    if (nextScore > existingScore) byKey.set(key, source);
  }
  return Array.from(byKey.values());
}

function compareRoleResults(a, b) {
  const roleWeight = { core: 5, supporting: 4, background: 3, signal_only: 2, reject: 1 };
  const roleDiff = (roleWeight[b.role] || 0) - (roleWeight[a.role] || 0);
  if (roleDiff !== 0) return roleDiff;
  const eventDiff = (b.same_event_score || 0) - (a.same_event_score || 0);
  if (eventDiff !== 0) return eventDiff;
  return (b.source?.sourceQualityScore || 0) - (a.source?.sourceQualityScore || 0);
}

function finalizePublishableSources(roleResults = [], brief = {}) {
  const keepable = roleResults.filter((result) => ['core', 'supporting'].includes(result.role));
  const directEventKeepable = keepable.filter((result) => isDirectEventRoleResult(result));
  const strictDirectEventKeepable = directEventKeepable.filter((result) => isStrictPublishableRoleResult(result, brief, { requireStrongEvent: true }));
  const safeDirectEventKeepable = directEventKeepable.filter((result) => isStrictPublishableRoleResult(result, brief));
  const safeKeepable = keepable.filter((result) => isStrictPublishableRoleResult(result, brief));

  const ranked = strictDirectEventKeepable
    .map((result) => ({
      result,
      score: scorePublishableRoleResult(result, brief),
    }))
    .sort((a, b) => b.score - a.score);

  const notes = [];
  const strong = [];
  const seenTitleDomain = new Set();
  const seenCanonicalUrls = new Set();
  const seenDomains = new Map();

  for (const item of ranked) {
    const source = item.result.source || {};
    const titleKey = `${source.canonical_domain || ''}|${source.normalized_title || String(source.title || '').toLowerCase()}`;
    const canonicalUrl = source.canonical_url || source.url;
    if (seenTitleDomain.has(titleKey) || seenCanonicalUrls.has(canonicalUrl)) continue;
    const domainCount = seenDomains.get(source.canonical_domain || '') || 0;
    if (domainCount >= 2) continue;
    strong.push(source);
    seenTitleDomain.add(titleKey);
    seenCanonicalUrls.add(canonicalUrl);
    seenDomains.set(source.canonical_domain || '', domainCount + 1);
    if (strong.length >= 4) break;
  }

  const alignedFallback = limitSourcesPerDomain(
    dedupeSourceList(safeDirectEventKeepable.map((item) => item.source)),
    4,
    2
  );
  const finalSources = dedupeSourceList(
    strong.length >= 2
      ? strong
      : alignedFallback
  );
  const coreSources = [];
  const supportingSources = [];
  const seenRoleUrls = new Set();
  const finalUrlSet = new Set(finalSources.map((source) => source.canonical_url || source.url));
  for (const result of safeKeepable) {
    const source = result.source || {};
    const key = source.canonical_url || source.url;
    if (!finalUrlSet.has(key) || seenRoleUrls.has(key)) continue;
    if (result.role === 'core' && coreSources.length < 3) {
      coreSources.push(source);
      seenRoleUrls.add(key);
    } else if (supportingSources.length < 3) {
      supportingSources.push(source);
      seenRoleUrls.add(key);
    }
  }

  if (coreSources.length === 0 && finalSources.length > 0) {
    coreSources.push(finalSources[0]);
    seenRoleUrls.add(finalSources[0].canonical_url || finalSources[0].url);
  }
  for (const source of finalSources) {
    const key = source.canonical_url || source.url;
    if (seenRoleUrls.has(key)) continue;
    if (supportingSources.length < 3) {
      supportingSources.push(source);
      seenRoleUrls.add(key);
    }
  }

  if (strong.length === 0 && safeDirectEventKeepable.length !== directEventKeepable.length) {
    notes.push('Dropped weak direct-event evidence during strict publishable filtering');
  }
  if (finalSources.length < 2) {
    notes.push('Publishable evidence remained thin after strict one-story filtering');
  }
  if (finalSources.length > 0 && finalSources.some((source) => source.title_url_mismatch)) {
    notes.push('Dropped title/url mismatches from publishable evidence');
  }

  return { coreSources, supportingSources, notes };
}

function scorePublishableRoleResult(result, brief = {}) {
  const source = result.source || {};
  const sameEvent = Number(result.same_event_score || 0);
  const topicFit = Number(result.topic_fit_score || 0);
  const quality = Number(source.sourceQualityScore || source.source_quality_score || 0);
  const articleLike = Number(source.article_likelihood || 0);
  const genericity = Number(source.genericity_score || 0);
  const roleBoost = result.role === 'core' ? 5 : 3;
  const officialBoost = source.page_kind === 'official_release' ? 1.5 : 0;
  const topicPenalty = brief.topic_id && source.topic_id && brief.topic_id !== source.topic_id ? 2.5 : 0;
  const sectionPenalty = brief.section_id && source.section_id && brief.section_id !== source.section_id ? 1.5 : 0;
  return roleBoost + sameEvent * 1.5 + topicFit * 1.1 + quality * 0.12 + articleLike * 0.5 + officialBoost - genericity * 0.5 - topicPenalty - sectionPenalty;
}


function dedupeSourceList(sources = []) {
  const seen = new Set();
  const deduped = [];
  for (const source of sources) {
    const key = source?.canonical_url || source?.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

function limitSourcesPerDomain(sources, maxTotal = 5, maxPerDomain = 2, preferredDomains = null) {
  const perDomain = new Map();
  const kept = [];
  const preferred = preferredDomains instanceof Set ? preferredDomains : new Set();

  const sorted = [...sources].sort((a, b) => {
    const aPref = preferred.has(a.canonical_domain) ? 1 : 0;
    const bPref = preferred.has(b.canonical_domain) ? 1 : 0;
    if (aPref !== bPref) return aPref - bPref;
    return (b.sourceQualityScore || 0) - (a.sourceQualityScore || 0);
  });

  for (const source of sorted) {
    const domainKey = source.canonical_domain;
    const count = perDomain.get(domainKey) || 0;
    if (count >= maxPerDomain) continue;
    kept.push(source);
    perDomain.set(domainKey, count + 1);
    if (kept.length >= maxTotal) break;
  }
  return kept;
}

function isObviousJunk(url, title, snippet) {
  const text = `${title} ${snippet}`.toLowerCase();
  const lowerUrl = String(url || '').toLowerCase();
  const junkPhrases = ['apple podcasts', 'spotify', 'youtube', 'photo gallery', 'suggested search', 'browse all', 'see all results'];
  if (junkPhrases.some((phrase) => text.includes(phrase))) return true;
  if (/(\/podcasts?\/|\/audio\/|\/video\/|\/videos\/)/.test(lowerUrl)) return true;
  return false;
}

function getCanonicalDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function getCanonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

function isValidHttpUrl(url) {
  if (!url) return false;
  const normalized = String(url).trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function rankPublishableCandidates(candidates) {
  const publishable = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.sourcePack?.passesGate);
  if (publishable.length === 0) return [];
  const coverageContext = buildCoverageContext(loadNewsPool().items || []);
  return publishable
    .map((candidate) => ({
      candidate,
      scoreInfo: scoreCandidateWithSourcePack(candidate, coverageContext),
    }))
    .sort((left, right) => {
      if (right.scoreInfo.score !== left.scoreInfo.score) return right.scoreInfo.score - left.scoreInfo.score;
      const coreDiff = (right.candidate.sourcePack.metrics?.coreSourceCount || 0) - (left.candidate.sourcePack.metrics?.coreSourceCount || 0);
      if (coreDiff !== 0) return coreDiff;
      const domainDiff = (right.candidate.sourcePack.uniqueDomains || 0) - (left.candidate.sourcePack.uniqueDomains || 0);
      if (domainDiff !== 0) return domainDiff;
      return (right.candidate.sourcePack.sources?.length || 0) - (left.candidate.sourcePack.sources?.length || 0);
    });
}

function getCandidateClusterKey(candidate) {
  return candidate?.brief?.cluster_id || candidate?.brief?.clusterId || candidate?.brief?.eventKey || candidate?.sourcePack?.eventId || null;
}

function tokenizeStorySignal(value) {
  return String(value || '')
    .match(/[A-Za-z0-9]+/g) || [];
}

function normalizeStoryToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  const lower = token.toLowerCase();
  if (GENERIC_TOPIC_TOKENS.has(lower)) return null;
  if (lower.length >= 4) return lower;
  if (token.length >= 2 && token.length <= 4 && token === token.toUpperCase() && /[A-Z]/.test(token)) return lower;
  return null;
}

function getCandidateTitleTokens(candidate) {
  const rawTokens = tokenizeStorySignal(candidate?.brief?.title || candidate?.sourcePack?.topic || '');
  return Array.from(new Set(
    rawTokens
      .map((token) => normalizeStoryToken(token))
      .filter(Boolean)
  ));
}

function countTokenOverlap(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function titlesLookLikeDuplicate(left = [], right = []) {
  if (!left.length || !right.length) return false;
  const overlap = countTokenOverlap(left, right);
  const shortest = Math.max(1, Math.min(left.length, right.length));
  return overlap >= 3 && (overlap / shortest) >= 0.45;
}

function getCandidateSourceUrlSet(candidate) {
  return new Set(
    (Array.isArray(candidate?.sourcePack?.sources) ? candidate.sourcePack.sources : [])
      .map((source) => source?.canonicalUrl || source?.canonical_url || source?.url || '')
      .map((url) => getCanonicalUrl(url))
      .filter(Boolean)
  );
}

function getCandidateSourceDomainSet(candidate) {
  return new Set(
    (Array.isArray(candidate?.sourcePack?.sources) ? candidate.sourcePack.sources : [])
      .map((source) => source?.domain || normalizeDomain(source?.canonicalUrl || source?.canonical_url || source?.url || ''))
      .filter(Boolean)
  );
}

function getCandidateEntityTokens(candidate) {
  const entityValues = [
    ...(Array.isArray(candidate?.brief?.entities) ? candidate.brief.entities : []),
    ...(Array.isArray(candidate?.sourcePack?.sources) ? candidate.sourcePack.sources.flatMap((source) => Array.isArray(source?.entities) ? source.entities : []) : []),
  ];

  return Array.from(new Set(
    entityValues
      .flatMap((value) => tokenizeStorySignal(value))
      .map((token) => normalizeStoryToken(token))
      .filter(Boolean)
  )).slice(0, 10);
}

function entitySetsLookLikeDuplicate(left = [], right = []) {
  if (!left.length || !right.length) return false;
  const overlap = countTokenOverlap(left, right);
  const shortest = Math.max(1, Math.min(left.length, right.length));
  return overlap >= 2 || (overlap >= 1 && (overlap / shortest) >= 0.6);
}

function countSetOverlap(leftSet, rightSet) {
  if (!(leftSet instanceof Set) || !(rightSet instanceof Set) || leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) overlap += 1;
  }
  return overlap;
}

function domainSetsLookLikeDuplicate(leftSet, rightSet, { allowSingleOverlap = false } = {}) {
  const overlap = countSetOverlap(leftSet, rightSet);
  return overlap >= 2 || (allowSingleOverlap && overlap >= 1);
}

function buildCandidateStorylineFingerprint(candidate) {
  return {
    clusterKey: getCandidateClusterKey(candidate),
    titleTokens: getCandidateTitleTokens(candidate),
    sourceUrlSet: getCandidateSourceUrlSet(candidate),
    sourceDomainSet: getCandidateSourceDomainSet(candidate),
    entityTokens: getCandidateEntityTokens(candidate),
  };
}

function storylinesLookLikeDuplicate(left, right) {
  if (!left || !right) return false;
  if (left.clusterKey && right.clusterKey && left.clusterKey === right.clusterKey) return true;
  if (sourceSetsLookLikeDuplicate(left.sourceUrlSet, right.sourceUrlSet)) return true;

  const titleDuplicate = titlesLookLikeDuplicate(left.titleTokens, right.titleTokens);
  const entityDuplicate = entitySetsLookLikeDuplicate(left.entityTokens, right.entityTokens);
  const domainOverlap = countSetOverlap(left.sourceDomainSet, right.sourceDomainSet);
  const domainDuplicate = domainSetsLookLikeDuplicate(left.sourceDomainSet, right.sourceDomainSet, { allowSingleOverlap: titleDuplicate || entityDuplicate });

  if (titleDuplicate && (entityDuplicate || domainOverlap >= 1)) return true;
  if (entityDuplicate && domainOverlap >= 1) return true;

  let signals = 0;
  if (titleDuplicate) signals += 1;
  if (entityDuplicate) signals += 1;
  if (domainDuplicate) signals += 1;

  return signals >= 2;
}

function sourceSetsLookLikeDuplicate(leftSet, rightSet) {
  if (!(leftSet instanceof Set) || !(rightSet instanceof Set) || leftSet.size === 0 || rightSet.size === 0) return false;
  let overlap = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) overlap += 1;
  }
  const shortest = Math.max(1, Math.min(leftSet.size, rightSet.size));
  return overlap >= 2 || (overlap >= 1 && (overlap / shortest) >= 0.6);
}

function titleTokensForCoherence(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !GENERIC_TOPIC_TOKENS.has(token))
  );
}

function hasBriefTitleAnchor(source = {}, brief = {}) {
  const briefTokens = titleTokensForCoherence(brief?.title || '');
  const sourceTokens = titleTokensForCoherence(source?.title || '');
  if (briefTokens.size === 0 || sourceTokens.size === 0) return false;
  let overlap = 0;
  for (const token of sourceTokens) {
    if (briefTokens.has(token)) overlap += 1;
  }
  return overlap >= 2 || (overlap >= 1 && sourceTokens.size <= 4);
}

function isHardCrossTopicMismatch(result = {}, brief = {}) {
  const source = result?.source || {};
  const briefTopic = String(brief?.topic_id || '').trim();
  const sourceTopic = String(source?.topic_id || '').trim();
  if (!briefTopic || !sourceTopic || briefTopic === sourceTopic) return false;
  return Number(result?.same_event_score || 0) < 6 && !hasBriefTitleAnchor(source, brief);
}

function computePublishableStoryCoherence(brief = {}, publishableRoleResults = []) {
  const briefTokens = titleTokensForCoherence(brief?.title || '');
  if (briefTokens.size === 0) return 1;
  if (!Array.isArray(publishableRoleResults) || publishableRoleResults.length === 0) return 0;

  const scores = publishableRoleResults.map((result) => {
    const sourceTokens = titleTokensForCoherence(result?.source?.title || '');
    if (sourceTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of sourceTokens) {
      if (briefTokens.has(token)) overlap += 1;
    }
    return overlap / Math.max(briefTokens.size, sourceTokens.size, 1);
  });

  const avg = scores.reduce((sum, value) => sum + value, 0) / Math.max(scores.length, 1);
  return Math.round(avg * 100) / 100;
}

function buildSelectionSeed(entries = []) {
  const sectionCounts = new Map();
  const topicCounts = new Map();
  const seenStorylines = [];

  for (const entry of entries) {
    const candidate = entry?.candidate;
    if (!candidate) continue;
    const sectionId = candidate?.sourcePack?.section_id || candidate?.brief?.section_id || 'unassigned';
    const topicId = candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || 'unassigned';
    seenStorylines.push(buildCandidateStorylineFingerprint(candidate));
    sectionCounts.set(sectionId, (sectionCounts.get(sectionId) || 0) + 1);
    topicCounts.set(topicId, (topicCounts.get(topicId) || 0) + 1);
  }

  return { sectionCounts, topicCounts, seenStorylines };
}

function selectGreedyCandidates(rankedEntries, limit, constraints, seed = null) {
  const sectionCounts = seed?.sectionCounts ? new Map(seed.sectionCounts) : new Map();
  const topicCounts = seed?.topicCounts ? new Map(seed.topicCounts) : new Map();
  const selected = [];
  const seenStorylines = seed?.seenStorylines ? [...seed.seenStorylines] : [];

  for (const entry of rankedEntries) {
    if (selected.length >= limit) break;
    const candidate = entry.candidate;
    const sectionId = candidate?.sourcePack?.section_id || candidate?.brief?.section_id || 'unassigned';
    const topicId = candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || 'unassigned';
    const storyline = buildCandidateStorylineFingerprint(candidate);

    if (seenStorylines.some((existing) => storylinesLookLikeDuplicate(existing, storyline))) continue;
    if ((sectionCounts.get(sectionId) || 0) >= constraints.maxPerSection) continue;
    if ((topicCounts.get(topicId) || 0) >= constraints.maxPerTopic) continue;

    selected.push(entry);
    seenStorylines.push(storyline);
    sectionCounts.set(sectionId, (sectionCounts.get(sectionId) || 0) + 1);
    topicCounts.set(topicId, (topicCounts.get(topicId) || 0) + 1);
  }

  return selected;
}

export function selectPublishableCandidates(candidates, options = {}) {
  const rankedEntries = rankPublishableCandidates(candidates);
  if (rankedEntries.length === 0) return [];

  const requestedLimit = Number(options.maxArticlesPerRun || options.limit || 1);
  const limit = Math.max(1, Math.min(5, Number.isFinite(requestedLimit) ? requestedLimit : 1));
  if (limit === 1) return [rankedEntries[0].candidate];

  const strict = selectGreedyCandidates(rankedEntries, limit, {
    maxPerSection: Number(options.maxPerSection || 2),
    maxPerTopic: Number(options.maxPerTopic || 2),
  });

  if (strict.length >= limit) {
    return strict.map((entry) => entry.candidate);
  }

  const alreadySelected = new Set(strict.map((entry) => entry.candidate));
  const remaining = rankedEntries.filter((entry) => !alreadySelected.has(entry.candidate));
  const relaxed = selectGreedyCandidates(remaining, limit - strict.length, {
    maxPerSection: Number(options.relaxedMaxPerSection || 3),
    maxPerTopic: Number(options.relaxedMaxPerTopic || 3),
  }, buildSelectionSeed(strict));

  return [...strict, ...relaxed].map((entry) => entry.candidate).slice(0, limit);
}

export function selectPublishableCandidate(candidates) {
  return selectPublishableCandidates(candidates, { maxArticlesPerRun: 1 })[0] || null;
}
