// File: qwen-scripts/pre-writer-engine.js
// Purpose: Shared pre-writer engine for discovery intake, source-pack viability/rescue, entity normalization, event coherence, and final candidate selection.

import fs from 'node:fs';
import path from 'node:path';

import { runDiscovery } from './discovery.js';
import { normalizeClusteredBrief } from './event-brief-builder.js';
import { clusterDiscoveredCandidates } from './nodes/event-clustering-node.js';
import { assembleSourcePack, selectPublishableCandidates } from './source-pack.js';
import { evaluateSourcePackEditorialIntegrity } from './validate-publish-graph.js';
import { mergeDiscoveredNews, mergeBriefsIntoPool, getSelectableBriefs, getReadySelectableBriefs, dedupeBriefCandidates } from './utils/news-pool.js';
import { braveNewsSearch, gdeltSearch, googleSearch } from './utils/api-clients.js';
import { normalizeSourceMaterial } from './utils/source-normalization.js';
import { classifySourceRole } from './nodes/source-role-node.js';
import {
  OFFICIAL_CONTEXT_DOMAINS,
  OFFICIAL_PRIMARY_DOMAINS,
  isOfficialPrimaryDomain,
  isTrustedReportingDomain,
  normalizeDomain,
} from './config/trusted-publishers.js';

const ARTICLE_INVENTORY_PATH = path.resolve(process.cwd(), 'qwen-project-governance', 'article_inventory.md');
const RECENT_DUPLICATE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
const RESCUE_QUERY_DEDUPE_TTL_MS = Math.max(60_000, Number(process.env.QWEN_RESCUE_QUERY_DEDUPE_TTL_MS || 20 * 60 * 1000));
const RECENT_RESCUE_QUERY_USAGE = new Map();

export function loadSharedBriefCandidatesFromPool(limit, { leaseOwner = null } = {}) {
  return loadSharedBriefCandidatesFromPoolInternal(limit, { leaseOwner });
}

export async function runPreWriterDiscoveryIntake({ braveApiKey, googleApiKey, googleCx, openAiApiKey, candidateLimit, leaseOwner = null, options = {} } = {}) {
  return runPreWriterDiscoveryIntakeInternal({
    braveApiKey,
    googleApiKey,
    googleCx,
    openAiApiKey,
    candidateLimit,
    leaseOwner,
    options,
  });
}

export async function normalizeDiscoveryCandidatesToBriefs(candidates = [], options = {}, openAiApiKey = null) {
  const normalizedBriefs = [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { briefs: normalizedBriefs, clusterCount: 0 };
  }

  const eventClusters = clusterDiscoveredCandidates(candidates, { threshold: options.clusterThreshold || 6 });
  const topClusters = eventClusters.slice(0, options.clusterSelectionLimit || 6);

  for (const cluster of topClusters) {
    try {
      const normalized = await normalizeClusteredBrief(cluster, openAiApiKey);
      normalized.discoveryContext = cluster.candidates || [];
      normalized.cluster_size = cluster.candidateCount;
      normalizedBriefs.push(normalized);
    } catch (error) {
      console.error(`[pre-writer] Brief normalization failed: ${error.message}`);
    }
  }

  return { briefs: normalizedBriefs, clusterCount: eventClusters.length };
}

export async function runSharedSourcePackEngine({
  briefs = [],
  options = {},
  braveApiKey,
  googleApiKey,
  googleCx,
  maxSelectionCount = 3,
  selectionLimits = {},
  applyDuplicateGuard = true,
} = {}) {
  const screened = await screenBriefSourcePackViability(briefs, {
    options,
    braveApiKey,
    googleApiKey,
    googleCx,
  });

  const candidatesWithSources = (Array.isArray(screened.viableBriefs) ? screened.viableBriefs : []).map((brief) => {
    const briefKey = getBriefCandidateKey(brief);
    return {
      brief,
      sourcePack: screened.sourcePackByKey.get(briefKey) || null,
    };
  }).filter((candidate) => candidate?.sourcePack);

  let duplicateRejectedAtSelection = [];
  let candidatesAfterDuplicateGuard = candidatesWithSources;

  if (applyDuplicateGuard) {
    const duplicateFilter = filterRecentDuplicateCandidates(candidatesWithSources);
    candidatesAfterDuplicateGuard = Array.isArray(duplicateFilter.candidates) ? duplicateFilter.candidates : [];
    duplicateRejectedAtSelection = Array.isArray(duplicateFilter.rejected) ? duplicateFilter.rejected : [];
  }

  const selectedCandidates = selectSharedPreWriterCandidates(candidatesAfterDuplicateGuard, {
    maxSelectionCount,
    selectionLimits,
  });

  return {
    attempted: Number(screened.attempted || 0),
    sourcePacksAssembled: Number(screened.attempted || 0),
    viableBriefs: screened.viableBriefs || [],
    sourcePackByKey: screened.sourcePackByKey || new Map(),
    rejections: screened.rejections || [],
    rescue: screened.rescue || null,
    candidatesWithSources,
    candidatesAfterDuplicateGuard,
    duplicateRejectedAtSelection,
    publishableCandidates: candidatesAfterDuplicateGuard.filter((candidate) => candidate?.sourcePack?.passesGate).length,
    selectedCandidates,
  };
}

export function selectSharedPreWriterCandidates(candidates = [], { maxSelectionCount = 3, selectionLimits = {} } = {}) {
  const maxPerSection = Number(selectionLimits.maxPerSection ?? 2);
  const maxPerTopic = Number(selectionLimits.maxPerTopic ?? 2);
  const relaxedMaxPerSection = Number(selectionLimits.relaxedMaxPerSection ?? 3);
  const relaxedMaxPerTopic = Number(selectionLimits.relaxedMaxPerTopic ?? 3);

  return selectPublishableCandidates(Array.isArray(candidates) ? candidates : [], {
    maxArticlesPerRun: Math.max(1, Number(maxSelectionCount || 1)),
    maxPerSection,
    maxPerTopic,
    relaxedMaxPerSection,
    relaxedMaxPerTopic,
  });
}

export function applyRecentInventoryDuplicateGuard(candidates = []) {
  return filterRecentDuplicateCandidates(candidates);
}

export async function screenSharedBriefViabilityForTesting(briefs = [], options = {}) {
  const braveApiKey = options.braveApiKey || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const googleApiKey = options.googleApiKey || process.env.SEARCH_WEB_API;
  const googleCx = options.googleCx || process.env.SEARCH_WEB_CX;
  return screenBriefViabilityForTestingInternal(briefs, {
    ...options,
    braveApiKey,
    googleApiKey,
    googleCx,
  });
}

export { getBriefCandidateKey, mergeRescueDiagnostics, estimateSourcePackCoherence };

function loadSharedBriefCandidatesFromPoolInternal(limit, { leaseOwner = null } = {}) {
  const wideLimit = Math.max(limit * 3, 24);
  const readyBriefs = getReadySelectableBriefs({ limit: wideLimit, includeSelected: false, leaseOwner });
  const poolBriefs = getSelectableBriefs({ limit: wideLimit, prioritizeReady: true, readyBoost: 8, leaseOwner });
  const merged = dedupeBriefCandidates([...readyBriefs, ...poolBriefs])
    .filter(isLikelyViableBrief)
    .sort((left, right) => Number(right.selectionScore || 0) - Number(left.selectionScore || 0));
  return merged.slice(0, Math.max(limit, 12));
}

async function runPreWriterDiscoveryIntakeInternal({ braveApiKey, googleApiKey, googleCx, openAiApiKey, candidateLimit, leaseOwner = null }) {
  const stage = { success: false, discovered: 0, normalized: 0 };
  try {
    const discoveryResult = await runDiscovery({ braveApiKey, googleApiKey, googleCx });
    stage.discovered = discoveryResult.candidates.length;
    stage.queryUsage = {
      brave: Number(discoveryResult.stats?.brave_queries || 0),
      google: Number(discoveryResult.stats?.google_trusted_queries || 0),
      gdelt: Number(discoveryResult.stats?.gdelt_queries || 0),
      targeted_brave: Number(discoveryResult.stats?.targeted_brave_queries || 0),
    };
    stage.targeted_coverage = discoveryResult.stats?.targeted_coverage || null;
    if (!discoveryResult.candidates.length) {
      stage.error = 'No discovery candidates found';
      return { briefs: [], stage };
    }

    mergeDiscoveredNews(discoveryResult.candidates);
    const normalizedResult = await normalizeDiscoveryCandidatesToBriefs(
      discoveryResult.candidates,
      { clusterThreshold: 6, clusterSelectionLimit: Math.max(candidateLimit, 6) },
      openAiApiKey,
    );
    const normalizedBriefs = Array.isArray(normalizedResult?.briefs) ? normalizedResult.briefs : [];

    stage.normalized = normalizedBriefs.length;
    mergeBriefsIntoPool(normalizedBriefs);
    stage.success = normalizedBriefs.length > 0;
    return {
      briefs: loadSharedBriefCandidatesFromPoolInternal(candidateLimit, { leaseOwner }),
      stage,
    };
  } catch (error) {
    stage.error = error.message;
    return { briefs: [], stage };
  }
}


function isLikelyViableBrief(brief) {
  const publishabilityScore = Number(brief?.publishabilityScore || 0);
  const articleRichCount = Number(brief?.article_rich_count || 0);
  const sourceCount = Array.isArray(brief?.sourceUrls) ? brief.sourceUrls.length : 0;
  if (publishabilityScore >= 6) return true;
  if (articleRichCount >= 2) return true;
  return sourceCount >= 2 && publishabilityScore >= 5;
}

