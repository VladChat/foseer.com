// File: qwen-scripts/pipeline.js
// Purpose: Main pipeline runner - ties together all stages with correct execution order and honest success reporting
// End-to-end editorial pipeline from discovery to published article with verification

import fs from 'node:fs';
import path from 'node:path';

import { runDiscovery } from './discovery.js';
import { selectBestTopic } from './event-brief-builder.js';
import { createClaimMap, validateClaimMap } from './claim-map.js';
import { draftArticle, hardenDraft } from './article-drafter.js';
import { generateImagePackage } from './nodes/image-node.js';
import { enrichCandidateWithVideo } from './nodes/youtube-enrichment-node.js';
import { publishArticle } from './publisher.js';
import { validatePrePublishGraph, buildCanonicalPublishPayload, buildPublishManifest, writePublishManifest, validatePublishedArtifact } from './validate-publish-graph.js';
import { validateTagSelection } from './validate-tags.js';
import { resolvePlacementMetadata } from '../qwen-project-governance/shared/article-placement.js';
import { repairContentPosts } from './repair-content-posts.js';
import { verifyLocalVisibility, generateVerificationReport } from './local-verification.js';
import { getProviderStats } from './utils/api-clients.js';
import { mergeBriefsIntoPool, mergeDiscoveredNews, getSelectableBriefs, getReadySelectableBriefs, dedupeBriefCandidates, markBriefPublished, markBriefSelected, getNewsPoolStats, recordReadyArticleCandidates, getBriefIdentityKey, isIdentityAlreadyPublished } from './utils/news-pool.js';
import { writeQualityAuditRun } from './utils/quality-audit.js';
import { runSharedSourcePackEngine, selectSharedPreWriterCandidates, normalizeDiscoveryCandidatesToBriefs, estimateSourcePackCoherence } from './pre-writer-engine.js';
import { evaluatePreWriteQualityGate } from './pre-write-quality-gate.js';
import { attemptImageRescuePass, hasImageTopicMismatchError } from './utils/publish-rescue.js';
import { runPreDraftGates } from './utils/pre-draft-gate.js';
import { resolvePipelineMode } from './utils/pipeline-mode.js';

loadProjectEnv();

/**
 * Pipeline stage result
 * @typedef {Object} StageResult
 * @property {string} stage - Stage name
 * @property {boolean} success - Whether stage succeeded
 * @property {string|null} error - Error message if failed
 * @property {Object|null} data - Stage output data
 */

/**
 * Pipeline final result
 * @typedef {Object} PipelineResult
 * @property {boolean} success - Overall success
 * @property {string|null} hard_blocker - Reason for failure if not success
 * @property {string|null} published_path - Path to published file if successful
 * @property {string|null} verified_url - Verified article URL if successful
 * @property {Object} stages - Individual stage results
 * @property {Object} selected - Selected topic with brief and source pack
 * @property {Object} stats - Pipeline statistics
 */

/**
 * Run the full editorial pipeline with correct execution order
 * Execution order:
 *   1. Discovery
 *   2. Event Brief Normalization
 *   3. Source Pack Assembly (GATE: must pass)
 *   3.5 Pre-draft Canonical Lock (taxonomy + tags, GATE: must pass)
 *   4. Claim Map Creation (GATE: must pass)
 *   5. Article Drafting
 *   6. Image Support
 *   7. YouTube Enrichment (non-blocking, optional)
 *   8. Publish Article (GATE: must succeed)
 *   9. Verify Local Visibility (GATE for local/dev runs, CI-safe skip online)
 * 
 * @param {Object} options - Pipeline options
 * @returns {Promise<PipelineResult>} Pipeline result with honest success reporting
 */
export async function runEditorialPipeline(options = {}) {
  console.log('[pipeline] Starting editorial pipeline...');
  const startTime = Date.now();

  const stats = {
    discovery_candidates: 0,
    discovery_channels: null,
    discovery_rss_feeds_polled: 0,
    discovery_rss_items_seen: 0,
    discovery_rss_items_accepted: 0,
    discovery_rss_feed_failures: 0,
    event_clusters: 0,
    briefs_normalized: 0,
    source_packs_assembled: 0,
    publishable_candidates: 0,
    min_articles_target: 1,
    selected_topic: null,
    selected_topics: [],
    articles_attempted: 0,
    articles_published: 0,
    news_pool: null,
    cache_stats: null,
    duration_ms: 0,
    ready_candidates: 0,
    additional_ready_candidates: 0,
    source_pack_attempts: 0,
    source_pack_retry_external_queries: 0,
    source_pack_retry_brave_queries: 0,
    source_pack_retry_estimated_tokens: 0,
    pre_draft_rejected: 0,
  };

  const stageResults = {
    discovery: null,
    briefNormalization: null,
    sourcePackAssembly: null,
    preDraftPreparation: null,
    claimMapCreation: null,
    articleDrafting: null,
    imageSupport: null,
    youtubeEnrichment: null,
    publishing: null,
    localVerification: null,
  };

  const runId = `pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = new Date(startTime).toISOString();
  const workflowLeaseOwner = {
    workflow: String(process.env.GITHUB_WORKFLOW || 'Article Pipeline').trim() || 'Article Pipeline',
    runId: String(process.env.GITHUB_RUN_ID || runId).trim() || runId,
    leaseMinutes: Number(options.selectionLeaseMinutes || process.env.SELECTION_LEASE_MINUTES || 75),
  };

  const finalizePipelineResult = (success, hardBlocker, selectedPayload = null, extras = {}) => {
    stats.cache_stats = getProviderStats();
    stats.duration_ms = Date.now() - startTime;
    const result = buildPipelineResult(success, hardBlocker, publishedPath, verifiedUrl, stageResults, selectedPayload, stats, extras);
    const auditPath = writeQualityAuditRun({
      runId,
      startedAt,
      stats,
      stageResults,
      selectedCandidates: extras.selected_candidates || selectedCandidates,
      publishedArticles: extras.published_articles || publishedArticles,
      providerStats: stats.cache_stats,
      success,
      hardBlocker,
    });
    result.quality_audit_path = auditPath;
    result.stats.quality_audit_path = auditPath;
    return result;
  };

  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const pexelsApiKey = process.env.PEXELS_API_KEY;
  const unsplashApiKey = process.env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_API_KEY;
  const pixabayApiKey = process.env.PIXABAY_API_KEY;
  const googleApiKey = process.env.SEARCH_WEB_API;
  const googleCx = process.env.SEARCH_WEB_CX;

  console.log('[pipeline] API keys loaded:', {
    brave: !!braveApiKey,
    openai: !!openAiApiKey,
    pexels: !!pexelsApiKey,
    unsplash: !!unsplashApiKey,
    pixabay: !!pixabayApiKey,
    google: !!googleApiKey && !!googleCx,
  });

  options.pipelineMode = resolvePipelineMode(options);
  options.preWriteGate = {
    pipelineMode: options.pipelineMode,
    ...(options.preWriteGate || {}),
  };
  const maxArticlesPerRun = resolveMaxArticlesPerRun(options);
  const minArticlesTarget = resolveMinArticlesTarget(options, maxArticlesPerRun);
  stats.min_articles_target = minArticlesTarget;
  console.log(`[pipeline] Run mode: ${options.pipelineMode}`);
  console.log(`[pipeline] Max articles per run: ${maxArticlesPerRun}`);
  console.log(`[pipeline] Min articles target: ${minArticlesTarget}`);
  const localVerificationEnabled = resolveLocalVerificationEnabled(options);
  console.log(`[pipeline] Local verification enabled: ${localVerificationEnabled}`);

  let selected = null;
  let selectedCandidates = [];
  let publishedPath = null;
  let verifiedUrl = null;
  const publishedPaths = [];
  const verifiedUrls = [];
  const publishedArticles = [];

  let discoveryResult = null;
  let normalizedBriefs = null;

  const repairResult = repairContentPosts();
  if (repairResult.changed > 0) {
    console.log(`[pipeline] Preflight content repair: changed=${repairResult.changed} removed_sources=${repairResult.removedSources}`);
  }

  // Stage 1: Discovery
  console.log('[pipeline] Stage 1: Discovery...');
  try {
    discoveryResult = await runDiscovery({ ...options, braveApiKey, googleApiKey, googleCx });
    stats.discovery_candidates = discoveryResult.candidates.length;
    const discoveryChannelStats = extractDiscoveryChannelStats(discoveryResult.stats);
    const discoveryRssStats = extractDiscoveryRssStats(discoveryResult.stats);
    stats.discovery_channels = discoveryChannelStats;
    stats.discovery_rss_feeds_polled = discoveryRssStats.feeds_polled;
    stats.discovery_rss_items_seen = discoveryRssStats.items_seen;
    stats.discovery_rss_items_accepted = discoveryRssStats.items_accepted;
    stats.discovery_rss_feed_failures = discoveryRssStats.feed_failures;
    console.log(`[pipeline] Discovery found ${stats.discovery_candidates} candidates`);

    const discoveredPoolStats = mergeDiscoveredNews(discoveryResult.candidates);
    stageResults.discovery = {
      stage: 'discovery',
      success: discoveryResult.candidates.length > 0,
      error: discoveryResult.candidates.length === 0 ? 'No candidates discovered' : null,
      data: {
        candidatesCount: discoveryResult.candidates.length,
        discoveredPoolTotal: discoveredPoolStats.total,
        queryUsage: extractDiscoveryQueryUsage(discoveryResult.stats),
        channelStats: discoveryChannelStats,
        rssStats: discoveryRssStats,
        targetedCoverage: discoveryResult.stats?.targeted_coverage || null,
      },
    };

    if (stats.discovery_candidates === 0) {
      return finalizePipelineResult(false, 'No candidates discovered', null, {
        published_paths: [],
        verified_urls: [],
        selected_candidates: [],
        published_articles: [],
      });
    }
  } catch (error) {
    console.error(`[pipeline] Discovery failed: ${error.message}`);
    stageResults.discovery = {
      stage: 'discovery',
      success: false,
      error: error.message,
      data: null,
    };
    return finalizePipelineResult(false, `Discovery failed: ${error.message}`, null, {
      published_paths: [],
      verified_urls: [],
      selected_candidates: [],
      published_articles: [],
    });
  }

  // Stage 2: Event Clustering + Brief Normalization
  console.log('[pipeline] Stage 2: Event clustering and brief normalization...');
  try {
    const normalizationResult = await normalizeDiscoveryCandidatesToBriefs(
      discoveryResult.candidates,
      {
        clusterThreshold: options.clusterThreshold || 6,
        clusterSelectionLimit: options.clusterSelectionLimit || 6,
      },
      openAiApiKey,
    );
    normalizedBriefs = Array.isArray(normalizationResult?.briefs) ? normalizationResult.briefs : [];
    stats.event_clusters = Number(normalizationResult?.clusterCount || 0);
    stats.briefs_normalized += normalizedBriefs.length;

    if (normalizedBriefs.length > 1) {
      const best = selectBestTopic(normalizedBriefs);
      normalizedBriefs = [best, ...normalizedBriefs.filter((brief) => brief.id !== best.id)];
    }

    console.log(`[pipeline] Clustered ${stats.event_clusters} events and normalized ${stats.briefs_normalized} briefs`);

    stageResults.briefNormalization = {
      stage: 'briefNormalization',
      success: normalizedBriefs.length > 0,
      error: normalizedBriefs.length === 0 ? 'No briefs normalized' : null,
      data: { briefsCount: normalizedBriefs.length, clusterCount: stats.event_clusters },
    };

    if (normalizedBriefs.length === 0) {
      return finalizePipelineResult(false, 'No briefs normalized', null, {
        published_paths: [],
        verified_urls: [],
        selected_candidates: [],
        published_articles: [],
      });
    }

    const poolState = mergeBriefsIntoPool(normalizedBriefs);
    stats.news_pool = getNewsPoolStats(poolState);
    console.log(`[pipeline] News pool active: ${stats.news_pool.active}, total stored: ${stats.news_pool.total}`);
  } catch (error) {
    console.error(`[pipeline] Brief normalization failed: ${error.message}`);
    stageResults.briefNormalization = {
      stage: 'briefNormalization',
      success: false,
      error: error.message,
      data: null,
    };
    return finalizePipelineResult(false, `Brief normalization failed: ${error.message}`, null, {
      published_paths: [],
      verified_urls: [],
      selected_candidates: [],
      published_articles: [],
    });
  }

  // Stage 3: Source Pack Assembly (GATE)
  console.log('[pipeline] Stage 3: Source pack assembly...');
  try {
    const retryPolicy = resolveSourcePackRetryPolicy(options);
    const retryDiagnostics = [];
    const duplicateRejectedAtSelection = [];
    const stage3AttemptSummaries = [];
    const sourcePackSelectionCandidateLimit = Math.max(
      Number(options.sourcePackSelectionCandidateLimit || 0) || 0,
      maxArticlesPerRun * 4,
      6,
    );
    const stage3Options = {
      ...options,
      maxArticlesPerRunForSourcePackSelection: sourcePackSelectionCandidateLimit,
    };
    const retryUsage = {
      external_queries: 0,
      brave_queries: 0,
      estimated_tokens: 0,
    };
    const ESTIMATED_TOKENS_PER_RETRY_BRIEF = 900;
    const MIN_TOKENS_FOR_RETRY = 600;
    let candidateSetForSelection = [];
    let readyBacklog = {
      readyCount: 0,
      additionalReadyCandidates: [],
      selectedCandidates: [],
      filePath: null,
    };
    let seedBriefs = Array.isArray(normalizedBriefs) ? normalizedBriefs.slice() : [];
    const selectionLimits = {
      maxPerSection: Number(options.maxPerSection || 2),
      maxPerTopic: Number(options.maxPerTopic || 2),
      relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
      relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
    };

    const getStage3CandidateKey = (candidate = {}) => {
      const identity = candidate?.brief?.poolIdentityKey
        || candidate?.brief?.id
        || candidate?.sourcePack?.eventId
        || candidate?.brief?.cluster_id
        || candidate?.brief?.clusterId;
      if (identity) return String(identity);
      return normalizeTitle(candidate?.brief?.title || candidate?.sourcePack?.topic || '');
    };

    const scoreStage3Candidate = (candidate = {}) => {
      const metrics = candidate?.sourcePack?.metrics || {};
      const baseScore = Number(candidate?.brief?.selectionScore || 0);
      const core = Number(metrics.coreSourceCount || 0);
      const supporting = Number(metrics.supportingSourceCount || 0);
      const uniqueDomains = Number(candidate?.sourcePack?.uniqueDomains || metrics.uniqueDomains || 0);
      const directEvent = Number(metrics.directEventSourceCount || 0);
      const independentDomains = Number(metrics.independentEventDomains || 0);
      const consistency = Number(metrics.sourceConsistencyScore || 0);
      return baseScore
        + (core * 20)
        + (supporting * 12)
        + (uniqueDomains * 8)
        + (directEvent * 10)
        + (independentDomains * 8)
        + consistency;
    };

    const mergeSelectedCandidatesAcrossAttempts = (current = [], incoming = []) => {
      const byKey = new Map();
      const ingest = (candidate) => {
        if (!candidate) return;
        const key = getStage3CandidateKey(candidate);
        if (!key) return;
        const score = scoreStage3Candidate(candidate);
        const existing = byKey.get(key);
        if (!existing || score > existing.score) {
          byKey.set(key, { candidate, score });
        }
      };

      for (const candidate of (Array.isArray(current) ? current : [])) ingest(candidate);
      for (const candidate of (Array.isArray(incoming) ? incoming : [])) ingest(candidate);

      const mergedPool = Array.from(byKey.values())
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.candidate);

      return selectSharedPreWriterCandidates(mergedPool, {
        maxSelectionCount: maxArticlesPerRun,
        selectionLimits,
      });
    };

    const runStage3Attempt = async (attemptLabel) => {
      const attemptResult = await runSourcePackAssemblyAttempt({
        briefsSeed: seedBriefs,
        options: stage3Options,
        maxArticlesPerRun,
        braveApiKey,
        googleApiKey,
        googleCx,
        leaseOwner: workflowLeaseOwner,
      });
      stats.source_packs_assembled += Number(attemptResult.sourcePacksAssembled || 0);
      stats.publishable_candidates = Math.max(
        Number(stats.publishable_candidates || 0),
        Number(attemptResult.publishableCandidates || 0),
      );
      stats.source_pack_attempts += 1;

      candidateSetForSelection = Array.isArray(attemptResult.candidatesWithSources) ? attemptResult.candidatesWithSources : [];
      readyBacklog = attemptResult.readyBacklog || readyBacklog;
      const attemptSelectedCandidates = Array.isArray(attemptResult.selectedCandidates) ? attemptResult.selectedCandidates : [];
      selectedCandidates = mergeSelectedCandidatesAcrossAttempts(selectedCandidates, attemptSelectedCandidates);
      selected = selectedCandidates[0] || null;

      for (const entry of attemptResult.duplicateRejectedAtSelection || []) {
        duplicateRejectedAtSelection.push({
          ...entry,
          attempt: attemptLabel,
        });
      }

      stage3AttemptSummaries.push({
        attempt: attemptLabel,
        source_packs_assembled: Number(attemptResult.sourcePacksAssembled || 0),
        publishable_candidates: Number(attemptResult.publishableCandidates || 0),
        selected_candidates: selectedCandidates.length,
        selected_candidates_attempt: attemptSelectedCandidates.length,
      });
    };

    await runStage3Attempt('initial');

    for (let retryAttempt = 1; selectedCandidates.length < minArticlesTarget && retryAttempt <= retryPolicy.maxAdditionalAttempts; retryAttempt++) {
      const phase = resolveSourcePackRetryPhase(retryAttempt);
      const remainingExternal = retryPolicy.maxExternalQueries > 0
        ? Math.max(0, retryPolicy.maxExternalQueries - retryUsage.external_queries)
        : 0;
      const remainingBrave = retryPolicy.maxBraveQueries > 0
        ? Math.max(0, retryPolicy.maxBraveQueries - retryUsage.brave_queries)
        : 0;
      const remainingTokens = retryPolicy.maxTokenBudget > 0
        ? Math.max(0, retryPolicy.maxTokenBudget - retryUsage.estimated_tokens)
        : Number.POSITIVE_INFINITY;

      if (retryPolicy.maxExternalQueries === 0) {
        retryDiagnostics.push({
          attempt: retryAttempt,
          phase: phase.phase,
          status: 'skipped',
          reason: 'Retry external-query budget is 0',
        });
        break;
      }
      if (retryPolicy.maxExternalQueries > 0 && remainingExternal <= 0) {
        retryDiagnostics.push({
          attempt: retryAttempt,
          phase: phase.phase,
          status: 'skipped',
          reason: 'Retry external-query budget exhausted',
        });
        break;
      }
      if (retryPolicy.maxTokenBudget > 0 && remainingTokens < MIN_TOKENS_FOR_RETRY) {
        retryDiagnostics.push({
          attempt: retryAttempt,
          phase: phase.phase,
          status: 'skipped',
          reason: 'Retry token budget exhausted',
        });
        break;
      }

      const boundedRetryDiscovery = buildRetryDiscoveryOptions({
        baseOptions: stage3Options,
        phaseOptions: phase.discoveryOptions,
        remainingExternalQueries: retryPolicy.maxExternalQueries > 0 ? remainingExternal : Number.POSITIVE_INFINITY,
        remainingBraveQueries: retryPolicy.maxBraveQueries > 0 ? remainingBrave : Number.POSITIVE_INFINITY,
      });
      if (boundedRetryDiscovery.skip) {
        retryDiagnostics.push({
          attempt: retryAttempt,
          phase: phase.phase,
          status: 'skipped',
          reason: boundedRetryDiscovery.reason,
        });
        break;
      }

      console.log(`[pipeline] Stage 3 retry #${retryAttempt} (${phase.phase}): ${phase.description}`);
      const retryDiscovery = await runDiscovery({
        ...boundedRetryDiscovery.options,
        braveApiKey,
        googleApiKey,
        googleCx,
      });
      const retryQueryUsage = extractDiscoveryQueryUsage(retryDiscovery.stats);
      retryUsage.external_queries += retryQueryUsage.total;
      retryUsage.brave_queries += retryQueryUsage.brave;
      stats.source_pack_retry_external_queries = retryUsage.external_queries;
      stats.source_pack_retry_brave_queries = retryUsage.brave_queries;

      if (Array.isArray(retryDiscovery.candidates) && retryDiscovery.candidates.length > 0) {
        mergeDiscoveredNews(retryDiscovery.candidates);
      }

      const retryClusterLimitByTokens = retryPolicy.maxTokenBudget > 0
        ? Math.max(1, Math.floor(remainingTokens / ESTIMATED_TOKENS_PER_RETRY_BRIEF))
        : (options.clusterSelectionLimit || 6);
      const retryNormalization = await normalizeDiscoveryCandidatesToBriefs(
        retryDiscovery.candidates || [],
        {
          ...stage3Options,
          clusterSelectionLimit: Math.max(1, Math.min(options.clusterSelectionLimit || 6, retryClusterLimitByTokens)),
        },
        openAiApiKey,
      );
      const retryBriefs = Array.isArray(retryNormalization.briefs) ? retryNormalization.briefs : [];
      const retryEstimatedTokens = retryBriefs.length * ESTIMATED_TOKENS_PER_RETRY_BRIEF;
      retryUsage.estimated_tokens += retryEstimatedTokens;
      stats.source_pack_retry_estimated_tokens = retryUsage.estimated_tokens;
      stats.briefs_normalized += retryBriefs.length;

      if (retryBriefs.length > 0) {
        mergeBriefsIntoPool(retryBriefs);
        seedBriefs = dedupeBriefCandidates([...seedBriefs, ...retryBriefs]);
      }

      await runStage3Attempt(`retry_${retryAttempt}_${phase.phase}`);
      retryDiagnostics.push({
        attempt: retryAttempt,
        phase: phase.phase,
        status: 'ran',
        discovery_candidates: Array.isArray(retryDiscovery.candidates) ? retryDiscovery.candidates.length : 0,
        normalized_briefs: retryBriefs.length,
        selected_candidates: selectedCandidates.length,
        source_pack_attempt: stage3AttemptSummaries[stage3AttemptSummaries.length - 1] || null,
        query_usage: retryQueryUsage,
        estimated_tokens: retryEstimatedTokens,
      });
    }

    if (selectedCandidates.length > 0 && selectedCandidates.length < minArticlesTarget) {
      console.log(`[pipeline] Stage 3 partial target: selected ${selectedCandidates.length}/${minArticlesTarget} candidate(s); proceeding with available publishable set`);
    }

    const selectedIdentityKeys = selectedCandidates
      .map((candidate) => candidate?.brief?.poolIdentityKey)
      .filter(Boolean);
    stats.ready_candidates = Number(readyBacklog.readyCount || 0);
    stats.additional_ready_candidates = Array.isArray(readyBacklog.additionalReadyCandidates)
      ? readyBacklog.additionalReadyCandidates.length
      : 0;
    stats.articles_attempted = selectedCandidates.length;
    stats.selected_topic = selected?.brief?.title || null;
    stats.selected_topics = selectedCandidates.map((candidate) => candidate?.brief?.title).filter(Boolean);

    if (Array.isArray(readyBacklog.additionalReadyCandidates) && readyBacklog.additionalReadyCandidates.length > 0) {
      console.log(`[pipeline] Additional ready article candidates: ${readyBacklog.additionalReadyCandidates.length}`);
      for (const candidate of readyBacklog.additionalReadyCandidates.slice(0, 5)) {
        console.log(`[pipeline]   backlog rank=${candidate.rank} score=${candidate.score} section=${candidate.section_id || 'unassigned'} topic=${candidate.topic_id || 'unassigned'} title=${candidate.title}`);
      }
      if (readyBacklog.filePath) {
        console.log(`[pipeline] Ready candidate backlog saved: ${readyBacklog.filePath}`);
      }
    }

    stageResults.sourcePackAssembly = {
      stage: 'sourcePackAssembly',
      success: selectedCandidates.length > 0,
      error: selectedCandidates.length === 0 ? 'No publishable candidates selected' : null,
      data: {
        attempts: stage3AttemptSummaries,
        retryPolicy,
        minArticlesTarget,
        sourcePackSelectionCandidateLimit,
        retryDiagnostics,
        retryUsage,
        selectedCount: selectedCandidates.length,
        selectedMeetsMinTarget: selectedCandidates.length >= minArticlesTarget,
        selectedTopics: selectedCandidates.map((candidate) => ({
          title: candidate?.brief?.title || null,
          eventId: candidate?.sourcePack?.eventId || null,
          sources: candidate?.sourcePack?.sources?.length || 0,
          uniqueDomains: candidate?.sourcePack?.uniqueDomains || 0,
          section_id: candidate?.sourcePack?.section_id || candidate?.brief?.section_id || null,
          topic_id: candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || null,
          gate_notes: Array.isArray(candidate?.sourcePack?.gateNotes) ? candidate.sourcePack.gateNotes : [],
          stage3_editorial_gate: {
            editorial_valid: candidate?.sourcePack?.stage3EditorialGate?.editorial_valid ?? null,
            blocking_errors: candidate?.sourcePack?.stage3EditorialGate?.blocking_errors || [],
            warnings: candidate?.sourcePack?.stage3EditorialGate?.warnings || [],
          },
        })),
        readyCandidates: {
          readyCount: readyBacklog.readyCount,
          additionalReadyCandidates: readyBacklog.additionalReadyCandidates,
          selectedCandidates: readyBacklog.selectedCandidates,
          filePath: readyBacklog.filePath,
          selectedIdentityKeys,
        },
        duplicateRejectedCandidates: duplicateRejectedAtSelection,
        candidatesEvaluated: candidateSetForSelection.length,
      },
    };

    if (selectedCandidates.length === 0) {
      const attemptCount = stage3AttemptSummaries.length;
      console.log(`[pipeline] SOURCE PACK GATE: FAIL - No publishable candidate after ${attemptCount} attempt(s)`);
      return finalizePipelineResult(false, `Source pack gate failed: No publishable candidate after ${attemptCount} attempt(s)`, null, {
        published_paths: [],
        verified_urls: [],
        selected_candidates: [],
        published_articles: [],
      });
    }

    for (const candidate of selectedCandidates) {
      console.log(`[pipeline] SOURCE PACK GATE: PASS :: ${candidate.brief.title}`);
      console.log(`[pipeline] Sources: ${candidate.sourcePack.sources.length}, Domains: ${candidate.sourcePack.uniqueDomains}`);
    }
  } catch (error) {
    console.error(`[pipeline] Source pack assembly failed: ${error.message}`);
    stageResults.sourcePackAssembly = {
      stage: 'sourcePackAssembly',
      success: false,
      error: error.message,
      data: null,
    };
    return finalizePipelineResult(false, `Source pack assembly failed: ${error.message}`, null, {
      published_paths: [],
      verified_urls: [],
      selected_candidates: [],
      published_articles: [],
    });
  }

  // Stage 3.5: Pre-draft canonical lock (taxonomy + tags before writing)
  console.log('[pipeline] Stage 3.5: Pre-draft canonical placement and tag lock...');
  const preDraftItems = [];
  const preDraftRejected = [];
  const preDraftPreparedCandidates = [];
  for (const candidate of selectedCandidates) {
    const articleLabel = candidate?.brief?.title || candidate?.sourcePack?.topic || 'Untitled candidate';
    const basePlacement = {
      section_id: candidate?.sourcePack?.section_id || candidate?.brief?.section_id || null,
      topic_id: candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || null,
      section: candidate?.sourcePack?.section || candidate?.brief?.section || null,
      subsection: candidate?.sourcePack?.topic || candidate?.brief?.subsection || null,
      topics: [candidate?.sourcePack?.topic || candidate?.brief?.subsection || null].filter(Boolean),
    };
    const preDraftSeed = {
      title: candidate?.brief?.title || '',
      excerpt: candidate?.brief?.summary || candidate?.brief?.whyItMatters || '',
      content: `${candidate?.brief?.whatHappened || ''} ${candidate?.brief?.whyItMatters || ''}`.trim(),
      section_id: basePlacement.section_id,
      topic_id: basePlacement.topic_id,
      article_type: candidate?.brief?.articleType || candidate?.brief?.article_type || 'report',
      articleType: candidate?.brief?.articleType || candidate?.brief?.article_type || 'report',
    };
    let canonicalPayload = buildCanonicalPublishPayload({
      ...candidate,
      draft: preDraftSeed,
      placement: basePlacement,
    });
    let placementRepairMode = 'none';
    if (!(canonicalPayload?.placement?.section_id && canonicalPayload?.placement?.topic_id)) {
      const strictPlacement = resolvePlacementMetadata({
        title: candidate?.brief?.title || '',
        excerpt: candidate?.brief?.summary || candidate?.brief?.whyItMatters || '',
        content: `${candidate?.brief?.whatHappened || ''} ${candidate?.brief?.whyItMatters || ''}`.trim(),
        section_id: basePlacement.section_id || candidate?.sourcePack?.section_id || candidate?.brief?.section_id || null,
        topic_id: basePlacement.topic_id || candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || null,
        subsection: basePlacement.subsection || null,
        topics: Array.isArray(basePlacement.topics) ? basePlacement.topics : [],
        sources: candidate?.sourcePack?.publishReadySources || candidate?.sourcePack?.sources || [],
        lock_canonical_placement: true,
      });
      canonicalPayload = buildCanonicalPublishPayload({
        ...candidate,
        draft: {
          ...preDraftSeed,
          section_id: strictPlacement.section_id || preDraftSeed.section_id || null,
          topic_id: strictPlacement.topic_id || preDraftSeed.topic_id || null,
        },
        placement: {
          ...basePlacement,
          section_id: strictPlacement.section_id || basePlacement.section_id || null,
          topic_id: strictPlacement.topic_id || basePlacement.topic_id || null,
          section: strictPlacement.section || basePlacement.section || null,
          subsection: strictPlacement.subsection || basePlacement.subsection || null,
          topics: Array.isArray(strictPlacement.topics) ? strictPlacement.topics : basePlacement.topics,
        },
      });
      placementRepairMode = 'strict';
    }
    if (!(canonicalPayload?.placement?.section_id && canonicalPayload?.placement?.topic_id)) {
      const inferredPlacement = resolvePlacementMetadata({
        title: candidate?.brief?.title || '',
        excerpt: candidate?.brief?.summary || candidate?.brief?.whyItMatters || '',
        content: `${candidate?.brief?.whatHappened || ''} ${candidate?.brief?.whyItMatters || ''}`.trim(),
        section_id: basePlacement.section_id || candidate?.sourcePack?.section_id || candidate?.brief?.section_id || null,
        topic_id: basePlacement.topic_id || candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || null,
        subsection: basePlacement.subsection || null,
        topics: Array.isArray(basePlacement.topics) ? basePlacement.topics : [],
        sources: candidate?.sourcePack?.publishReadySources || candidate?.sourcePack?.sources || [],
        lock_canonical_placement: false,
      });
      canonicalPayload = buildCanonicalPublishPayload({
        ...candidate,
        draft: {
          ...preDraftSeed,
          section_id: inferredPlacement.section_id || preDraftSeed.section_id || null,
          topic_id: inferredPlacement.topic_id || preDraftSeed.topic_id || null,
        },
        placement: {
          ...basePlacement,
          section_id: inferredPlacement.section_id || basePlacement.section_id || null,
          topic_id: inferredPlacement.topic_id || basePlacement.topic_id || null,
          section: inferredPlacement.section || basePlacement.section || null,
          subsection: inferredPlacement.subsection || basePlacement.subsection || null,
          topics: Array.isArray(inferredPlacement.topics) ? inferredPlacement.topics : basePlacement.topics,
        },
      });
      placementRepairMode = 'inferred';
    }
    const tagValidation = validateTagSelection(canonicalPayload?.tagging || {});
    const rawTagErrors = Array.isArray(tagValidation.errors) ? tagValidation.errors : [];
    const softPreDraftTagErrors = new Set([
      'Fewer than 3 canonical tags',
      'Fewer than 2 canonical tags',
      'Canonical tag set is missing required non-topic evidence tag',
    ]);
    const softTagErrors = rawTagErrors.filter((message) => softPreDraftTagErrors.has(String(message || '').trim()));
    const hardTagErrors = rawTagErrors.filter((message) => !softPreDraftTagErrors.has(String(message || '').trim()));
    const onlySoftTagErrors = rawTagErrors.length > 0 && hardTagErrors.length === 0;
    const hasPlacementLock = Boolean(canonicalPayload?.placement?.section_id && canonicalPayload?.placement?.topic_id);

    const rejectionReasons = [];
    if (!hasPlacementLock) {
      rejectionReasons.push('Missing canonical section/topic lock from source-pack evidence');
    }
    if (hardTagErrors.length > 0) {
      rejectionReasons.push(`Canonical tags invalid before writing: ${hardTagErrors.join('; ')}`);
    }

    const canonicalTags = Array.isArray(canonicalPayload?.tagging?.tags) ? canonicalPayload.tagging.tags : [];
    const canonicalSlugs = Array.isArray(canonicalPayload?.tagging?.tag_slugs) ? canonicalPayload.tagging.tag_slugs : [];
    const placementWarnings = [];
    if (placementRepairMode === 'inferred' && hasPlacementLock) {
      placementWarnings.push('Canonical placement inferred from event evidence after strict lock fallback');
    }
    preDraftItems.push({
      title: articleLabel,
      success: rejectionReasons.length === 0,
      error: rejectionReasons.length > 0 ? rejectionReasons.join(' | ') : null,
      data: {
        section_id: canonicalPayload?.placement?.section_id || null,
        topic_id: canonicalPayload?.placement?.topic_id || null,
        tags: canonicalTags,
        tag_slugs: canonicalSlugs,
        thin_tag_set_before_draft: onlySoftTagErrors,
        warnings: [...(tagValidation.warnings || []), ...softTagErrors, ...placementWarnings],
      },
    });

    if (rejectionReasons.length > 0) {
      console.log(`[pipeline] PRE-DRAFT LOCK: FAIL :: ${articleLabel} :: ${rejectionReasons.join(' | ')}`);
      preDraftRejected.push({ title: articleLabel, reasons: rejectionReasons });
      continue;
    }

    if (onlySoftTagErrors) {
      console.log(`[pipeline] PRE-DRAFT LOCK: WARN :: ${articleLabel} :: ${softTagErrors.join('; ')} (will re-validate after draft)`);
      const existingWarnings = Array.isArray(canonicalPayload?.tagging?.warnings) ? canonicalPayload.tagging.warnings : [];
      canonicalPayload.tagging = {
        ...(canonicalPayload.tagging || {}),
        warnings: Array.from(new Set([
          ...existingWarnings,
          ...softTagErrors,
          'Canonical tag evidence is sparse before drafting; awaiting post-draft enrichment',
        ])),
      };
    }
    if (placementWarnings.length > 0) {
      console.log(`[pipeline] PRE-DRAFT LOCK: WARN :: ${articleLabel} :: ${placementWarnings.join(' | ')}`);
      const existingWarnings = Array.isArray(canonicalPayload?.placement?.warnings) ? canonicalPayload.placement.warnings : [];
      canonicalPayload.placement = {
        ...(canonicalPayload.placement || {}),
        warnings: Array.from(new Set([...existingWarnings, ...placementWarnings])),
      };
    }

    candidate.preDraftCanonicalPayload = canonicalPayload;
    candidate.canonicalPublishPayload = canonicalPayload;
    candidate.placement = {
      ...(candidate.placement || {}),
      ...(canonicalPayload.placement || {}),
    };
    if (candidate.sourcePack) {
      candidate.sourcePack.section_id = canonicalPayload?.placement?.section_id || candidate.sourcePack.section_id || null;
      candidate.sourcePack.topic_id = canonicalPayload?.placement?.topic_id || candidate.sourcePack.topic_id || null;
      candidate.sourcePack.section = canonicalPayload?.placement?.section || candidate.sourcePack.section || null;
      candidate.sourcePack.topic = canonicalPayload?.placement?.subsection || canonicalPayload?.placement?.primaryTopic || candidate.sourcePack.topic || null;
    }
    if (candidate.brief) {
      candidate.brief.section_id = canonicalPayload?.placement?.section_id || candidate.brief.section_id || null;
      candidate.brief.topic_id = canonicalPayload?.placement?.topic_id || candidate.brief.topic_id || null;
      candidate.brief.section = canonicalPayload?.placement?.section || candidate.brief.section || null;
      candidate.brief.subsection = canonicalPayload?.placement?.subsection || candidate.brief.subsection || null;
      candidate.brief.topics = Array.isArray(canonicalPayload?.placement?.topics)
        ? canonicalPayload.placement.topics
        : (candidate.brief.topics || []);
    }

    preDraftPreparedCandidates.push(candidate);
    console.log(`[pipeline] PRE-DRAFT LOCK: PASS :: ${articleLabel} :: section=${canonicalPayload?.placement?.section_id} topic=${canonicalPayload?.placement?.topic_id} tags=${canonicalTags.length}`);
  }

  const preDraftPassedCandidates = preDraftPreparedCandidates.slice();
  selectedCandidates = preDraftPassedCandidates.slice(0, maxArticlesPerRun);
  selected = selectedCandidates[0] || null;
  for (const candidate of selectedCandidates) {
    if (candidate?.brief?.poolIdentityKey) {
      markBriefSelected(candidate.brief.poolIdentityKey, workflowLeaseOwner);
    }
  }
  stats.pre_draft_rejected = preDraftRejected.length;
  stats.articles_attempted = selectedCandidates.length;
  stats.selected_topic = selected?.brief?.title || null;
  stats.selected_topics = selectedCandidates.map((candidate) => candidate?.brief?.title).filter(Boolean);

  stageResults.preDraftPreparation = {
    stage: 'preDraftPreparation',
    success: selectedCandidates.length > 0,
    error: selectedCandidates.length === 0 ? 'No candidates passed pre-draft canonical lock' : null,
    data: {
      total: preDraftItems.length,
      passed: preDraftPassedCandidates.length,
      selected_for_run: selectedCandidates.length,
      rejected: preDraftRejected,
      items: preDraftItems,
    },
  };

  if (selectedCandidates.length === 0) {
    return finalizePipelineResult(false, 'Pre-draft quality gate failed: no candidate passed canonical placement/tag lock', null, {
      published_paths: [],
      verified_urls: [],
      selected_candidates: [],
      published_articles: [],
    });
  }

  // Stage 4-8: Per-article execution loop
  const preWriteItems = [];
  const claimMapItems = [];
  const draftItems = [];
  const imageItems = [];
  const youtubeItems = [];
  const publishItems = [];
  const verificationItems = [];
  const articleErrors = [];

  for (const candidate of selectedCandidates) {
    const articleLabel = candidate?.brief?.title || candidate?.sourcePack?.topic || 'Untitled candidate';
    const candidateIdentityKey = candidate?.brief?.poolIdentityKey || getBriefIdentityKey(candidate?.brief);
    if (candidateIdentityKey && candidate?.brief) {
      candidate.brief.poolIdentityKey = candidate.brief.poolIdentityKey || candidateIdentityKey;
    }
    console.log(`[pipeline] === Article run start: ${articleLabel} ===`);

    // Stage 3.7: Pre-write quality gate (cheap, no writer tokens)
    const preWriteCoherence = estimateSourcePackCoherence(candidate?.sourcePack || {}, candidate?.brief || {});
    const preWriteGate = evaluatePreWriteQualityGate({
      brief: candidate?.brief || {},
      sourcePack: candidate?.sourcePack || {},
      mode: 'article',
      coherenceScore: preWriteCoherence,
    }, options.preWriteGate || {});
    preWriteItems.push({
      title: articleLabel,
      success: preWriteGate.pass,
      error: preWriteGate.pass ? null : preWriteGate.reasons.join('; '),
      data: preWriteGate.metrics,
    });
    if (!preWriteGate.pass) {
      console.log(`[pipeline] PRE-WRITE GATE: FAIL :: ${articleLabel} :: ${preWriteGate.reasons.join(' | ')}`);
      articleErrors.push({ title: articleLabel, stage: 'preWriteQualityGate', error: preWriteGate.reasons.join('; ') });
      continue;
    }
    console.log(`[pipeline] PRE-WRITE GATE: PASS :: ${articleLabel} :: coherence=${preWriteCoherence}`);

    // Stage 3.8: Pre-draft gates — duplicate source-overlap + direct-event source count (skip before LLM drafting)
    const preDraftGates = runPreDraftGates(candidate, options);
    if (preDraftGates.blocked) {
      console.log(`[pipeline] PRE-DRAFT GATE: SKIP :: ${articleLabel} :: ${preDraftGates.reason}`);
      articleErrors.push({ title: articleLabel, stage: preDraftGates.stage, error: preDraftGates.reason });
      preWriteItems.push({
        title: articleLabel,
        success: false,
        error: preDraftGates.reason,
        data: null,
      });
      continue;
    }

    // Stage 4: Claim Map Creation (GATE)
    console.log('[pipeline] Stage 4: Claim map creation...');
    try {
      const claimMap = await createClaimMap(candidate.sourcePack, openAiApiKey);
      candidate.claimMap = claimMap;

      const claimValidation = validateClaimMap(claimMap);
      console.log(`[pipeline] Claim map: ${claimMap.totalClaims} claims, ${claimMap.supportedClaims} supported`);

      claimMapItems.push({
        title: articleLabel,
        success: claimValidation.passes,
        error: claimValidation.passes ? null : claimValidation.issues.join(', '),
        data: {
          totalClaims: claimMap.totalClaims,
          supportedClaims: claimMap.supportedClaims,
          passesGate: claimMap.passesGate,
          issues: claimValidation.issues,
        },
      });

      if (!claimValidation.passes) {
        console.log('[pipeline] CLAIM MAP GATE: FAIL -', claimValidation.issues.join(', '));
        articleErrors.push({ title: articleLabel, stage: 'claimMapCreation', error: claimValidation.issues.join(', ') });
        continue;
      }

      console.log('[pipeline] CLAIM MAP GATE: PASS');
    } catch (error) {
      console.error(`[pipeline] Claim map creation failed: ${error.message}`);
      claimMapItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      articleErrors.push({ title: articleLabel, stage: 'claimMapCreation', error: error.message });
      continue;
    }

    // Stage 5: Article Drafting
    console.log('[pipeline] Stage 5: Article drafting...');
    try {
      const draft = await draftArticle(candidate.brief, candidate.sourcePack, candidate.claimMap, openAiApiKey);
      const hardened = hardenDraft(draft, candidate.claimMap);
      candidate.draft = hardened;
      candidate.publishIdentity = {
        title: hardened.title,
        slug: generateSlug(hardened.title),
      };
      candidate.articleSlug = candidate.publishIdentity.slug;

      draftItems.push({
        title: articleLabel,
        success: hardened.safeForPublishing,
        error: hardened.safeForPublishing ? null : `Draft quality ${hardened.quality}: ${hardened.qualityIssues.join('; ')}`,
        data: {
          wordCount: hardened.wordCount,
          articleType: hardened.articleType,
          quality: hardened.quality,
          safeForPublishing: hardened.safeForPublishing,
        },
      });

      console.log(`[pipeline] Drafted: ${hardened.wordCount} words, type: ${hardened.articleType}, quality: ${hardened.quality}`);

      if (!hardened.safeForPublishing) {
        articleErrors.push({ title: articleLabel, stage: 'articleDrafting', error: hardened.qualityIssues.join('; ') });
        continue;
      }
    } catch (error) {
      console.error(`[pipeline] Article drafting failed: ${error.message}`);
      draftItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      articleErrors.push({ title: articleLabel, stage: 'articleDrafting', error: error.message });
      continue;
    }

    // Stage 6: Image Support
    console.log('[pipeline] Stage 6: Image support...');
    try {
      const slug = candidate.publishIdentity?.slug
        || candidate.articleSlug
        || generateSlug(candidate.draft?.title || candidate.brief?.title || 'untitled');
      candidate.articleSlug = slug;

      const imageResult = await generateImagePackage(candidate, slug, { pexelsApiKey, unsplashApiKey, pixabayApiKey });
      candidate.image = imageResult;
      imageItems.push({
        title: articleLabel,
        success: true,
        error: null,
        data: {
          provider: imageResult.provider,
          imagePath: imageResult.imagePath,
          hasAltText: !!imageResult.altText,
        },
      });

      console.log(`[pipeline] Image: ${imageResult.provider}, path: ${imageResult.imagePath}`);
    } catch (error) {
      console.error(`[pipeline] Image support failed: ${error.message}`);
      imageItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      // Image is not a hard gate - continue
    }

    // Stage 7: YouTube Enrichment (non-blocking, optional)
    console.log('[pipeline] Stage 7: YouTube enrichment...');
    try {
      const videoResult = await enrichCandidateWithVideo(candidate);
      candidate.youtubeVideo = videoResult;
      youtubeItems.push({
        title: articleLabel,
        success: videoResult !== null,
        error: null,
        data: videoResult
          ? {
              videoId: videoResult.videoId,
              title: videoResult.title,
              channelTitle: videoResult.channelTitle,
              score: videoResult.score,
              matchReason: videoResult.matchReason,
            }
          : null,
      });

      if (videoResult) {
        console.log(`[pipeline] YouTube video attached: "${videoResult.title}" (score: ${videoResult.score})`);
      } else {
        console.log(`[pipeline] YouTube: no strong match for "${articleLabel}"`);
      }
    } catch (error) {
      console.warn(`[pipeline] YouTube enrichment failed: ${error.message}`);
      youtubeItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      // YouTube is not a hard gate - continue
    }

    // Stage 8: Publish Article (GATE)
    console.log('[pipeline] Stage 8: Publishing article...');
    try {
      if (candidateIdentityKey && isIdentityAlreadyPublished(candidateIdentityKey)) {
        const duplicateError = `Duplicate guard blocked publish for already published identity: ${candidateIdentityKey}`;
        console.log(`[pipeline] ${duplicateError}`);
        publishItems.push({
          title: articleLabel,
          success: false,
          error: duplicateError,
          data: { identityKey: candidateIdentityKey },
        });
        articleErrors.push({ title: articleLabel, stage: 'publishing', error: duplicateError });
        continue;
      }

      let prePublishValidation = validatePrePublishGraph(candidate, options);
      let imageRescueDiagnostics = [];
      if (!prePublishValidation.valid && hasImageTopicMismatchError(prePublishValidation.errors || [])) {
        const rescue = await attemptImageRescuePass({
          candidate,
          providerApiKeys: { pexelsApiKey, unsplashApiKey, pixabayApiKey },
          validateGraph: validatePrePublishGraph,
          logPrefix: 'pipeline',
        });
        imageRescueDiagnostics = Array.isArray(rescue?.diagnostics) ? rescue.diagnostics : [];
        if (rescue?.validation) {
          prePublishValidation = rescue.validation;
        } else {
          prePublishValidation = validatePrePublishGraph(candidate);
        }
      }
      if (!prePublishValidation.valid) {
        publishItems.push({
          title: articleLabel,
          success: false,
          error: `Pre-publish graph invalid: ${prePublishValidation.errors.join(', ')}`,
          data: {
            warnings: prePublishValidation.warnings,
            placement: prePublishValidation.placement,
            image_rescue: imageRescueDiagnostics,
          },
        });
        articleErrors.push({ title: articleLabel, stage: 'publishing', error: prePublishValidation.errors.join(', ') });
        continue;
      }

      candidate.canonicalPublishPayload = prePublishValidation.canonical_publish_payload
        || buildCanonicalPublishPayload(candidate, prePublishValidation);
      candidate.placement = {
        ...(candidate.placement || {}),
        ...(candidate.canonicalPublishPayload?.placement || {}),
      };
      if (candidate.canonicalPublishPayload?.tagging) {
        const tagging = candidate.canonicalPublishPayload.tagging;
        candidate.draft = {
          ...(candidate.draft || {}),
          tags: Array.isArray(tagging.tags) ? tagging.tags : (candidate.draft?.tags || []),
          tag_slugs: Array.isArray(tagging.tag_slugs) ? tagging.tag_slugs : (candidate.draft?.tag_slugs || []),
          subsection: candidate.canonicalPublishPayload?.placement?.subsection || candidate.draft?.subsection,
          topics: Array.isArray(candidate.canonicalPublishPayload?.placement?.topics)
            ? candidate.canonicalPublishPayload.placement.topics
            : (candidate.draft?.topics || []),
          metadata: {
            ...(candidate.draft?.metadata || {}),
            tagging,
          },
        };
      }
      if (candidate.sourcePack && Array.isArray(candidate.canonicalPublishPayload?.sources)) {
        candidate.sourcePack.publicSources = candidate.canonicalPublishPayload.sources;
        candidate.sourcePack.canonicalPublicSources = candidate.canonicalPublishPayload.sources;
      }
      candidate.publishManifest = buildPublishManifest(candidate);

      const publishResult = publishArticle(candidate);
      candidate.publishResult = publishResult;

      if (publishResult.success) {
        candidate.placement = { ...(candidate.placement || {}), ...(publishResult.placement || {}) };
        candidate.publishManifest = buildPublishManifest(candidate, publishResult);
        candidate.publishManifestPath = writePublishManifest(candidate.publishManifest);
        const artifactValidation = validatePublishedArtifact(publishResult.filePath, candidate.publishManifest);
        if (!artifactValidation.valid) {
          publishItems.push({
            title: articleLabel,
            success: false,
            error: `Published artifact validation failed: ${artifactValidation.errors.join(', ')}`,
            data: { manifestPath: candidate.publishManifestPath, manifest: candidate.publishManifest },
          });
          articleErrors.push({ title: articleLabel, stage: 'publishing', error: artifactValidation.errors.join(', ') });
          continue;
        }
      }

      publishItems.push({
        title: articleLabel,
        success: publishResult.success,
        error: publishResult.success ? null : publishResult.error,
        data: publishResult.success ? {
          filename: publishResult.filename,
          filePath: publishResult.filePath,
          canonicalSlug: publishResult.canonicalSlug,
          expectedUrl: publishResult.expectedUrl,
          manifestPath: candidate.publishManifestPath || null,
          section_id: candidate.publishManifest?.section_id || null,
          topic_id: candidate.publishManifest?.topic_id || null,
        } : null,
      });

      if (!publishResult.success) {
        console.log('[pipeline] PUBLISH GATE: FAIL -', publishResult.error);
        articleErrors.push({ title: articleLabel, stage: 'publishing', error: publishResult.error });
        continue;
      }

      if (candidate.brief.poolIdentityKey) {
        markBriefPublished(candidate.brief.poolIdentityKey, publishResult.canonicalSlug);
        stats.news_pool = getNewsPoolStats();
      }
      publishedPath = publishedPath || publishResult.filePath;
      publishedPaths.push(publishResult.filePath);
      stats.articles_published++;
      console.log('[pipeline] PUBLISH GATE: PASS');
      console.log(`[pipeline] Published: ${publishResult.filename}`);
      console.log(`[pipeline] Path: ${publishResult.filePath}`);
    } catch (error) {
      console.error(`[pipeline] Publish failed: ${error.message}`);
      publishItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      articleErrors.push({ title: articleLabel, stage: 'publishing', error: error.message });
      continue;
    }

    // Stage 8: Local Visibility Verification (GATE for local/dev runs)
    if (!localVerificationEnabled) {
      const expectedUrl = candidate?.publishResult?.expectedUrl
        || (candidate?.publishResult?.canonicalSlug ? `/article/${candidate.publishResult.canonicalSlug}/` : null)
        || (candidate?.articleSlug ? `/article/${candidate.articleSlug}/` : null);

      verificationItems.push({
        title: articleLabel,
        success: true,
        error: null,
        data: {
          skipped: true,
          reason: 'CI environment: localhost verification skipped; publish + build checks passed',
          expectedUrl,
        },
      });

      if (expectedUrl) {
        verifiedUrl = verifiedUrl || expectedUrl;
        verifiedUrls.push(expectedUrl);
      }
      publishedArticles.push(candidate);
      console.log('[pipeline] Stage 8: skipped localhost verification in CI environment');
      continue;
    }

    // Stage 8: Local Visibility Verification (local/dev gate)
    console.log('[pipeline] Stage 8: Local visibility verification...');
    try {
      const verification = await verifyLocalVisibility(candidate);
      candidate.verification = verification;

      const verificationPassed = verification?.passes === true || verification?.status === 'pass';
      const verificationIssues = Array.isArray(verification?.issues) ? verification.issues : [];

      verificationItems.push({
        title: articleLabel,
        success: verificationPassed,
        error: verificationPassed ? null : verificationIssues.join(', '),
        data: {
          passes: verificationPassed,
          status: verification?.status || null,
          articleUrlReachable: verification.articleUrlReachable,
          homepageVisible: verification.homepageVisible,
          issues: verificationIssues,
        },
      });

      if (!verificationPassed) {
        console.log('[pipeline] LOCAL VERIFICATION GATE: FAIL -', verificationIssues.join(', '));
        articleErrors.push({ title: articleLabel, stage: 'localVerification', error: verificationIssues.join(', ') });
        continue;
      }

      verifiedUrl = verifiedUrl || verification.articleUrl;
      verifiedUrls.push(verification.articleUrl);
      publishedArticles.push(candidate);
      console.log('[pipeline] LOCAL VERIFICATION GATE: PASS');
    } catch (error) {
      console.error(`[pipeline] Local verification failed: ${error.message}`);
      verificationItems.push({ title: articleLabel, success: false, error: error.message, data: null });
      articleErrors.push({ title: articleLabel, stage: 'localVerification', error: error.message });
      continue;
    }
  }

  stageResults.preWriteQualityGate = buildAggregateStageResult('preWriteQualityGate', preWriteItems, articleErrors);
  stageResults.claimMapCreation = buildAggregateStageResult('claimMapCreation', claimMapItems, articleErrors);
  stageResults.articleDrafting = buildAggregateStageResult('articleDrafting', draftItems, articleErrors);
  stageResults.imageSupport = buildAggregateStageResult('imageSupport', imageItems, articleErrors, { allowFailures: true });
  stageResults.youtubeEnrichment = buildAggregateStageResult('youtubeEnrichment', youtubeItems, articleErrors, { allowFailures: true });
  stageResults.publishing = buildAggregateStageResult('publishing', publishItems, articleErrors);
  stageResults.localVerification = buildAggregateStageResult('localVerification', verificationItems, articleErrors);

  if (publishedArticles.length === 0) {
    const blocker = articleErrors[0]?.error || 'No articles completed publish + verification';
    return finalizePipelineResult(false, blocker, selected, {
      published_paths: publishedPaths,
      verified_urls: verifiedUrls,
      selected_candidates: selectedCandidates,
      published_articles: publishedArticles,
    });
  }

  stats.cache_stats = getProviderStats();
  stats.duration_ms = Date.now() - startTime;

  console.log(`[pipeline] Pipeline completed in ${stats.duration_ms}ms`);
  console.log('[pipeline] Provider/cache stats:', JSON.stringify(stats.cache_stats, null, 2));

  // SUCCESS: All gates passed
  return finalizePipelineResult(true, null, selected, {
    published_paths: publishedPaths,
    verified_urls: verifiedUrls,
    selected_candidates: selectedCandidates,
    published_articles: publishedArticles,
  });
}