async function screenBriefSourcePackViability(briefs = [], { options = {}, braveApiKey, googleApiKey, googleCx } = {}) {
  const viableBriefs = [];
  const rejectionByBriefKey = new Map();
  const sourcePackByKey = new Map();
  const uniqueBriefs = dedupeBriefCandidates(Array.isArray(briefs) ? briefs : []);
  let attempted = 0;
  const nearMissRetries = [];
  const rescueDiagnostics = {
    nearMissTotal: 0,
    attempted: 0,
    rescued: 0,
    failed: 0,
    pre_rescue_passed: 0,
    post_rescue_passed: 0,
    worked_queries: [],
    failed_candidates: [],
  };

  for (const brief of uniqueBriefs) {
    const briefKey = getBriefCandidateKey(brief);
    try {
      attempted += 1;
      const sourcePack = await assembleSourcePack({
        ...brief,
        articleType: 'analysis',
      }, {
        ...options,
        braveApiKey,
        googleApiKey,
        googleCx,
        articleType: 'analysis',
      });

      const gateOutcome = evaluateSourcePackGateOutcome({ brief, sourcePack });
      const { pass, reasons, failureCodes } = gateOutcome;

      if (!pass) {
        const nearMiss = isNearMissSourcePackFailure(failureCodes);
        rejectionByBriefKey.set(briefKey, {
          brief_title: brief.title || null,
          poolIdentityKey: brief.poolIdentityKey || null,
          status: nearMiss ? 'near_miss_source_pack' : 'rejected',
          reasons,
          failure_codes: failureCodes,
        });
        if (nearMiss) {
          nearMissRetries.push({
            brief,
            briefKey,
            reasons,
            failureCodes,
            rankScore: Number(brief?.selectionScore || brief?.publishabilityScore || 0),
          });
        }
        console.log(`[pre-writer] Brief source-pack rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      sourcePackByKey.set(briefKey, sourcePack);
      viableBriefs.push(brief);
      rescueDiagnostics.pre_rescue_passed += 1;
      console.log(`[pre-writer] Brief source-pack passed :: ${brief.title || 'untitled'} :: sources=${sourcePack.sources?.length || 0} domains=${sourcePack.uniqueDomains || 0}`);
    } catch (error) {
      const reasons = [`Source-pack assembly error: ${error.message}`];
      rejectionByBriefKey.set(briefKey, {
        brief_title: brief.title || null,
        poolIdentityKey: brief.poolIdentityKey || null,
        reasons,
      });
      console.log(`[pre-writer] Brief source-pack error :: ${brief.title || 'untitled'} :: ${error.message}`);
    }
  }

  rescueDiagnostics.nearMissTotal = nearMissRetries.length;
  const retryCandidates = nearMissRetries
    .sort((left, right) => Number(right.rankScore || 0) - Number(left.rankScore || 0))
    .slice(0, Math.max(1, Number(options.qnaNearMissRescueLimit || 3)));

  for (const retryCandidate of retryCandidates) {
    const { brief, briefKey } = retryCandidate;
    attempted += 1;
    rescueDiagnostics.attempted += 1;
    console.log(`[pre-writer] Brief source-pack near-miss rescue :: ${brief.title || 'untitled'}`);
    try {
      const rescueResult = await runNearMissSourcePackRescue({
        brief,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        initialFailureCodes: retryCandidate.failureCodes,
      });

      if (Array.isArray(rescueResult?.workedQueries) && rescueResult.workedQueries.length > 0) {
        rescueDiagnostics.worked_queries.push(...rescueResult.workedQueries);
      }

      if (!rescueResult?.rescued || !rescueResult?.sourcePack) {
        const reasons = Array.from(new Set(rescueResult?.failureReasons?.length ? rescueResult.failureReasons : retryCandidate.reasons));
        const failureCodes = Array.from(new Set(rescueResult?.failureCodes?.length ? rescueResult.failureCodes : retryCandidate.failureCodes));
        rejectionByBriefKey.set(briefKey, {
          brief_title: brief.title || null,
          poolIdentityKey: brief.poolIdentityKey || null,
          status: 'near_miss_source_pack',
          reasons,
          failure_codes: failureCodes,
          rescue: rescueResult?.diagnostics || null,
        });
        rescueDiagnostics.failed += 1;
        rescueDiagnostics.failed_candidates.push({
          brief_title: brief.title || null,
          reasons,
          failure_codes: failureCodes,
        });
        console.log(`[pre-writer] Brief source-pack rescue rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      const retriedSourcePack = rescueResult.sourcePack;
      rejectionByBriefKey.delete(briefKey);
      sourcePackByKey.set(briefKey, retriedSourcePack);
      if (!viableBriefs.some((item) => getBriefCandidateKey(item) === briefKey)) {
        viableBriefs.push(brief);
      }
      rescueDiagnostics.rescued += 1;
      console.log(`[pre-writer] Brief source-pack rescue passed :: ${brief.title || 'untitled'} :: sources=${retriedSourcePack.sources?.length || 0} domains=${retriedSourcePack.uniqueDomains || 0}`);
    } catch (error) {
      rejectionByBriefKey.set(briefKey, {
        brief_title: brief.title || null,
        poolIdentityKey: brief.poolIdentityKey || null,
        status: 'near_miss_source_pack',
        reasons: [`Source-pack assembly error: ${error.message}`],
        failure_codes: ['thin_pack_after_rescue'],
      });
      rescueDiagnostics.failed += 1;
      rescueDiagnostics.failed_candidates.push({
        brief_title: brief.title || null,
        reasons: [`Source-pack assembly error: ${error.message}`],
        failure_codes: ['thin_pack_after_rescue'],
      });
      console.log(`[pre-writer] Brief source-pack rescue error :: ${brief.title || 'untitled'} :: ${error.message}`);
    }
  }

  rescueDiagnostics.post_rescue_passed = viableBriefs.length;

  return {
    attempted,
    viableBriefs,
    sourcePackByKey,
    rejections: Array.from(rejectionByBriefKey.values()),
    rescue: rescueDiagnostics,
  };
}

async function screenBriefViabilityForTestingInternal(briefs = [], options = {}) {
  const braveApiKey = options.braveApiKey || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const googleApiKey = options.googleApiKey || process.env.SEARCH_WEB_API;
  const googleCx = options.googleCx || process.env.SEARCH_WEB_CX;
  return screenBriefSourcePackViability(briefs, {
    options,
    braveApiKey,
    googleApiKey,
    googleCx,
  });
}

function isNearMissSourcePackFailure(failureCodes = []) {
  const codes = new Set(Array.isArray(failureCodes) ? failureCodes : []);
  return codes.has('only_one_publishable_source')
    || codes.has('missing_official')
    || codes.has('missing_trusted_reporting')
    || codes.has('thin_pack_after_rescue');
}

function mergeRescueDiagnostics(existing = null, incoming = null) {
  if (!existing && !incoming) return null;
  const left = existing || {};
  const right = incoming || {};
  return {
    nearMissTotal: Number(left.nearMissTotal || 0) + Number(right.nearMissTotal || 0),
    attempted: Number(left.attempted || 0) + Number(right.attempted || 0),
    rescued: Number(left.rescued || 0) + Number(right.rescued || 0),
    failed: Number(left.failed || 0) + Number(right.failed || 0),
    pre_rescue_passed: Number(left.pre_rescue_passed || 0) + Number(right.pre_rescue_passed || 0),
    post_rescue_passed: Number(left.post_rescue_passed || 0) + Number(right.post_rescue_passed || 0),
    worked_queries: [...(Array.isArray(left.worked_queries) ? left.worked_queries : []), ...(Array.isArray(right.worked_queries) ? right.worked_queries : [])],
    failed_candidates: [...(Array.isArray(left.failed_candidates) ? left.failed_candidates : []), ...(Array.isArray(right.failed_candidates) ? right.failed_candidates : [])],
  };
}

function evaluateSourcePackGateOutcome({ brief, sourcePack }) {
  const editorialGate = evaluateSourcePackEditorialIntegrity({ brief, sourcePack });
  const hardErrors = (editorialGate.blocking_errors || []).filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
  const gateReasons = [...(Array.isArray(sourcePack?.gateNotes) ? sourcePack.gateNotes : []), ...hardErrors];
  const reasons = Array.from(new Set(gateReasons.length > 0 ? gateReasons : ['Source-pack gate failed']));
  const pass = Boolean(sourcePack?.passesGate) && hardErrors.length === 0;
  const failureCodes = classifySourcePackFailureCodes({ reasons, sourcePack });
  return { pass, reasons, failureCodes };
}

function classifySourcePackFailureCodes({ reasons = [], sourcePack = null } = {}) {
  const text = Array.isArray(reasons) ? reasons.join(' | ').toLowerCase() : '';
  const codes = new Set();

  if (text.includes('need at least 2 publishable sources, found 1') || text.includes('need at least 2 different domains among publishable sources, found 1')) {
    codes.add('only_one_publishable_source');
  }
  if (text.includes('publishable pack remains thin') || text.includes('publishable evidence remained thin')) {
    codes.add('thin_pack_after_rescue');
  }
  if (text.includes('need at least one trusted reporting source or official primary source')) {
    const sources = Array.isArray(sourcePack?.sources) ? sourcePack.sources : [];
    if (!sources.some((source) => isOfficialPrimaryDomainForRescue(source?.canonical_domain || source?.domain))) {
      codes.add('missing_official');
    }
    if (!sources.some((source) => isTrustedReportingDomainForRescue(source?.canonical_domain || source?.domain))) {
      codes.add('missing_trusted_reporting');
    }
    if (!codes.has('missing_official') && !codes.has('missing_trusted_reporting')) {
      codes.add('missing_official');
      codes.add('missing_trusted_reporting');
    }
  }
  if (isGenericOnlySourcePack(sourcePack)) {
    codes.add('generic_sources_only');
  }
  if (codes.size === 0 && text.includes('source-pack gate failed')) {
    codes.add('thin_pack_after_rescue');
  }
  return Array.from(codes);
}

function isTrustedReportingDomainForRescue(domain) {
  return isTrustedReportingDomain(domain);
}

function isOfficialPrimaryDomainForRescue(domain) {
  return isOfficialPrimaryDomain(domain);
}

function isGenericOnlySourcePack(sourcePack = null) {
  const publishable = Array.isArray(sourcePack?.sources) ? sourcePack.sources : [];
  if (publishable.length === 0) return false;
  return publishable.every((source) => !!getGenericRescueReason(source));
}

const RESCUE_GENERIC_TITLE_PATTERNS = [
  /live updates?/i,
  /latest updates?/i,
  /what we know/i,
  /roundup/i,
  /category/i,
  /tag page/i,
  /news hub/i,
];

function getGenericRescueReason(source = {}) {
  const pageKind = String(source?.page_kind || '').toLowerCase();
  const url = String(source?.canonical_url || source?.url || '').toLowerCase();
  const title = String(source?.title || '');
  if (['live', 'section', 'topic', 'homepage', 'roundup', 'video', 'audio'].includes(pageKind)) return `page_kind:${pageKind}`;
  if (Number(source?.genericity_score || 0) >= 7) return 'high_genericity';
  if (Number(source?.article_likelihood || 0) < 4) return 'low_article_signal';
  if (/(\/live\/|\/live-updates\/|\/category\/|\/categories\/|\/tag\/|\/tags\/|\/topics\/|\/topic\/|\/news\/?$)/.test(url)) return 'container_url';
  if (RESCUE_GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return 'container_title';
  return null;
}

async function runNearMissSourcePackRescue({
  brief,
  options = {},
  braveApiKey,
  googleApiKey,
  googleCx,
  initialFailureCodes = [],
} = {}) {
  const maxQueriesRaw = Number(options.qnaRescueMaxQueries || process.env.QNA_RESCUE_MAX_QUERIES || 5);
  const maxQueries = Math.max(3, Math.min(5, Number.isFinite(maxQueriesRaw) ? Math.floor(maxQueriesRaw) : 5));
  const retryPoolMatchLimit = Math.max(Number(options.poolMatchLimit || 14), Number(options.qnaRetryPoolMatchLimit || 24));
  const entityProfile = inferRescueEntityProfile(brief);
  const queryPlan = buildNearMissRescueQueryPlan(brief, {
    maxQueries,
    failureCodes: initialFailureCodes,
    entityProfile,
  });

  const diagnostics = {
    brief_title: brief?.title || null,
    initial_failure_codes: Array.isArray(initialFailureCodes) ? initialFailureCodes : [],
    entity_profile: {
      canonical: entityProfile.canonical || null,
      aliases: entityProfile.aliases || [],
      confidence: entityProfile.confidence || 'low',
      evidence: entityProfile.evidence || {},
    },
    entity_diagnostics: entityProfile.diagnostics || [],
    query_plan: queryPlan.map((query) => ({
      level: query.level,
      intent: query.intent,
      query: query.query,
      targeted_domains: query.targetedDomains || [],
    })),
    query_results: [],
    worked_queries: [],
    role_coverage: null,
    missing_roles: ['primary_or_official', 'trusted_reporting', 'independent_confirming'],
    early_stop_reason: null,
    failure_codes: [],
    rescue_failure_summary: null,
  };

  const rescuedCandidates = [];
  let braveRescueUsed = false;
  let noProgressStreak = 0;
  let previousMissingRolesKey = diagnostics.missing_roles.join('|');

  for (let queryIndex = 0; queryIndex < queryPlan.length; queryIndex += 1) {
    const queryEntry = queryPlan[queryIndex];
    const level = String(queryEntry.level || 'strict');
    const intent = String(queryEntry.intent || 'general');
    const query = String(queryEntry.query || '').trim();
    if (!query) continue;
    if (shouldSkipRescueQueryByCoverage(queryEntry, diagnostics.role_coverage)) {
      diagnostics.query_results.push({
        level,
        intent,
        query,
        skipped: 'role_already_satisfied',
      });
      continue;
    }
    if (String(entityProfile.confidence || 'low') === 'low' && level === 'broad' && intent === 'trusted_reporting') {
      diagnostics.query_results.push({
        level,
        intent,
        query,
        skipped: 'entity_confidence_low_broad_trusted_skip',
      });
      continue;
    }

    const searchResult = await runRescueSearchPass({
      brief,
      query,
      level,
      intent,
      googleApiKey,
      googleCx,
      includeBrave: false,
      braveApiKey: null,
      includeGdelt: true,
      entityProfile,
      livePhase: 'rescue',
    });

    diagnostics.query_results.push({
      level,
      intent,
      query,
      providers: searchResult.providerStatus,
      candidates: searchResult.candidates.length,
      kept_after_filter: searchResult.keptCount,
      generic_filtered: searchResult.genericFiltered,
    });

    const candidateCountBefore = rescuedCandidates.length;
    if (searchResult.candidates.length > 0) {
      rescuedCandidates.push(...searchResult.candidates);
      diagnostics.worked_queries.push({
        level,
        intent,
        query,
        candidates: searchResult.candidates.length,
      });
    }

    const clusterView = buildRescueClusterView(rescuedCandidates, brief, { entityProfile });
    const roleCoverage = buildRescueRoleCoverage(clusterView.dominantEntries || []);
    diagnostics.role_coverage = roleCoverage;
    diagnostics.missing_roles = deriveMissingRescueRoles(roleCoverage);
    diagnostics.cluster_coherence = clusterView?.dominantCoherence ?? null;
    if (isRescueRoleCoverageReady(roleCoverage)) {
      break;
    }

    const missingRolesKey = diagnostics.missing_roles.join('|');
    const progressed = rescuedCandidates.length > candidateCountBefore || missingRolesKey !== previousMissingRolesKey;
    noProgressStreak = progressed ? 0 : noProgressStreak + 1;
    previousMissingRolesKey = missingRolesKey;

    const earlyStop = evaluateRescueEarlyStop({
      roleCoverage,
      remainingQueries: queryPlan.slice(queryIndex + 1),
      noProgressStreak,
      queryResult: searchResult,
    });
    if (earlyStop.stop) {
      diagnostics.early_stop_reason = earlyStop.reason;
      break;
    }
  }

  if (rescueNeedsBraveFallback(diagnostics.role_coverage) && !braveRescueUsed && shouldRunBraveRescueFallback({ diagnostics, entityProfile })) {
    const braveQuery = selectBraveRescueFallbackQuery(queryPlan, diagnostics);
    if (braveQuery?.query) {
      braveRescueUsed = true;
      const bravePass = await runRescueSearchPass({
        brief,
        query: braveQuery.query,
        level: braveQuery.level,
        intent: braveQuery.intent,
        googleApiKey: null,
        googleCx: null,
        includeBrave: true,
        braveApiKey,
        includeGdelt: false,
        entityProfile,
        livePhase: 'rescue',
      });
      diagnostics.query_results.push({
        level: braveQuery.level,
        intent: braveQuery.intent,
        query: braveQuery.query,
        providers: bravePass.providerStatus,
        candidates: bravePass.candidates.length,
        kept_after_filter: bravePass.keptCount,
        generic_filtered: bravePass.genericFiltered,
      });
      if (bravePass.candidates.length > 0) {
        rescuedCandidates.push(...bravePass.candidates);
        diagnostics.worked_queries.push({
          level: braveQuery.level,
          intent: braveQuery.intent,
          query: braveQuery.query,
          candidates: bravePass.candidates.length,
        });
      }
    }
  }

  const clusterView = buildRescueClusterView(rescuedCandidates, brief, { entityProfile });
  const roleCoverage = buildRescueRoleCoverage(clusterView.dominantEntries || []);
  diagnostics.role_coverage = roleCoverage;
  diagnostics.missing_roles = deriveMissingRescueRoles(roleCoverage);
  diagnostics.cluster_coherence = clusterView?.dominantCoherence ?? null;

  if ((clusterView.totalCandidates || 0) === 0) {
    diagnostics.failure_codes = ['generic_sources_only', 'thin_pack_after_rescue'];
    diagnostics.rescue_failure_summary = summarizeRescueFailure({
      diagnostics,
      failureCodes: diagnostics.failure_codes,
      queryPlan,
      roleCoverage,
    });
    return {
      rescued: false,
      sourcePack: null,
      failureCodes: diagnostics.failure_codes,
      failureReasons: ['Rescue search returned no event-aligned publishable candidates'],
      diagnostics,
      workedQueries: diagnostics.worked_queries,
    };
  }

  const selectedRescueSources = selectRescueSourcesByRole(clusterView.dominantEntries || []);
  if (selectedRescueSources.length === 0) {
    diagnostics.failure_codes = ['generic_sources_only', 'thin_pack_after_rescue'];
    diagnostics.rescue_failure_summary = summarizeRescueFailure({
      diagnostics,
      failureCodes: diagnostics.failure_codes,
      queryPlan,
      roleCoverage,
    });
    return {
      rescued: false,
      sourcePack: null,
      failureCodes: diagnostics.failure_codes,
      failureReasons: ['Rescue cluster contained only generic/non-publishable materials'],
      diagnostics,
      workedQueries: diagnostics.worked_queries,
    };
  }

  const augmentedBrief = buildRescueAugmentedBrief(brief, selectedRescueSources);
  const sourcePack = await assembleSourcePack({
    ...augmentedBrief,
    articleType: 'analysis',
  }, {
    ...options,
    braveApiKey,
    googleApiKey,
    googleCx,
    articleType: 'analysis',
    poolMatchLimit: retryPoolMatchLimit,
  });

  const gateOutcome = evaluateSourcePackGateOutcome({ brief: augmentedBrief, sourcePack });
  if (gateOutcome.pass) {
    diagnostics.post_rescue_coherence = estimateSourcePackCoherence(sourcePack, augmentedBrief);
    return {
      rescued: true,
      sourcePack,
      failureCodes: [],
      failureReasons: [],
      diagnostics,
      workedQueries: diagnostics.worked_queries,
    };
  }

  const failureCodes = Array.from(new Set([
    ...(gateOutcome.failureCodes || []),
    ...deriveMissingCoverageCodes(roleCoverage),
  ]));
  diagnostics.failure_codes = failureCodes;
  diagnostics.post_rescue_coherence = estimateSourcePackCoherence(sourcePack, augmentedBrief);
  diagnostics.rescue_failure_summary = summarizeRescueFailure({
    diagnostics,
    failureCodes,
    queryPlan,
    roleCoverage,
  });

  return {
    rescued: false,
    sourcePack,
    failureCodes,
    failureReasons: gateOutcome.reasons || ['Rescue source-pack gate failed'],
    diagnostics,
    workedQueries: diagnostics.worked_queries,
  };
}

function buildNearMissRescueQueryPlan(brief = {}, { maxQueries = 5, failureCodes = [], entityProfile = null } = {}) {
  const title = compactRescueText(brief?.title || '', 18);
  const entity = entityProfile || inferRescueEntityProfile(brief);
  const mainEntity = entity.canonical || '';
  const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  const eventType = inferRescueEventType(brief);
  const dateToken = extractBriefDateToken(brief);
  const broadTopic = buildBroadRescueTopic(brief);
  const allowStrictEntity = String(entity.confidence || 'low') !== 'low';
  const lowConfidenceEntity = !allowStrictEntity;
  const requiresOfficial = Array.isArray(failureCodes) && failureCodes.includes('missing_official');
  const requiresTrusted = Array.isArray(failureCodes) && failureCodes.includes('missing_trusted_reporting');
  const officialDomainTargets = buildRescueOfficialDomainTargets(brief, {
    requireOfficial: requiresOfficial,
    entityProfile: entity,
  });
  const officialDomainClause = officialDomainTargets.length > 0
    ? `(${officialDomainTargets.slice(0, 4).map((domain) => `site:${domain}`).join(' OR ')})`
    : '';

  const strictAnchor = compactRescueText([mainEntity, title, aliases[0], eventType, dateToken].filter(Boolean).join(' '), 24);
  const relaxedAnchor = compactRescueText([mainEntity || title, aliases[0], broadTopic, eventType, dateToken].filter(Boolean).join(' '), 22);
  const broadAnchor = compactRescueText([mainEntity || '', broadTopic || title || 'developing story'].filter(Boolean).join(' '), 16);
  const aliasClause = aliases.length > 0 ? `(${aliases.slice(0, 2).join(' OR ')})` : '';

  const queries = [];
  if (allowStrictEntity) {
    queries.push({
      level: 'strict',
      intent: 'official_primary',
      query: compactRescueText(`${strictAnchor} ${aliasClause} ${officialDomainClause} (official statement OR press release OR court filing OR regulator OR agency OR newsroom OR investor relations)`, 42),
      targetedDomains: officialDomainTargets,
    });
    queries.push({
      level: 'strict',
      intent: 'trusted_reporting',
      query: compactRescueText(`${strictAnchor} (reuters OR associated press OR apnews OR bbc OR bloomberg)`, 38),
      targetedDomains: [],
    });
  }

  queries.push(
    {
      level: 'relaxed',
      intent: 'independent_confirming',
      query: compactRescueText(`${relaxedAnchor} ${dateToken} (confirmed OR report OR filing OR statement)`, 34),
      targetedDomains: [],
    },
    {
      level: 'broad',
      intent: 'official_primary',
      query: compactRescueText(`${mainEntity || title || broadAnchor} ${eventType} (newsroom OR regulator OR agency OR court OR league OR team OR university OR journal OR investor relations) ${officialDomainClause}`, 36),
      targetedDomains: officialDomainTargets,
    },
  );

  if (!lowConfidenceEntity || requiresTrusted) {
    queries.push({
      level: lowConfidenceEntity ? 'relaxed' : 'broad',
      intent: 'trusted_reporting',
      query: compactRescueText(`${broadAnchor} ${mainEntity || ''} (reuters OR associated press OR apnews OR bbc OR bloomberg OR investigation OR report)`, 32),
      targetedDomains: [],
    });
  }

  return queries
    .filter((entry) => {
      if (!entry?.query) return false;
      if (lowConfidenceEntity && entry.level === 'strict') return false;
      return true;
    })
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.query === entry.query) === index)
    .filter((entry) => String(entry.query || '').trim().length >= 8)
    .slice(0, Math.max(3, Math.min(lowConfidenceEntity ? 4 : 5, maxQueries)));
}

async function runRescueSearchPass({
  brief,
  query,
  level,
  intent,
  googleApiKey,
  googleCx,
  includeBrave = false,
  braveApiKey = null,
  includeGdelt = true,
  entityProfile = null,
  livePhase = 'rescue',
} = {}) {
  const providerStatus = [];
  const rawCandidates = [];
  let genericFiltered = 0;

  if (googleApiKey && googleCx) {
    if (shouldSkipDuplicateRescueQuery('google', query, level, intent)) {
      providerStatus.push({
        provider: 'google',
        status: 'dedupe_recent_query',
        items: 0,
      });
    } else {
      let googleStatus = 'exception';
    try {
      const googleResult = await googleSearch(query, googleApiKey, googleCx, {
        num: 8,
        dateRestrict: 'd7',
        logLabel: `qna_rescue_google_${level}`,
        livePhase,
      });
      googleStatus = googleResult.status;
      providerStatus.push({
        provider: 'google',
        status: googleResult.status,
        items: Array.isArray(googleResult.items) ? googleResult.items.length : 0,
      });
      for (const item of googleResult.items || []) {
        rawCandidates.push({
          url: item?.link,
          title: item?.title || '',
          summary: item?.snippet || '',
          provider: 'google_trusted',
          when: item?.pagemap?.metatags?.[0]?.['article:published_time'] || item?.pagemap?.metatags?.[0]?.['og:updated_time'] || '',
        });
      }
    } catch (error) {
      providerStatus.push({
        provider: 'google',
        status: 'exception',
        items: 0,
        error: error.message,
      });
    }
      recordRescueQueryUsage('google', query, level, intent, googleStatus);
    }
  }

  if (includeGdelt) {
    if (shouldSkipDuplicateRescueQuery('gdelt', query, level, intent)) {
      providerStatus.push({
        provider: 'gdelt',
        status: 'dedupe_recent_query',
        items: 0,
      });
    } else {
      let gdeltStatus = 'exception';
    try {
      const gdeltResult = await gdeltSearch(query, {
        maxRecords: 12,
        timespan: '7days',
        sort: 'DateDesc',
        logLabel: `qna_rescue_gdelt_${level}`,
        livePhase,
      });
      gdeltStatus = gdeltResult.status;
      providerStatus.push({
        provider: 'gdelt',
        status: gdeltResult.status,
        items: Array.isArray(gdeltResult.articles) ? gdeltResult.articles.length : 0,
      });
      for (const item of gdeltResult.articles || []) {
        rawCandidates.push({
          url: item?.url,
          title: item?.title || '',
          summary: item?.snippet || item?.description || '',
          provider: 'gdelt',
          when: item?.seendate || item?.published_at || '',
        });
      }
    } catch (error) {
      providerStatus.push({
        provider: 'gdelt',
        status: 'exception',
        items: 0,
        error: error.message,
      });
    }
      recordRescueQueryUsage('gdelt', query, level, intent, gdeltStatus);
    }
  }

  if (includeBrave && braveApiKey) {
    if (shouldSkipDuplicateRescueQuery('brave', query, level, intent)) {
      providerStatus.push({
        provider: 'brave',
        status: 'dedupe_recent_query',
        items: 0,
      });
    } else {
      let braveStatus = 'exception';
    try {
      const braveResult = await braveNewsSearch(query, braveApiKey, {
        count: 8,
        freshness: 'pw',
        logLabel: `qna_rescue_brave_${level}`,
        livePhase,
      });
      braveStatus = braveResult.status;
      providerStatus.push({
        provider: 'brave',
        status: braveResult.status,
        items: Array.isArray(braveResult.results) ? braveResult.results.length : 0,
      });
      for (const item of braveResult.results || []) {
        rawCandidates.push({
          url: item?.url,
          title: item?.title || '',
          summary: item?.description || item?.snippet || '',
          provider: 'brave',
          when: item?.published || item?.age || '',
        });
      }
    } catch (error) {
      providerStatus.push({
        provider: 'brave',
        status: 'exception',
        items: 0,
        error: error.message,
      });
    }
      recordRescueQueryUsage('brave', query, level, intent, braveStatus);
    }
  }

  const keptByUrl = new Map();
  const entity = entityProfile || inferRescueEntityProfile(brief);
  for (const candidate of rawCandidates) {
    const normalized = normalizeSourceMaterial({
      ...candidate,
      section_id: brief?.section_id || null,
      topic_id: brief?.topic_id || null,
      cluster_id: brief?.cluster_id || null,
      eventKey: brief?.eventKey || null,
      entities: [
        ...(Array.isArray(brief?.entities) ? brief.entities : []),
        ...(Array.isArray(brief?.involvedParties) ? brief.involvedParties : []),
        ...(entity?.canonical ? [entity.canonical] : []),
        ...(Array.isArray(entity?.aliases) ? entity.aliases : []),
      ],
      region: brief?.region || 'global',
      angle: brief?.angle || 'general',
    });
    if (!normalized) continue;
    const genericReason = getGenericRescueReason(normalized);
    if (genericReason) {
      genericFiltered += 1;
      continue;
    }

    const roleResult = classifySourceRole(normalized, brief);
    const sameEventScore = Number(roleResult?.same_event_score || 0);
    const role = String(roleResult?.role || '');
    const entityCoherence = computeRescueEntityCoherence(normalized, brief, entity);

    if (role === 'reject' && sameEventScore < 4) {
      continue;
    }
    if (sameEventScore < 2 && role === 'signal_only') {
      continue;
    }
    if (String(entity?.confidence || 'low') === 'low' && sameEventScore < 3 && !['core', 'supporting'].includes(role)) {
      continue;
    }
    if (String(entity?.confidence || 'low') === 'low' && entityCoherence < 0.35 && sameEventScore < 4) {
      continue;
    }

    const rescueScore = computeRescueEntryScore(normalized, roleResult, { brief, entityProfile: entity });
    const key = normalized?.canonical_url || normalized?.url;
    const existing = keptByUrl.get(key);
    if (!existing || rescueScore > existing.rescueScore) {
      keptByUrl.set(key, {
        source: normalized,
        roleResult,
        rescueScore,
        queryMeta: { query, level, intent },
      });
    }
  }

  return {
    providerStatus,
    candidates: Array.from(keptByUrl.values()).sort((left, right) => Number(right.rescueScore || 0) - Number(left.rescueScore || 0)),
    keptCount: keptByUrl.size,
    genericFiltered,
  };
}

function computeRescueEntryScore(source = {}, roleResult = {}, { brief = {}, entityProfile = null } = {}) {
  const sameEvent = Number(roleResult?.same_event_score || 0);
  const topicFit = Number(roleResult?.topic_fit_score || 0);
  const articleLikelihood = Number(source?.article_likelihood || 0);
  const quality = Number(source?.source_quality_score || source?.sourceQualityScore || 0);
  const trustedBoost = isTrustedReportingDomainForRescue(source?.canonical_domain || source?.domain) ? 4 : 0;
  const officialBoost = isOfficialPrimaryDomainForRescue(source?.canonical_domain || source?.domain) || String(source?.page_kind || '') === 'official_release' ? 4 : 0;
  const roleBoost = String(roleResult?.role || '') === 'core' ? 4 : String(roleResult?.role || '') === 'supporting' ? 2 : 0;
  const entityCoherence = computeRescueEntityCoherence(source, brief, entityProfile);
  return sameEvent * 2
    + topicFit
    + articleLikelihood * 0.8
    + quality * 0.1
    + trustedBoost
    + officialBoost
    + roleBoost
    + (entityCoherence * 6);
}

function buildRescueClusterView(entries = [], brief = {}, { entityProfile = null } = {}) {
  const deduped = dedupeRescueEntries(entries);
  const clusters = [];
  const entity = entityProfile || inferRescueEntityProfile(brief);

  for (const entry of deduped) {
    let assigned = null;
    for (const cluster of clusters) {
      if (rescueEntriesBelongToSameEvent(entry, cluster.anchor, brief, { entityProfile: entity })) {
        assigned = cluster;
        break;
      }
    }
    if (!assigned) {
      assigned = { anchor: entry, entries: [] };
      clusters.push(assigned);
    }
    assigned.entries.push(entry);
    assigned.entries.sort((left, right) => Number(right.rescueScore || 0) - Number(left.rescueScore || 0));
    assigned.anchor = assigned.entries[0];
  }

  const scoredClusters = clusters.map((cluster) => {
    const domainCount = new Set(cluster.entries.map((entry) => normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || ''))).size;
    const totalScore = cluster.entries.reduce((sum, entry) => sum + Number(entry?.rescueScore || 0), 0);
    const trustedCount = cluster.entries.filter((entry) => isTrustedReportingDomainForRescue(entry?.source?.canonical_domain || entry?.source?.domain)).length;
    const officialCount = cluster.entries.filter((entry) => isOfficialPrimaryDomainForRescue(entry?.source?.canonical_domain || entry?.source?.domain) || String(entry?.source?.page_kind || '') === 'official_release').length;
    const coherenceScore = computeRescueClusterCoherence(cluster.entries, brief, entity);
    const clusterScore = totalScore + (domainCount * 3) + (trustedCount * 2) + (officialCount * 2) + (coherenceScore * 8);
    return { ...cluster, clusterScore, domainCount, coherenceScore };
  }).sort((left, right) => right.clusterScore - left.clusterScore);

  const dominantEntriesRaw = scoredClusters[0]?.entries || [];
  const dominantEntries = filterRescueDominantEntries(dominantEntriesRaw, brief, entity);
  const dominantCoherence = computeRescueClusterCoherence(dominantEntries, brief, entity);

  return {
    totalCandidates: deduped.length,
    clusters: scoredClusters,
    dominantEntries,
    dominantCoherence: Number(dominantCoherence || 0),
  };
}