/**
 * Build honest pipeline result object
 */
function loadProjectEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (process.env[key] !== undefined) continue;
      let value = match[2] || '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value.replace(/\\n/g, '\n');
    }
  } catch (error) {
    console.warn(`[pipeline] Unable to load .env: ${error.message}`);
  }
}

function resolveMaxArticlesPerRun(options = {}) {
  const raw = options.maxArticlesPerRun
    ?? options.max_articles_per_run
    ?? process.env.QWEN_MAX_ARTICLES_PER_RUN
    ?? '5';
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(5, parsed));
}

function resolveMinArticlesTarget(options = {}, maxArticlesPerRun = 1) {
  const raw = options.minArticlesTarget
    ?? options.min_articles_target
    ?? process.env.QWEN_MIN_ARTICLES_TARGET
    ?? '1';
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(maxArticlesPerRun, parsed));
}

function resolveLocalVerificationEnabled(options = {}) {
  const explicit = parseBooleanFlag(
    options.localVerificationEnabled
      ?? options.localVerification
      ?? options.verifyLocalVisibility
      ?? process.env.QWEN_LOCAL_VERIFICATION_ENABLED
      ?? process.env.QWEN_LOCAL_VERIFICATION,
  );
  if (explicit !== null) return explicit;

  const ci = String(process.env.CI || '').toLowerCase() === 'true';
  const githubActions = String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
  return !(ci || githubActions);
}