function dedupeRescueEntries(entries = []) {
  const byUrl = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = normalizeRescueUrl(entry?.source?.canonical_url || entry?.source?.url || '');
    if (!key) continue;
    const existing = byUrl.get(key);
    if (!existing || Number(entry?.rescueScore || 0) > Number(existing?.rescueScore || 0)) {
      byUrl.set(key, entry);
    }
  }
  return Array.from(byUrl.values());
}

function filterRescueDominantEntries(entries = [], brief = {}, entityProfile = null) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= 2) return list;
  const anchor = list[0];
  const filtered = [anchor];
  for (let index = 1; index < list.length; index += 1) {
    const entry = list[index];
    const sameEvent = rescueEntriesBelongToSameEvent(entry, anchor, brief, { entityProfile });
    if (!sameEvent) continue;
    if (Number(entry?.roleResult?.same_event_score || 0) < 3) continue;
    filtered.push(entry);
  }
  return filtered;
}

function rescueEntriesBelongToSameEvent(leftEntry = {}, rightEntry = {}, brief = {}, { entityProfile = null } = {}) {
  const left = leftEntry?.source || {};
  const right = rightEntry?.source || {};
  if (!left || !right) return false;

  if (left?.cluster_id && right?.cluster_id && left.cluster_id === right.cluster_id) return true;
  if (left?.event_key && right?.event_key && left.event_key === right.event_key) return true;

  const leftTokens = titleTokensForCoherence(left?.title || '');
  const rightTokens = titleTokensForCoherence(right?.title || '');
  let titleOverlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) titleOverlap += 1;
  }

  const leftEntities = new Set((Array.isArray(left?.entities) ? left.entities : []).map((item) => String(item || '').toLowerCase()));
  const rightEntities = new Set((Array.isArray(right?.entities) ? right.entities : []).map((item) => String(item || '').toLowerCase()));
  let entityOverlap = 0;
  for (const entity of leftEntities) {
    if (rightEntities.has(entity)) entityOverlap += 1;
  }

  const leftSameEvent = Number(leftEntry?.roleResult?.same_event_score || 0);
  const rightSameEvent = Number(rightEntry?.roleResult?.same_event_score || 0);
  const briefTokens = titleTokensForCoherence(brief?.title || '');
  const eventTokens = titleTokensForCoherence(`${brief?.whatHappened || ''} ${brief?.angle || ''} ${inferRescueEventType(brief)}`);
  let briefOverlap = 0;
  for (const token of leftTokens) {
    if (briefTokens.has(token)) briefOverlap += 1;
  }
  for (const token of rightTokens) {
    if (briefTokens.has(token)) briefOverlap += 1;
  }
  const leftEventOverlap = Array.from(leftTokens).filter((token) => eventTokens.has(token)).length;
  const rightEventOverlap = Array.from(rightTokens).filter((token) => eventTokens.has(token)).length;
  const eventOverlap = leftEventOverlap + rightEventOverlap;

  const entity = entityProfile || inferRescueEntityProfile(brief);
  const leftEntityCoherence = computeRescueEntityCoherence(left, brief, entity);
  const rightEntityCoherence = computeRescueEntityCoherence(right, brief, entity);

  if (titleOverlap >= 3 && (entityOverlap >= 1 || (leftSameEvent >= 4 && rightSameEvent >= 4))) return true;
  if (entityOverlap >= 1 && (leftSameEvent >= 3 || rightSameEvent >= 3)) return true;
  if (briefOverlap >= 3 && leftSameEvent >= 3 && rightSameEvent >= 3) return true;
  if (eventOverlap >= 2 && leftSameEvent >= 4 && rightSameEvent >= 4) return true;
  if (leftEntityCoherence >= 0.55 && rightEntityCoherence >= 0.55 && (leftSameEvent >= 3 || rightSameEvent >= 3)) return true;
  return false;
}

function computeRescueClusterCoherence(entries = [], brief = {}, entityProfile = null) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  const scores = list.map((entry) => computeRescueEntityCoherence(entry?.source || {}, brief, entityProfile));
  const avg = scores.reduce((sum, value) => sum + value, 0) / Math.max(scores.length, 1);
  return Math.round(avg * 100) / 100;
}

function computeRescueEntityCoherence(source = {}, brief = {}, entityProfile = null) {
  const entity = entityProfile || inferRescueEntityProfile(brief);
  const canonical = String(entity?.canonical || '').trim();
  if (!canonical || canonical.toLowerCase() === 'unspecified') return 0;

  const entityTokens = tokenizeEntityCore(canonical);
  if (entityTokens.size === 0) return 0;

  const aliasTokens = new Set((entity?.aliases || []).flatMap((alias) => Array.from(tokenizeEntityCore(alias))));
  const sourceTokens = new Set([
    ...String(`${source?.title || ''} ${source?.snippet || ''}`).toLowerCase().split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3),
    ...((Array.isArray(source?.entities) ? source.entities : []).map((value) => String(value || '').toLowerCase())),
  ]);

  const overlapCanonical = Array.from(entityTokens).filter((token) => sourceTokens.has(token)).length;
  const overlapAlias = Array.from(aliasTokens).filter((token) => sourceTokens.has(token)).length;
  const ratio = overlapCanonical / Math.max(entityTokens.size, 1);
  const aliasRatio = overlapAlias / Math.max(aliasTokens.size || 1, 1);

  let score = ratio;
  if (ratio >= 0.8) score += 0.25;
  if (aliasRatio >= 0.5) score += 0.15;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