function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function resolveSourcePackRetryPolicy(options = {}) {
  const parseNumber = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const maxAdditionalAttempts = Math.max(
    0,
    Math.min(
      3,
      parseNumber(
        options.sourcePackRetryMaxAdditionalAttempts
          ?? options.source_pack_retry_max_additional_attempts
          ?? process.env.QWEN_SOURCE_PACK_RETRY_MAX_ATTEMPTS,
        2,
      ),
    ),
  );
  const maxExternalQueries = Math.max(
    0,
    parseNumber(
      options.sourcePackRetryMaxExternalQueries
        ?? options.source_pack_retry_max_external_queries
        ?? process.env.QWEN_SOURCE_PACK_RETRY_MAX_EXTERNAL_QUERIES,
      6,
    ),
  );
  const maxBraveQueries = Math.max(
    0,
    parseNumber(
      options.sourcePackRetryMaxBraveQueries
        ?? options.source_pack_retry_max_brave_queries
        ?? process.env.QWEN_SOURCE_PACK_RETRY_MAX_BRAVE_QUERIES,
      1,
    ),
  );
  const maxTokenBudget = Math.max(
    0,
    parseNumber(
      options.sourcePackRetryMaxTokens
        ?? options.source_pack_retry_max_tokens
        ?? process.env.QWEN_SOURCE_PACK_RETRY_MAX_TOKENS,
      0,
    ),
  );

  return {
    maxAdditionalAttempts,
    maxExternalQueries,
    maxBraveQueries,
    maxTokenBudget,
  };
}