function tokenizeEntityCore(value = '') {
  return new Set(
    normalizeEntityPhrase(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .filter((token) => !RESCUE_ENTITY_STOP_WORDS.has(token))
  );
}

function buildRescueRoleCoverage(entries = []) {
  const candidates = Array.isArray(entries) ? entries : [];
  const primaryOfficial = [];
  const trusted = [];
  const confirmingCandidates = [];
  const optional = [];

  for (const entry of candidates) {
    const source = entry?.source || {};
    const role = String(entry?.roleResult?.role || '');
    const sameEvent = Number(entry?.roleResult?.same_event_score || 0);
    const genericReason = getGenericRescueReason(source);
    if (genericReason) continue;

    const isOfficial = isOfficialPrimaryDomainForRescue(source?.canonical_domain || source?.domain) || String(source?.page_kind || '') === 'official_release' || looksLikeOfficialPrimarySource(source);
    const isTrusted = isTrustedReportingDomainForRescue(source?.canonical_domain || source?.domain);
    if (isOfficial) primaryOfficial.push(entry);
    if (isTrusted) trusted.push(entry);

    if (['core', 'supporting'].includes(role) && sameEvent >= 3) {
      confirmingCandidates.push(entry);
    } else if (['background', 'supporting'].includes(role)) {
      optional.push(entry);
    }
  }

  const primaryOfficialUnique = pickUniqueDomainEntries(primaryOfficial, 4);
  const trustedUnique = pickUniqueDomainEntries(trusted, 4);
  const roleLockedDomains = new Set([
    ...primaryOfficialUnique.map((entry) => normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || '')),
    ...trustedUnique.map((entry) => normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || '')),
  ].filter(Boolean));

  const independentConfirming = pickUniqueDomainEntries(
    confirmingCandidates.filter((entry) => {
      const domain = normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || '');
      return domain && !roleLockedDomains.has(domain);
    }),
    4
  );
  const optionalContext = pickUniqueDomainEntries(optional, 4);
  return {
    totalCandidates: candidates.length,
    primary_or_official: { count: primaryOfficial.length, items: primaryOfficialUnique },
    trusted_reporting: { count: trusted.length, items: trustedUnique },
    independent_confirming: { count: independentConfirming.length, items: independentConfirming },
    optional_context: { count: optionalContext.length, items: optionalContext },
    unique_domains: new Set(candidates.map((entry) => normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || '')).filter(Boolean)).size,
  };
}

function isRescueRoleCoverageReady(coverage = null) {
  if (!coverage) return false;
  return Number(coverage?.primary_or_official?.count || 0) >= 1
    && Number(coverage?.trusted_reporting?.count || 0) >= 1
    && Number(coverage?.independent_confirming?.count || 0) >= 1;
}

function rescueNeedsBraveFallback(coverage = null) {
  return !isRescueRoleCoverageReady(coverage);
}

function deriveMissingCoverageCodes(coverage = null) {
  const codes = new Set();
  if (!coverage) {
    codes.add('thin_pack_after_rescue');
    return Array.from(codes);
  }
  if (Number(coverage?.primary_or_official?.count || 0) < 1) codes.add('missing_official');
  if (Number(coverage?.trusted_reporting?.count || 0) < 1) codes.add('missing_trusted_reporting');
  if (Number(coverage?.independent_confirming?.count || 0) < 1) codes.add('only_one_publishable_source');
  if (Number(coverage?.totalCandidates || 0) < 2) codes.add('thin_pack_after_rescue');
  return Array.from(codes);
}

function deriveMissingRescueRoles(coverage = null) {
  const missing = [];
  if (Number(coverage?.primary_or_official?.count || 0) < 1) missing.push('primary_or_official');
  if (Number(coverage?.trusted_reporting?.count || 0) < 1) missing.push('trusted_reporting');
  if (Number(coverage?.independent_confirming?.count || 0) < 1) missing.push('independent_confirming');
  return missing;
}

function queryIntentSupportsRole(intent = '', role = '') {
  const normalizedIntent = String(intent || '').toLowerCase();
  if (normalizedIntent === 'general') return true;
  if (role === 'primary_or_official') return normalizedIntent === 'official_primary';
  if (role === 'trusted_reporting') return normalizedIntent === 'trusted_reporting';
  if (role === 'independent_confirming') {
    return normalizedIntent === 'independent_confirming'
      || normalizedIntent === 'trusted_reporting'
      || normalizedIntent === 'official_primary';
  }
  return true;
}