function resolveSourcePackRetryPhase(attemptNumber = 1) {
  if (attemptNumber <= 1) {
    return {
      phase: 'cheap_refresh',
      description: 'refresh discovery with cheaper channels first (google/gdelt, brave disabled)',
      discoveryOptions: {
        livePhase: 'rescue',
        disableBrave: true,
        disableBraveExpansion: true,
        disableTargetedCoverage: true,
        disableGoogle: false,
        disableGdelt: false,
        googleLaneLimit: 2,
        gdeltLaneLimit: 2,
      },
    };
  }

  return {
    phase: 'limited_brave_refresh',
    description: 'single constrained brave retry after cheap refresh',
    discoveryOptions: {
      livePhase: 'rescue',
      disableBrave: false,
      disableBraveExpansion: true,
      disableTargetedCoverage: true,
      disableGoogle: false,
      disableGdelt: false,
      coreSectionLimit: 1,
      expansionTopicLimit: 0,
      googleLaneLimit: 1,
      gdeltLaneLimit: 1,
    },
  };
}

function buildRetryDiscoveryOptions({
  baseOptions = {},
  phaseOptions = {},
  remainingExternalQueries = Number.POSITIVE_INFINITY,
  remainingBraveQueries = Number.POSITIVE_INFINITY,
} = {}) {
  const bounded = {
    ...(baseOptions || {}),
    ...(phaseOptions || {}),
  };
  if (baseOptions?.disableBrave === true) bounded.disableBrave = true;
  if (baseOptions?.disableGoogle === true) bounded.disableGoogle = true;
  if (baseOptions?.disableGdelt === true) bounded.disableGdelt = true;

  const isExternalBounded = Number.isFinite(remainingExternalQueries);
  const isBraveBounded = Number.isFinite(remainingBraveQueries);
  let externalBudget = isExternalBounded ? Math.max(0, Number(remainingExternalQueries || 0)) : Number.POSITIVE_INFINITY;

  let braveRequests = bounded.disableBrave ? 0 : Math.max(0, Number(bounded.coreSectionLimit || 1));
  if (isBraveBounded) {
    braveRequests = Math.min(braveRequests, Math.max(0, Number(remainingBraveQueries || 0)));
  }
  if (isExternalBounded) {
    braveRequests = Math.min(braveRequests, externalBudget);
  }
  if (braveRequests <= 0) {
    bounded.disableBrave = true;
    bounded.coreSectionLimit = 0;
  } else {
    bounded.disableBrave = false;
    bounded.coreSectionLimit = braveRequests;
    if (isExternalBounded) externalBudget -= braveRequests;
  }

  const requestedGoogle = bounded.disableGoogle ? 0 : Math.max(0, Number(bounded.googleLaneLimit || 0));
  const boundedGoogle = isExternalBounded ? Math.min(requestedGoogle, externalBudget) : requestedGoogle;
  if (isExternalBounded) externalBudget -= boundedGoogle;
  bounded.googleLaneLimit = boundedGoogle;

  const requestedGdelt = bounded.disableGdelt ? 0 : Math.max(0, Number(bounded.gdeltLaneLimit || 0));
  const boundedGdelt = isExternalBounded ? Math.min(requestedGdelt, externalBudget) : requestedGdelt;
  bounded.gdeltLaneLimit = boundedGdelt;

  const projectedExternal = (bounded.disableBrave ? 0 : Number(bounded.coreSectionLimit || 0))
    + Number(bounded.googleLaneLimit || 0)
    + Number(bounded.gdeltLaneLimit || 0);

  if (projectedExternal <= 0) {
    return {
      skip: true,
      reason: 'No retry channels left after applying query budgets',
      options: null,
    };
  }

  return {
    skip: false,
    reason: null,
    options: bounded,
  };
}

function extractDiscoveryQueryUsage(discoveryStats = {}) {
  const brave = Number(discoveryStats?.brave_queries || 0);
  const google = Number(discoveryStats?.google_trusted_queries || 0);
  const gdelt = Number(discoveryStats?.gdelt_queries || 0);
  const rssFeedsPolled = Number(discoveryStats?.rss_feeds_polled || 0);
  const rssItemsSeen = Number(discoveryStats?.rss_items_seen || 0);
  const rssItemsAccepted = Number(discoveryStats?.rss_items_accepted || 0);
  const rssFeedFailures = Number(discoveryStats?.rss_feed_failures || 0);
  return {
    brave,
    google,
    gdelt,
    rss_feeds_polled: rssFeedsPolled,
    rss_items_seen: rssItemsSeen,
    rss_items_accepted: rssItemsAccepted,
    rss_feed_failures: rssFeedFailures,
    total: Math.max(0, brave) + Math.max(0, google) + Math.max(0, gdelt),
  };
}

function extractDiscoveryRssStats(discoveryStats = {}) {
  return {
    feeds_polled: Number(discoveryStats?.rss_feeds_polled || 0),
    items_seen: Number(discoveryStats?.rss_items_seen || 0),
    items_accepted: Number(discoveryStats?.rss_items_accepted || 0),
    feed_failures: Number(discoveryStats?.rss_feed_failures || 0),
    max_share_base: Number(discoveryStats?.rss_max_share_base || 0),
    max_share_effective: Number(discoveryStats?.rss_max_share_effective || 0),
    adaptive_applied: Boolean(discoveryStats?.rss_share_adaptive_applied),
    adaptive_reason: String(discoveryStats?.rss_share_adaptive_reason || 'none'),
    undercoverage_ratio: Number(discoveryStats?.rss_undercoverage_ratio || 0),
    target_cap: Number(discoveryStats?.rss_target_cap || 0),
  };
}