function shouldSkipRescueQueryByCoverage(queryEntry = {}, coverage = null) {
  if (!coverage) return false;
  const missingRoles = deriveMissingRescueRoles(coverage);
  if (missingRoles.length === 0) return true;
  const intent = String(queryEntry?.intent || 'general');
  return !missingRoles.some((role) => queryIntentSupportsRole(intent, role));
}

function remainingQueriesCanCoverMissingRoles(remainingQueries = [], missingRoles = []) {
  if (!Array.isArray(missingRoles) || missingRoles.length === 0) return true;
  const intents = Array.isArray(remainingQueries)
    ? remainingQueries.map((entry) => String(entry?.intent || 'general'))
    : [];
  for (const role of missingRoles) {
    if (intents.some((intent) => queryIntentSupportsRole(intent, role))) continue;
    return false;
  }
  return true;
}

function evaluateRescueEarlyStop({
  roleCoverage = null,
  remainingQueries = [],
  noProgressStreak = 0,
  queryResult = null,
} = {}) {
  const missingRoles = deriveMissingRescueRoles(roleCoverage);
  if (missingRoles.length === 0) return { stop: true, reason: 'role_coverage_completed' };
  if (!remainingQueriesCanCoverMissingRoles(remainingQueries, missingRoles)) {
    return {
      stop: true,
      reason: `missing_roles_not_coverable:${missingRoles.join(',')}`,
    };
  }

  const exhaustedProviders = (queryResult?.providerStatus || [])
    .filter((item) => String(item?.status || '') === 'live_quota_exhausted')
    .map((item) => String(item?.provider || '').toLowerCase())
    .filter(Boolean);
  if (exhaustedProviders.length >= 2 && noProgressStreak >= 1) {
    return {
      stop: true,
      reason: `multi_provider_quota_exhausted:${Array.from(new Set(exhaustedProviders)).join(',')}`,
    };
  }
  if (noProgressStreak >= 2) {
    return { stop: true, reason: 'no_progress_after_multiple_passes' };
  }
  return { stop: false, reason: null };
}

function shouldRunBraveRescueFallback({ diagnostics = {}, entityProfile = null } = {}) {
  const missingRoles = Array.isArray(diagnostics?.missing_roles) ? diagnostics.missing_roles : [];
  if (missingRoles.length === 0) return false;
  if (String(entityProfile?.confidence || 'low') !== 'low') return true;
  return Array.isArray(diagnostics?.worked_queries) && diagnostics.worked_queries.length > 0;
}

function selectBraveRescueFallbackQuery(queryPlan = [], diagnostics = {}) {
  const attemptedQueries = new Set(
    (Array.isArray(diagnostics?.query_results) ? diagnostics.query_results : [])
      .filter((entry) => !entry?.skipped)
      .map((entry) => String(entry?.query || '').trim())
      .filter(Boolean)
  );
  const missingRoles = Array.isArray(diagnostics?.missing_roles) ? diagnostics.missing_roles : [];
  const preferredIntents = [];
  if (missingRoles.includes('primary_or_official')) preferredIntents.push('official_primary');
  if (missingRoles.includes('trusted_reporting')) preferredIntents.push('trusted_reporting');
  if (missingRoles.includes('independent_confirming')) preferredIntents.push('independent_confirming');
  if (preferredIntents.length === 0) preferredIntents.push('trusted_reporting', 'official_primary', 'independent_confirming');

  const byIntent = Array.isArray(queryPlan)
    ? queryPlan.filter((entry) => preferredIntents.includes(String(entry?.intent || '').toLowerCase()))
    : [];
  const byIntentUntried = byIntent.filter((entry) => !attemptedQueries.has(String(entry?.query || '').trim()));
  const broadPreferred = byIntentUntried.find((entry) => String(entry?.level || '').toLowerCase() === 'broad');
  if (broadPreferred) return broadPreferred;
  if (byIntentUntried.length > 0) return byIntentUntried[0];

  const broadAny = (Array.isArray(queryPlan) ? queryPlan : [])
    .find((entry) => String(entry?.level || '').toLowerCase() === 'broad' && !attemptedQueries.has(String(entry?.query || '').trim()));
  if (broadAny) return broadAny;

  const anyUntried = (Array.isArray(queryPlan) ? queryPlan : [])
    .find((entry) => !attemptedQueries.has(String(entry?.query || '').trim()));
  return anyUntried || (Array.isArray(queryPlan) ? queryPlan[queryPlan.length - 1] : null);
}

function collectRescueQuotaSignals(queryResults = []) {
  const exhaustedProviders = new Set();
  for (const result of Array.isArray(queryResults) ? queryResults : []) {
    for (const provider of Array.isArray(result?.providers) ? result.providers : []) {
      if (String(provider?.status || '') === 'live_quota_exhausted') {
        exhaustedProviders.add(String(provider?.provider || '').toLowerCase());
      }
    }
  }
  return Array.from(exhaustedProviders);
}

function summarizeRescueFailure({ diagnostics = {}, failureCodes = [], queryPlan = [], roleCoverage = null } = {}) {
  const codes = Array.isArray(failureCodes) ? failureCodes : [];
  const missingRoles = deriveMissingRescueRoles(roleCoverage || diagnostics?.role_coverage || null);
  const quotaExhaustedProviders = collectRescueQuotaSignals(diagnostics?.query_results || []);
  const summaryCode = codes[0] || (missingRoles.length > 0 ? `missing_roles:${missingRoles.join(',')}` : 'thin_pack_after_rescue');
  return {
    summary_code: summaryCode,
    failure_codes: codes,
    missing_roles: missingRoles,
    early_stop_reason: diagnostics?.early_stop_reason || null,
    quota_exhausted_providers: quotaExhaustedProviders,
    query_plan_size: Array.isArray(queryPlan) ? queryPlan.length : 0,
    query_attempted: Array.isArray(diagnostics?.query_results) ? diagnostics.query_results.filter((entry) => !entry?.skipped).length : 0,
    worked_query_count: Array.isArray(diagnostics?.worked_queries) ? diagnostics.worked_queries.length : 0,
  };
}

function selectRescueSourcesByRole(entries = []) {
  const coverage = buildRescueRoleCoverage(entries);
  const selected = [];
  const seenUrls = new Set();
  const domainUsage = new Map();

  const appendEntries = (roleEntries = [], maxItems = 2) => {
    let kept = 0;
    for (const entry of roleEntries) {
      const source = entry?.source;
      if (!source) continue;
      const urlKey = normalizeRescueUrl(source?.canonical_url || source?.url || '');
      const domainKey = normalizeDomain(source?.canonical_domain || source?.domain || '');
      if (!urlKey || seenUrls.has(urlKey)) continue;
      const domainCount = domainUsage.get(domainKey) || 0;
      if (domainCount >= 2) continue;
      selected.push(source);
      seenUrls.add(urlKey);
      domainUsage.set(domainKey, domainCount + 1);
      kept += 1;
      if (kept >= maxItems) break;
    }
  };

  appendEntries(coverage.primary_or_official.items, 2);
  appendEntries(coverage.trusted_reporting.items, 2);
  appendEntries(coverage.independent_confirming.items, 2);
  appendEntries(coverage.optional_context.items, 2);

  return selected;
}

function pickUniqueDomainEntries(entries = [], limit = 4) {
  const byDomain = new Map();
  for (const entry of entries) {
    const domain = normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || '');
    if (!domain) continue;
    const existing = byDomain.get(domain);
    if (!existing || Number(entry?.rescueScore || 0) > Number(existing?.rescueScore || 0)) {
      byDomain.set(domain, entry);
    }
  }
  return Array.from(byDomain.values())
    .sort((left, right) => Number(right?.rescueScore || 0) - Number(left?.rescueScore || 0))
    .slice(0, limit);
}

function buildRescueAugmentedBrief(brief = {}, rescueSources = []) {
  const existingContext = Array.isArray(brief?.discoveryContext) ? brief.discoveryContext : [];
  const mergedContext = [];
  const seenContextUrls = new Set();
  const addContextItem = (item) => {
    const key = normalizeRescueUrl(item?.canonical_url || item?.canonicalUrl || item?.url || item?.link || item?.sourceUrls?.[0] || '');
    if (!key || seenContextUrls.has(key)) return;
    seenContextUrls.add(key);
    mergedContext.push(item);
  };

  for (const item of existingContext) addContextItem(item);
  for (const source of rescueSources) {
    addContextItem({
      url: source?.url,
      title: source?.title,
      summary: source?.snippet || '',
      snippet: source?.snippet || '',
      provider: `rescue_${source?.provider || 'search'}`,
      when: source?.published_at || '',
      detectedSectionId: source?.section_id || brief?.section_id || null,
      detectedTopicId: source?.topic_id || brief?.topic_id || null,
      entities: source?.entities || brief?.entities || [],
      region: source?.region || brief?.region || 'global',
      angle: source?.angle || brief?.angle || 'general',
      cluster_id: source?.cluster_id || brief?.cluster_id || null,
      eventKey: source?.event_key || brief?.eventKey || null,
      page_kind: source?.page_kind || null,
      genericity_score: source?.genericity_score,
      article_likelihood: source?.article_likelihood,
    });
  }

  const mergedSourceUrls = Array.from(new Set([
    ...(Array.isArray(brief?.sourceUrls) ? brief.sourceUrls : []),
    ...rescueSources.map((source) => source?.url).filter(Boolean),
  ])).slice(0, 8);

  return {
    ...brief,
    sourceUrls: mergedSourceUrls,
    discoveryContext: mergedContext,
  };
}

const RESCUE_ENTITY_STOP_WORDS = new Set([
  'unspecified', 'latest', 'breaking', 'report', 'reports', 'analysis', 'story', 'stories', 'news', 'update', 'updates',
  'amid', 'after', 'before', 'under', 'with', 'without', 'from', 'into', 'over', 'about', 'global', 'policy', 'decision',
  'development', 'event', 'market', 'markets', 'economy', 'economic', 'law', 'laws', 'approved', 'approval', 'approvals',
  'transfer', 'transfers', 'earnings', 'outlook', 'climate', 'goals', 'crisis', 'debate', 'battle', 'truths', 'hard',
  'qna', 'question', 'explainer',
]);

const RESCUE_ENTITY_ACTION_WORDS = new Set([
  'transfer', 'transfers', 'trading', 'trade', 'earnings', 'results', 'outlook', 'debate', 'crisis', 'law', 'bill',
  'approval', 'approved', 'regulation', 'sanctions', 'attack', 'war', 'ceasefire', 'investigation', 'probe', 'lawsuit',
  'ruling', 'verdict', 'filing', 'report', 'reports', 'analysis', 'update', 'updates', 'reset', 'strategic', 'bet',
  'policy', 'development', 'growth', 'decline', 'rise', 'fall',
]);

const RESCUE_ENTITY_ORG_HINTS = /(inc|corp|corporation|co|company|ltd|llc|plc|group|holdings|university|agency|ministry|department|court|federation|association|committee|league|team|fc|bank|fund|authority)$/i;
const RESCUE_ENTITY_PLACE_HINTS = /(city|state|province|county|island|district|republic|kingdom|gaza|israel|iran|ukraine|russia|china|india|europe|america)$/i;

function inferRescueEntityProfile(brief = {}) {
  const diagnostics = [];
  const candidates = [];
  const title = String(brief?.title || '').trim();
  const sourceTitles = Array.isArray(brief?.discoveryContext)
    ? brief.discoveryContext.map((item) => String(item?.title || '').trim()).filter(Boolean)
    : [];

  const seedValues = [
    ...(Array.isArray(brief?.entities) ? brief.entities : []),
    ...(Array.isArray(brief?.involvedParties) ? brief.involvedParties : []),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const value of seedValues) {
    const normalized = normalizeEntityPhrase(value);
    if (!normalized) continue;
    candidates.push({
      phrase: normalized,
      source: 'brief_entities',
      score: 7,
      pattern: detectEntityPattern(normalized),
    });
  }

  const titlePhrases = extractCapitalizedEntityPhrases(title);
  for (const phrase of titlePhrases) {
    const normalized = normalizeEntityPhrase(phrase);
    if (!normalized) continue;
    candidates.push({
      phrase: normalized,
      source: 'title_phrase',
      score: 8,
      pattern: detectEntityPattern(normalized),
    });
  }
  if (titlePhrases.length > 0) diagnostics.push('entity_inferred_from_title');

  const sourcePhraseCounts = new Map();
  for (const sourceTitle of sourceTitles) {
    for (const phrase of extractCapitalizedEntityPhrases(sourceTitle)) {
      const normalized = normalizeEntityPhrase(phrase);
      if (!normalized) continue;
      sourcePhraseCounts.set(normalized, (sourcePhraseCounts.get(normalized) || 0) + 1);
      candidates.push({
        phrase: normalized,
        source: 'source_title',
        score: 5,
        pattern: detectEntityPattern(normalized),
      });
    }
  }
  if (sourcePhraseCounts.size > 0) diagnostics.push('entity_inferred_from_sources');

  const titleTokenPhrases = extractSignatureEntityCandidates(title);
  for (const phrase of titleTokenPhrases) {
    const normalized = normalizeEntityPhrase(phrase);
    if (!normalized) continue;
    candidates.push({
      phrase: normalized,
      source: 'signature_tokens',
      score: 4,
      pattern: detectEntityPattern(normalized),
    });
  }

  const grouped = groupEntityCandidates(candidates);
  const ranked = Array.from(grouped.values())
    .map((group) => ({
      ...group,
      boostedScore: computeEntityGroupScore(group, sourcePhraseCounts),
    }))
    .sort((left, right) => right.boostedScore - left.boostedScore);

  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const aliasCollision = !!(top && second && top.boostedScore > 0 && second.boostedScore >= top.boostedScore * 0.8);
  if (aliasCollision) diagnostics.push('entity_alias_collision');

  const canonical = top?.canonical || 'Unspecified';
  const aliases = top
    ? Array.from(new Set([top.canonical, ...(top.aliases || [])])).filter((alias) => alias && alias !== 'Unspecified').slice(0, 4)
    : [];
  const confidence = classifyEntityConfidence(top, second);
  if (confidence === 'low') diagnostics.push('entity_confidence_low');

  return {
    canonical,
    aliases,
    confidence,
    diagnostics: Array.from(new Set(diagnostics)),
    evidence: {
      candidate_groups: ranked.length,
      top_score: Number(top?.boostedScore || 0),
      second_score: Number(second?.boostedScore || 0),
      source_support: Number(top?.sourceSupport || 0),
      title_support: Number(top?.titleSupport || 0),
      pattern: top?.pattern || 'unknown',
    },
  };
}

function groupEntityCandidates(candidates = []) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = normalizeEntityAliasKey(candidate?.phrase || '');
    if (!key) continue;
    const existing = grouped.get(key) || {
      key,
      canonical: candidate.phrase,
      aliases: [],
      score: 0,
      sourceSupport: 0,
      titleSupport: 0,
      pattern: candidate.pattern || 'unknown',
      fromSources: new Set(),
    };

    existing.score += Number(candidate?.score || 0);
    existing.aliases.push(candidate.phrase);
    existing.fromSources.add(candidate.source || 'unknown');
    if (candidate.source === 'source_title') existing.sourceSupport += 1;
    if (candidate.source === 'title_phrase' || candidate.source === 'signature_tokens') existing.titleSupport += 1;
    if (existing.canonical.length < candidate.phrase.length) existing.canonical = candidate.phrase;
    if (candidate.pattern && candidate.pattern !== 'unknown') existing.pattern = candidate.pattern;
    grouped.set(key, existing);
  }

  for (const [key, value] of grouped.entries()) {
    grouped.set(key, {
      ...value,
      aliases: Array.from(new Set(value.aliases)).slice(0, 6),
      sourceKinds: Array.from(value.fromSources),
    });
  }
  return grouped;
}

function computeEntityGroupScore(group = {}, sourcePhraseCounts = new Map()) {
  const baseScore = Number(group.score || 0);
  const sourceBoost = Number(group.sourceSupport || 0) * 1.8;
  const titleBoost = Number(group.titleSupport || 0) * 1.6;
  const patternBoost = group.pattern === 'organization' ? 3 : group.pattern === 'person' ? 2.5 : group.pattern === 'place' ? 2 : 0.8;
  const repeatedBoost = Number(sourcePhraseCounts.get(group.canonical) || 0) * 1.5;
  return Math.round((baseScore + sourceBoost + titleBoost + patternBoost + repeatedBoost) * 10) / 10;
}

function classifyEntityConfidence(top = null, second = null) {
  if (!top || !top.canonical || top.canonical === 'Unspecified') return 'low';
  const topScore = Number(top.boostedScore || 0);
  const secondScore = Number(second?.boostedScore || 0);
  const margin = topScore - secondScore;
  if (topScore >= 17 && margin >= 4 && (Number(top.sourceSupport || 0) >= 1 || Number(top.titleSupport || 0) >= 2)) return 'high';
  if (topScore >= 10 && margin >= 1.5) return 'medium';
  return 'low';
}

function normalizeEntityPhrase(value = '') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const cleaned = stripEntityActionWords(raw)
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokenized = cleaned.split(/\s+/).filter(Boolean);
  if (tokenized.length === 0) return '';
  const usefulTokens = tokenized.filter((token) => !RESCUE_ENTITY_STOP_WORDS.has(token.toLowerCase()));
  if (usefulTokens.length === 0) return '';
  const phrase = usefulTokens.join(' ');
  if (phrase.length < 3) return '';
  if (/^unspecified$/i.test(phrase)) return '';
  return phrase;
}

function stripEntityActionWords(value = '') {
  const tokens = String(value || '').split(/\s+/).filter(Boolean);
  let start = 0;
  let end = tokens.length;
  while (start < end && RESCUE_ENTITY_ACTION_WORDS.has(tokens[start].toLowerCase())) start += 1;
  while (end > start && RESCUE_ENTITY_ACTION_WORDS.has(tokens[end - 1].toLowerCase())) end -= 1;
  const kept = tokens.slice(start, end);
  return kept.join(' ');
}

function normalizeEntityAliasKey(value = '') {
  const clean = normalizeEntityPhrase(value)
    .toLowerCase()
    .replace(/\b(inc|corp|corporation|co|company|ltd|llc|plc|group|holdings|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean;
}

function extractCapitalizedEntityPhrases(text = '') {
  const source = String(text || '');
  const regex = /\b([A-Z][A-Za-z0-9&'.-]*(?:\s+(?:[A-Z][A-Za-z0-9&'.-]*|[A-Z]{2,5}|of|the|and|&)){0,4})\b/g;
  const phrases = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    const phrase = String(match[1] || '').trim();
    if (!phrase) continue;
    if (phrase.split(/\s+/).length < 1) continue;
    phrases.push(phrase);
  }
  return Array.from(new Set(phrases));
}

function extractSignatureEntityCandidates(text = '') {
  const tokens = String(text || '')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const candidates = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (isCapitalizedToken(left) && isCapitalizedToken(right)) {
      candidates.push(`${left} ${right}`);
    }
  }
  return Array.from(new Set(candidates));
}

function isCapitalizedToken(token = '') {
  if (!token) return false;
  if (/^[A-Z]{2,6}$/.test(token)) return true;
  return /^[A-Z][a-z0-9]/.test(token);
}

function detectEntityPattern(phrase = '') {
  const value = String(phrase || '').trim();
  if (!value) return 'unknown';
  if (RESCUE_ENTITY_ORG_HINTS.test(value)) return 'organization';
  if (RESCUE_ENTITY_PLACE_HINTS.test(value)) return 'place';
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(value)) return 'person';
  if (/^[A-Z]{2,6}(?:\s+[A-Z]{2,6})*$/.test(value)) return 'organization';
  return 'unknown';
}

function inferRescueEventType(brief = {}) {
  const text = `${brief?.title || ''} ${brief?.whatHappened || ''} ${brief?.angle || ''}`.toLowerCase();
  if (/(court|judge|lawsuit|legal|ruling|verdict|indicted|charged)/.test(text)) return 'legal event';
  if (/(regulat|agency|approved|approval|ban|policy|bill|law)/.test(text)) return 'policy decision';
  if (/(earnings|revenue|profit|stocks|investor|ipo|market)/.test(text)) return 'market development';
  if (/(league|team|match|tournament|transfer|coach)/.test(text)) return 'sports development';
  if (/(study|research|trial|journal|university)/.test(text)) return 'research update';
  return 'developing event';
}

function extractBriefDateToken(brief = {}) {
  const raw = brief?.when || brief?.discoveredAt || brief?.updatedAt || '';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function buildBroadRescueTopic(brief = {}) {
  const tokens = String(`${brief?.title || ''} ${brief?.whyItMatters || ''}`)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !['latest', 'breaking', 'report', 'reports', 'update', 'today', 'story', 'analysis', 'question'].includes(token));
  return Array.from(new Set(tokens)).slice(0, 5).join(' ');
}