function extractDiscoveryChannelStats(discoveryStats = {}) {
  const channels = discoveryStats?.channels && typeof discoveryStats.channels === 'object'
    ? discoveryStats.channels
    : {};
  return {
    brave_core: Number(channels?.brave_core || 0),
    brave_targeted: Number(channels?.brave_targeted || 0),
    brave_expansion: Number(channels?.brave_expansion || 0),
    google_trusted: Number(channels?.google_trusted || 0),
    gdelt: Number(channels?.gdelt || 0),
    rss: Number(channels?.rss || 0),
  };
}

async function runSourcePackAssemblyAttempt({
  briefsSeed = [],
  options = {},
  maxArticlesPerRun = 1,
  braveApiKey,
  googleApiKey,
  googleCx,
  leaseOwner = null,
}) {
  const duplicateRejectedAtSelection = [];
  const sourcePackCandidateLimit = Math.max(
    Number(options.sourcePackCandidateLimit || 0) || 0,
    Number(options.poolSelectionLimit || 0) || 0,
    maxArticlesPerRun * 4,
    12,
  );
  const readyBriefLimit = Math.max(
    Number(options.readySelectionLimit || 0) || 0,
    maxArticlesPerRun * 3,
    maxArticlesPerRun,
  );
  const readyBriefs = getReadySelectableBriefs({ limit: readyBriefLimit, includeSelected: true, leaseOwner });
  const poolBriefs = getSelectableBriefs({
    limit: sourcePackCandidateLimit,
    prioritizeReady: true,
    readyBoost: Number(options.readyPriorityBoost || 10),
    leaseOwner,
  });

  const mergedBriefs = dedupeBriefCandidates([
    ...(Array.isArray(briefsSeed) ? briefsSeed : []).map((brief) => ({ ...brief, _selectionOrigin: brief?._selectionOrigin || 'current_run' })),
    ...readyBriefs,
    ...poolBriefs.map((brief) => ({ ...brief, _selectionOrigin: brief?._selectionOrigin || 'pool' })),
  ]).filter((brief) => {
    const identityKey = brief?.poolIdentityKey || getBriefIdentityKey(brief);
    if (!identityKey) return true;
    if (isIdentityAlreadyPublished(identityKey)) {
      duplicateRejectedAtSelection.push({
        identityKey,
        title: brief?.title || null,
        origin: brief?._selectionOrigin || null,
        reason: 'identity_already_published',
      });
      console.log(`[pipeline] Duplicate guard: skip published identity ${identityKey} :: ${brief?.title || 'Untitled brief'}`);
      return false;
    }
    brief.poolIdentityKey = brief.poolIdentityKey || identityKey;
    return true;
  });

  const briefsForSelection = mergedBriefs.slice(0, sourcePackCandidateLimit);
  console.log(`[pipeline] Source-pack candidates from merged current+pool+ready set: ${briefsForSelection.length}`);
  if (duplicateRejectedAtSelection.length > 0) {
    console.log(`[pipeline] Duplicate guard removed ${duplicateRejectedAtSelection.length} already published candidate(s) before source-pack assembly`);
  }
  if (readyBriefs.length > 0) {
    console.log(`[pipeline] Ready backlog prioritized for selection: ${readyBriefs.length}`);
  }
  if (briefsForSelection[0]?.selectionScore !== undefined) {
    console.log(`[pipeline] Top ranked brief score=${briefsForSelection[0].selectionScore} origin=${briefsForSelection[0]._selectionOrigin} title=${briefsForSelection[0].title}`);
  }

  const sourcePackSelectionLimit = Math.max(
    Number(options.maxArticlesPerRunForSourcePackSelection || options.sourcePackSelectionCandidateLimit || 0) || 0,
    maxArticlesPerRun,
    maxArticlesPerRun * 3,
  );

  const sharedPreWriterResult = await runSharedSourcePackEngine({
    briefs: briefsForSelection,
    options: {
      ...options,
      qnaNearMissRescueLimit: Number(options.stage3NearMissRetryLimit || 3),
      qnaRetryPoolMatchLimit: Number(options.stage3NearMissRetryPoolMatchLimit || 24),
    },
    braveApiKey,
    googleApiKey,
    googleCx,
    maxSelectionCount: sourcePackSelectionLimit,
    selectionLimits: {
      maxPerSection: Number(options.maxPerSection || 2),
      maxPerTopic: Number(options.maxPerTopic || 2),
      relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
      relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
    },
    applyDuplicateGuard: true,
  });

  const sourcePacksAssembled = Number(sharedPreWriterResult.sourcePacksAssembled || 0);
  const candidatesAfterInventoryDedupe = Array.isArray(sharedPreWriterResult.candidatesAfterDuplicateGuard)
    ? sharedPreWriterResult.candidatesAfterDuplicateGuard
    : [];
  let publishableCandidates = candidatesAfterInventoryDedupe.filter((candidate) => candidate?.sourcePack?.passesGate).length;
  console.log(`[pipeline] Assembled ${sourcePacksAssembled} source packs, ${publishableCandidates} publishable`);

  const recentDuplicateRejected = Array.isArray(sharedPreWriterResult.duplicateRejectedAtSelection)
    ? sharedPreWriterResult.duplicateRejectedAtSelection
    : [];
  if (recentDuplicateRejected.length > 0) {
    for (const rejected of recentDuplicateRejected) {
      const details = rejected?.details || {};
      duplicateRejectedAtSelection.push({
        identityKey: null,
        title: rejected.candidateTitle || null,
        origin: 'recent_inventory_guard',
        reason: `recent_inventory_duplicate(score=${rejected.score}, threshold=${rejected.threshold ?? 'na'}, topic=${rejected.candidateTopicId || 'na'}, title_overlap=${details.titleOverlap || 0}, keyword_overlap=${details.keywordOverlap || 0}, entity_overlap=${details.entityOverlap || 0})`,
        matched: rejected.matchedEntry || null,
      });
      console.log(`[pipeline] Duplicate guard: drop recent-inventory candidate "${rejected.candidateTitle || 'Untitled'}" matched with "${rejected?.matchedEntry?.title || 'unknown'}" (score=${rejected.score}, threshold=${rejected.threshold ?? 'na'})`);
    }
    console.log(`[pipeline] Recent inventory duplicate guard removed ${recentDuplicateRejected.length} candidate(s)`);
  }

  const sharedSelectedCandidates = Array.isArray(sharedPreWriterResult.selectedCandidates)
    ? sharedPreWriterResult.selectedCandidates
    : selectSharedPreWriterCandidates(candidatesAfterInventoryDedupe, {
      maxSelectionCount: sourcePackSelectionLimit,
      selectionLimits: {
        maxPerSection: Number(options.maxPerSection || 2),
        maxPerTopic: Number(options.maxPerTopic || 2),
        relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
        relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
      },
    });

  let selectedCandidates = sharedSelectedCandidates.filter((candidate) => {
    const identityKey = candidate?.brief?.poolIdentityKey || getBriefIdentityKey(candidate?.brief);
    if (!identityKey) return true;
    if (isIdentityAlreadyPublished(identityKey)) {
      duplicateRejectedAtSelection.push({
        identityKey,
        title: candidate?.brief?.title || null,
        origin: candidate?.brief?._selectionOrigin || null,
        reason: 'identity_already_published_after_selection',
      });
      console.log(`[pipeline] Duplicate guard: drop selected candidate with published identity ${identityKey} :: ${candidate?.brief?.title || 'Untitled brief'}`);
      return false;
    }
    if (candidate?.brief) {
      candidate.brief.poolIdentityKey = candidate.brief.poolIdentityKey || identityKey;
    }
    return true;
  });

  const selectedIdentityKeys = selectedCandidates.map((candidate) => candidate?.brief?.poolIdentityKey).filter(Boolean);
  const readyBacklog = recordReadyArticleCandidates(candidatesAfterInventoryDedupe, {
    selectedIdentityKeys,
    limit: options.readyCandidateLimit || 10,
  });

  return {
    candidatesWithSources: candidatesAfterInventoryDedupe,
    selectedCandidates,
    readyBacklog,
    duplicateRejectedAtSelection,
    sourcePacksAssembled,
    publishableCandidates,
  };
}

function buildAggregateStageResult(stage, items = [], articleErrors = [], { allowFailures = false } = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const successCount = normalizedItems.filter((item) => item?.success).length;
  const failureCount = normalizedItems.length - successCount;
  const stageErrors = articleErrors.filter((entry) => entry.stage === stage);
  return {
    stage,
    success: allowFailures ? normalizedItems.length > 0 : successCount > 0,
    error: failureCount > 0 && !allowFailures ? stageErrors.map((entry) => `${entry.title}: ${entry.error}`).join(' | ') : null,
    data: {
      total: normalizedItems.length,
      successCount,
      failureCount,
      items: normalizedItems,
    },
  };
}

function buildPipelineResult(success, hard_blocker, published_path, verified_url, stages, selected, stats, extras = {}) {
  return {
    success,
    hard_blocker,
    published_path,
    verified_url,
    stages,
    selected,
    stats,
    published_paths: extras.published_paths || [],
    verified_urls: extras.verified_urls || [],
    selected_candidates: extras.selected_candidates || (selected ? [selected] : []),
    published_articles: extras.published_articles || [],
    quality_audit_path: extras.quality_audit_path || null,
  };
}

function evaluatePipelineRunForExit(result) {
  const reasons = [];
  const hardBlocker = String(result?.hard_blocker || '').trim();
  const rawArticlesPublished = Number(result?.stats?.articles_published);
  const publishedArticlesCount = Number.isFinite(rawArticlesPublished)
    ? rawArticlesPublished
    : Array.isArray(result?.published_articles)
      ? result.published_articles.length
      : Array.isArray(result?.published_paths)
        ? result.published_paths.length
        : 0;
  const hasNoPublishableCandidate = hardBlocker.toLowerCase().includes('no publishable candidate');

  const stageWasRun = (stageResult) => {
    if (!stageResult) return false;
    const total = Number(stageResult?.data?.total);
    if (Number.isFinite(total)) return total > 0;
    return true;
  };

  if (result?.success !== true) {
    reasons.push('final Success is false');
  }

  if (hardBlocker) {
    reasons.push(`hard blocker exists: ${hardBlocker}`);
  }

  if (!(publishedArticlesCount > 0)) {
    reasons.push('articles_published is 0');
  }

  if (hasNoPublishableCandidate) {
    reasons.push('no publishable candidate');
  }

  if (!stageWasRun(result?.stages?.articleDrafting)) {
    reasons.push('articleDrafting stage was not run');
  }

  if (!stageWasRun(result?.stages?.publishing)) {
    reasons.push('publishing stage was not run');
  }

  const normalizedBlocker = hardBlocker.toLowerCase();
  const controlledNoArticleFailure = reasons.length > 0
    && publishedArticlesCount === 0
    && (
      normalizedBlocker.includes('no publishable candidate')
      || normalizedBlocker.includes('source pack gate failed')
      || normalizedBlocker.includes('no candidates discovered')
      || normalizedBlocker.includes('no briefs normalized')
      || normalizedBlocker.includes('pre-draft quality gate failed')
      || normalizedBlocker.includes('duplicate guard')
      || normalizedBlocker.includes('direct-event sources')
      || normalizedBlocker.includes('pre-draft duplicate')
      || normalizedBlocker.includes('pre-draft direct-event source')
      || normalizedBlocker.includes('source_overlap>=2')
    );

  return {
    success: reasons.length === 0,
    reasons,
    articles_published: publishedArticlesCount,
    controlled_no_article_failure: controlledNoArticleFailure,
  };
}

/**
 * Generate URL-safe slug from title
 */
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 60);
}


function attachDiscoveryContext(normalizedBrief, candidates = [], limit = 5) {
  const primaryUrls = new Set((normalizedBrief.sourceUrls || []).map(url => normalizeUrl(url)));
  const topicTokens = getBriefMatchTokens(normalizedBrief);

  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => {
      const candidateUrl = normalizeUrl(candidate.sourceUrls?.[0] || candidate.url || '');
      const candidateText = `${candidate.title || ''} ${candidate.summary || ''}`.toLowerCase();
      const candidateTokens = getTextTokens(candidateText);
      const tokenHits = topicTokens.filter(token => candidateTokens.has(token)).length;
      const sharedUrl = candidateUrl && primaryUrls.has(candidateUrl);
      const sameTitle = normalizeTitle(candidate.title) === normalizeTitle(normalizedBrief.title);
      const score = (sharedUrl ? 6 : 0) + (sameTitle ? 5 : 0) + tokenHits;
      return { candidate, score, tokenHits, sharedUrl, sameTitle };
    })
    .filter(entry => {
      const samePrimaryUrl = normalizeUrl(entry.candidate.sourceUrls?.[0] || entry.candidate.url || '') && primaryUrls.has(normalizeUrl(entry.candidate.sourceUrls?.[0] || entry.candidate.url || ''));
      const selfTitleOnly = normalizeTitle(entry.candidate.title) === normalizeTitle(normalizedBrief.title) && samePrimaryUrl;
      if (selfTitleOnly) return false;
      return entry.sharedUrl || entry.sameTitle || entry.tokenHits >= 3;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.candidate.discoveredAt || 0) - new Date(a.candidate.discoveredAt || 0);
    })
    .slice(0, limit)
    .map(entry => entry.candidate);
}

function getBriefMatchTokens(brief) {
  return Array.from(new Set([
    brief.title,
    brief.whatHappened,
    brief.whoIsInvolved,
    ...(Array.isArray(brief.involvedParties) ? brief.involvedParties : []),
  ].flatMap(value => Array.from(getTextTokens(value)))));
}

function getTextTokens(value) {
  const stop = new Set(['the','and','for','with','from','that','this','into','after','over','under','have','has','had','are','was','were','will','would','could','should','news','latest','breaking','report','reports','says','said','amid']);
  return new Set(String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !stop.has(token)));
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

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Save pipeline result to file
 * @param {PipelineResult} result - Pipeline result
 * @param {string} outputPath - Output file path
 */
export function savePipelineResult(result, outputPath) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const output = {
    timestamp: new Date().toISOString(),
    success: result.success,
    hard_blocker: result.hard_blocker,
    published_path: result.published_path,
    verified_url: result.verified_url,
    stages: result.stages,
    selected: result.selected ? {
      brief: result.selected.brief,
      sourcePack: {
        eventId: result.selected.sourcePack.eventId,
        topic: result.selected.sourcePack.topic,
        sources: result.selected.sourcePack.sources.length,
        uniqueDomains: result.selected.sourcePack.uniqueDomains,
        credibilityScore: result.selected.sourcePack.credibilityScore,
        passesGate: result.selected.sourcePack.passesGate,
        gateNotes: result.selected.sourcePack.gateNotes,
      },
    } : null,
    stats: result.stats,
    quality_audit_path: result.quality_audit_path || result.stats?.quality_audit_path || null,
    published_paths: result.published_paths || [],
    verified_urls: result.verified_urls || [],
    selected_candidates: Array.isArray(result.selected_candidates)
      ? result.selected_candidates.map((candidate) => ({
          title: candidate?.brief?.title || null,
          topic: candidate?.sourcePack?.topic || null,
          section_id: candidate?.sourcePack?.section_id || candidate?.brief?.section_id || null,
          topic_id: candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || null,
        }))
      : [],
    published_articles: Array.isArray(result.published_articles)
      ? result.published_articles.map((candidate) => ({
          title: candidate?.draft?.title || candidate?.brief?.title || null,
          filePath: candidate?.publishResult?.filePath || null,
          verifiedUrl: candidate?.verification?.articleUrl || null,
        }))
      : [],
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`[pipeline] Result saved to: ${outputPath}`);
}

// Main entry point - run if executed directly
if (process.argv[1]?.endsWith('pipeline.js')) {
  (async () => {
    const lastResultPath = path.resolve(process.cwd(), 'qwen-data', 'events', 'pipeline-last-result.json');
    try {
      const result = await runEditorialPipeline({});
      console.log('\n[pipeline] === FINAL RESULT ===');
      console.log('Success:', result.success);
      if (result.hard_blocker) {
        console.log('Hard Blocker:', result.hard_blocker);
      }
      if (result.published_path) {
        console.log('Published Path:', result.published_path);
      }
      if (Array.isArray(result.published_paths) && result.published_paths.length > 1) {
        console.log('Published Paths:', result.published_paths.join(' | '));
      }
      if (result.verified_url) {
        console.log('Verified URL:', result.verified_url);
      }
      if (Array.isArray(result.verified_urls) && result.verified_urls.length > 1) {
        console.log('Verified URLs:', result.verified_urls.join(' | '));
      }
      console.log('Stage Results:');
      for (const [stage, stageResult] of Object.entries(result.stages)) {
        if (!stageResult) {
          console.log(`  ${stage}: NOT RUN`);
          continue;
        }
        console.log(`  ${stage}: ${stageResult.success ? 'PASS' : 'FAIL'}${stageResult.error ? ' - ' + stageResult.error : ''}`);
      }
      if (result.selected) {
        console.log('Selected topic:', result.selected.brief?.title);
        console.log('Draft word count:', result.selected.draft?.wordCount);
        console.log('Image provider:', result.selected.image?.provider);
      }
      if (Array.isArray(result.selected_candidates) && result.selected_candidates.length > 1) {
        console.log('Selected topics:', result.selected_candidates.map((candidate) => candidate?.brief?.title).filter(Boolean).join(' | '));
      }
      console.log('Stats:', JSON.stringify(result.stats, null, 2));

      savePipelineResult(result, lastResultPath);

      const exitEvaluation = evaluatePipelineRunForExit(result);
      if (!exitEvaluation.success) {
        console.error('[pipeline] FINAL STATUS: FAIL');
        console.error('[pipeline] Exit reason(s):', exitEvaluation.reasons.join(' | '));
        if (exitEvaluation.controlled_no_article_failure) {
          console.error('[pipeline] EXIT CLASS: controlled_no_article_failure');
          process.exit(1);
        }
        console.error('[pipeline] EXIT CLASS: unexpected_failure');
        process.exit(2);
      }

      console.log('[pipeline] FINAL STATUS: PASS');
      process.exit(0);
    } catch (error) {
      console.error('[pipeline] Fatal error:', error.message);
      const fatalResult = buildPipelineResult(false, `Fatal error: ${error.message}`, null, null, {}, null, { articles_published: 0 }, {});
      savePipelineResult(fatalResult, lastResultPath);
      process.exit(2);
    }
  })();
}