function buildRescueOfficialDomainTargets(brief = {}, { requireOfficial = false, entityProfile = null } = {}) {
  const domains = new Set();
  const entity = entityProfile || inferRescueEntityProfile(brief);
  const entityTokens = tokenizeEntityCore(entity?.canonical || '');
  const entityAliasTokens = new Set((entity?.aliases || []).flatMap((alias) => tokenizeEntityCore(alias)));
  const eventType = inferRescueEventType(brief);
  if (requireOfficial) {
    for (const domain of OFFICIAL_PRIMARY_DOMAINS) domains.add(domain);
    for (const domain of OFFICIAL_CONTEXT_DOMAINS) domains.add(domain);
  } else if (/(sports development|research update)/.test(String(eventType || ''))) {
    for (const domain of OFFICIAL_CONTEXT_DOMAINS) domains.add(domain);
  }

  const sourceUrls = [
    ...(Array.isArray(brief?.sourceUrls) ? brief.sourceUrls : []),
    ...(Array.isArray(brief?.discoveryContext) ? brief.discoveryContext.map((item) => ({
      url: item?.url || item?.link || item?.sourceUrls?.[0] || '',
      title: item?.title || '',
      summary: item?.summary || item?.snippet || '',
    })) : []),
  ].filter(Boolean);

  for (const raw of sourceUrls) {
    const item = typeof raw === 'string' ? { url: raw, title: '', summary: '' } : raw;
    const domain = normalizeDomain(item?.url || '');
    if (!domain) continue;
    if (/\.(gov|mil|edu)$/.test(domain)) domains.add(domain);
    if (/(court|agency|ministry|regulator|university|journal|league|team|investor|newsroom|ir\.)/.test(domain)) {
      domains.add(domain);
    }
    const domainTokens = new Set(domain.split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3));
    const titleTokens = new Set(String(`${item?.title || ''} ${item?.summary || ''}`).toLowerCase().split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3));
    const hasEntityInDomain = Array.from(entityTokens).some((token) => domainTokens.has(token) || domain.includes(token));
    const hasEntityInTitle = Array.from(entityTokens).some((token) => titleTokens.has(token));
    const hasAliasSignal = Array.from(entityAliasTokens).some((token) => titleTokens.has(token) || domainTokens.has(token));
    if ((hasEntityInDomain || hasEntityInTitle || hasAliasSignal) && /(newsroom|press|media|investor|relations|court|agency|ministry|official|gov|edu|league|team|university|journal|regulator)/.test(domain)) {
      domains.add(domain);
    }
  }

  return Array.from(domains).slice(0, 8);
}

function compactRescueText(value = '', maxTokens = 24) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxTokens)
    .join(' ')
    .trim();
}

function buildRescueQueryDedupeKey(provider = '', query = '', level = '', intent = '') {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedLevel = String(level || '').trim().toLowerCase();
  const normalizedIntent = String(intent || '').trim().toLowerCase();
  const normalizedQuery = String(query || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalizedProvider}::${normalizedLevel}::${normalizedIntent}::${normalizedQuery}`;
}

function shouldSkipDuplicateRescueQuery(provider = '', query = '', level = '', intent = '') {
  const key = buildRescueQueryDedupeKey(provider, query, level, intent);
  const entry = RECENT_RESCUE_QUERY_USAGE.get(key);
  if (!entry) return false;
  const ageMs = Date.now() - Number(entry?.ts || 0);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= RESCUE_QUERY_DEDUPE_TTL_MS;
}

function recordRescueQueryUsage(provider = '', query = '', level = '', intent = '', status = '') {
  const key = buildRescueQueryDedupeKey(provider, query, level, intent);
  RECENT_RESCUE_QUERY_USAGE.set(key, {
    ts: Date.now(),
    status: String(status || '').toLowerCase(),
  });
  if (RECENT_RESCUE_QUERY_USAGE.size > 1500) {
    const entries = Array.from(RECENT_RESCUE_QUERY_USAGE.entries())
      .sort((left, right) => Number(left?.[1]?.ts || 0) - Number(right?.[1]?.ts || 0));
    while (entries.length > 1200) {
      const oldest = entries.shift();
      if (!oldest) break;
      RECENT_RESCUE_QUERY_USAGE.delete(oldest[0]);
    }
  }
}

function estimateSourcePackCoherence(sourcePack = {}, brief = {}) {
  const sources = Array.isArray(sourcePack?.sources) ? sourcePack.sources : [];
  if (sources.length === 0) return 0;
  const entityProfile = inferRescueEntityProfile(brief);
  const scores = sources.map((source) => computeRescueEntityCoherence(source, brief, entityProfile));
  const avg = scores.reduce((sum, value) => sum + value, 0) / Math.max(scores.length, 1);
  return Math.round(avg * 100) / 100;
}

function titleTokensForCoherence(value = '') {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'amid', 'from', 'that', 'this', 'into', 'after', 'over', 'under',
    'have', 'has', 'had', 'will', 'would', 'could', 'should', 'latest', 'breaking', 'news', 'report',
    'reports', 'live', 'updates', 'today', 'story', 'stories',
  ]);
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stop.has(token))
  );
}

function normalizeRescueUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

function looksLikeOfficialPrimarySource(source = {}) {
  const text = `${source?.title || ''} ${source?.snippet || ''}`.toLowerCase();
  const url = String(source?.canonical_url || source?.url || '').toLowerCase();
  if (/(official statement|press release|court filing|regulator|agency announcement|investor relations)/.test(text)) return true;
  if (/(\/press\/|\/newsroom\/|\/investor-relations\/|\/ir\/|\/statement\/|\/filing\/|\/releases\/)/.test(url)) return true;
  return false;
}


function getBriefCandidateKey(brief = {}) {
  const sourceUrl = Array.isArray(brief.sourceUrls) && brief.sourceUrls.length > 0 ? String(brief.sourceUrls[0]) : '';
  return [
    brief.poolIdentityKey || '',
    brief.id || '',
    brief.cluster_id || '',
    brief.eventKey || '',
    brief.title || '',
    sourceUrl,
  ].join('::');
}


function parseArticleInventoryRows(markdown) {
  return String(markdown || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .filter((line) => !/^\|[-\s|]+\|$/.test(line.trim()))
    .filter((line) => !/^\|\s*Article ID\s*\|/i.test(line.trim()))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 12)
    .map((cells) => ({
      article_id: cells[0],
      topic_id: cells[1],
      title: cells[2],
      created: cells[3],
      status: cells[5],
      section: cells[6],
      article_type: cells[7],
      primary_topic: cells[8],
      key_entities: String(cells[9] || '').split(',').map((value) => value.trim()).filter(Boolean),
      search_keywords: String(cells[10] || '').split(',').map((value) => value.trim()).filter(Boolean),
      canonical_url: cells[11],
    }));
}

function selectionTokens(value) {
  const stop = new Set(['the','a','an','and','or','for','with','from','into','amid','after','before','over','under','latest','breaking','news','report','reports','live','updates','today','story','stories','key']);
  return Array.from(new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stop.has(token))));
}

function overlapCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function getCandidateSelectionTopicId(candidate) {
  return String(candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || '').trim().toLowerCase();
}

function loadRecentPublishedInventory() {
  try {
    if (!fs.existsSync(ARTICLE_INVENTORY_PATH)) return [];
    return parseArticleInventoryRows(fs.readFileSync(ARTICLE_INVENTORY_PATH, 'utf-8'))
      .filter((entry) => String(entry.status || '').toLowerCase() === 'published')
      .filter((entry) => {
        const createdMs = new Date(`${entry.created}T00:00:00Z`).getTime();
        return Number.isFinite(createdMs) && (Date.now() - createdMs) <= RECENT_DUPLICATE_WINDOW_MS;
      });
  } catch {
    return [];
  }
}

function isRecentDuplicateCandidate(candidate, inventoryEntries) {
  const brief = candidate?.brief || {};
  const sourcePack = candidate?.sourcePack || {};
  const titleTokens = selectionTokens(brief.title);
  const entityTokens = selectionTokens((brief.entities || brief.involvedParties || []).join(' '));
  const searchTokens = Array.from(new Set([
    ...titleTokens,
    ...selectionTokens(sourcePack?.topic || ''),
    ...selectionTokens(brief.whatHappened || ''),
    ...selectionTokens((brief.entities || brief.involvedParties || []).join(' ')),
  ]));
  const topicId = getCandidateSelectionTopicId(candidate);

  let bestMatch = null;
  let bestScore = -Infinity;

  for (const entry of inventoryEntries) {
    const entryTitleTokens = selectionTokens(entry.title);
    const entryKeywordTokens = selectionTokens((entry.search_keywords || []).join(' '));
    const entryEntityTokens = selectionTokens((entry.key_entities || []).join(' '));
    const titleOverlap = overlapCount(titleTokens, entryTitleTokens);
    const keywordOverlap = overlapCount(searchTokens, entryKeywordTokens);
    const entityOverlap = overlapCount(entityTokens, entryEntityTokens);
    const sameTopic = topicId && topicId === String(entry.topic_id || '').trim().toLowerCase();

    let score = 0;
    if (titleOverlap >= 4) score = Math.max(score, 100);
    if (sameTopic && titleOverlap >= 3) score = Math.max(score, 95);
    if (sameTopic && titleOverlap >= 2 && entityOverlap >= 1) score = Math.max(score, 90);
    if (sameTopic && titleOverlap >= 2 && keywordOverlap >= 2) score = Math.max(score, 85);
    if (sameTopic && keywordOverlap >= 3 && entityOverlap >= 1) score = Math.max(score, 85);
    if (titleOverlap >= 3 && keywordOverlap >= 3) score = Math.max(score, 80);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        entry,
        score,
        details: {
          titleOverlap,
          keywordOverlap,
          entityOverlap,
          sameTopic,
        },
      };
    }
  }

  return bestScore >= 80 ? bestMatch : null;
}

function filterRecentDuplicateCandidates(candidates) {
  const recentInventory = loadRecentPublishedInventory();
  if (!recentInventory.length) {
    return {
      candidates: Array.isArray(candidates) ? candidates : [],
      rejected: [],
      inventorySize: 0,
    };
  }

  const kept = [];
  const rejected = [];
  for (const candidate of (Array.isArray(candidates) ? candidates : [])) {
    const match = isRecentDuplicateCandidate(candidate, recentInventory);
    if (!match) {
      kept.push(candidate);
      continue;
    }
    rejected.push({
      candidateTitle: candidate?.brief?.title || candidate?.sourcePack?.topic || null,
      candidateTopicId: getCandidateSelectionTopicId(candidate) || null,
      matchedEntry: {
        article_id: match.entry?.article_id || null,
        topic_id: match.entry?.topic_id || null,
        title: match.entry?.title || null,
        created: match.entry?.created || null,
        canonical_url: match.entry?.canonical_url || null,
      },
      score: match.score,
      details: match.details,
    });
  }

  return {
    candidates: kept,
    rejected,
    inventorySize: recentInventory.length,
  };
}

