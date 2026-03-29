// File: qwen-scripts/pipeline.js
// Purpose: Main pipeline runner - ties together all stages with correct execution order and honest success reporting
// End-to-end editorial pipeline from discovery to published article with verification

import fs from 'node:fs';
import path from 'node:path';

import { runDiscovery } from './discovery.js';
import { normalizeClusteredBrief, selectBestTopic } from './event-brief-builder.js';
import { clusterDiscoveredCandidates } from './nodes/event-clustering-node.js';
import { assembleSourcePack, selectPublishableCandidates } from './source-pack.js';
import { createClaimMap, validateClaimMap } from './claim-map.js';
import { draftArticle, hardenDraft } from './article-drafter.js';
import { generateImagePackage } from './nodes/image-node.js';
import { publishArticle } from './publisher.js';
import { validatePrePublishGraph, buildCanonicalPublishPayload, buildPublishManifest, writePublishManifest, validatePublishedArtifact, evaluateSourcePackEditorialIntegrity } from './validate-publish-graph.js';
import { repairContentPosts } from './repair-content-posts.js';
import { verifyLocalVisibility, generateVerificationReport } from './local-verification.js';
import { getProviderStats } from './utils/api-clients.js';
import { mergeBriefsIntoPool, mergeDiscoveredNews, getSelectableBriefs, getReadySelectableBriefs, dedupeBriefCandidates, markBriefPublished, markBriefSelected, getNewsPoolStats, recordReadyArticleCandidates } from './utils/news-pool.js';
import { writeQualityAuditRun } from './utils/quality-audit.js';

loadProjectEnv();

const ARTICLE_INVENTORY_PATH = path.resolve(process.cwd(), 'qwen-project-governance', 'article_inventory.md');
const RECENT_DUPLICATE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

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
 *   4. Claim Map Creation (GATE: must pass)
 *   5. Article Drafting
 *   6. Image Support
 *   7. Publish Article (GATE: must succeed)
 *   8. Verify Local Visibility (GATE: must pass)
 * 
 * @param {Object} options - Pipeline options
 * @returns {Promise<PipelineResult>} Pipeline result with honest success reporting
 */
export async function runEditorialPipeline(options = {}) {
  console.log('[pipeline] Starting editorial pipeline...');
  const startTime = Date.now();

  const stats = {
    discovery_candidates: 0,
    event_clusters: 0,
    briefs_normalized: 0,
    source_packs_assembled: 0,
    publishable_candidates: 0,
    selected_topic: null,
    selected_topics: [],
    articles_attempted: 0,
    articles_published: 0,
    news_pool: null,
    cache_stats: null,
    duration_ms: 0,
    ready_candidates: 0,
    additional_ready_candidates: 0,
  };

  const stageResults = {
    discovery: null,
    briefNormalization: null,
    sourcePackAssembly: null,
    claimMapCreation: null,
    articleDrafting: null,
    imageSupport: null,
    publishing: null,
    localVerification: null,
  };

  const runId = `pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = new Date(startTime).toISOString();

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
  const pixabayApiKey = process.env.PIXABAY_API_KEY;
  const googleApiKey = process.env.SEARCH_WEB_API;
  const googleCx = process.env.SEARCH_WEB_CX;

  console.log('[pipeline] API keys loaded:', {
    brave: !!braveApiKey,
    openai: !!openAiApiKey,
    pexels: !!pexelsApiKey,
    pixabay: !!pixabayApiKey,
    google: !!googleApiKey && !!googleCx,
  });

  const maxArticlesPerRun = resolveMaxArticlesPerRun(options);
  console.log(`[pipeline] Max articles per run: ${maxArticlesPerRun}`);

  let selected = null;
  let selectedCandidates = [];
  let publishedPath = null;
  let verifiedUrl = null;
  const publishedPaths = [];
  const verifiedUrls = [];
  const publishedArticles = [];

  let discoveryResult = null;
  let normalizedBriefs = null;
  let eventClusters = null;

  const repairResult = repairContentPosts();
  if (repairResult.changed > 0) {
    console.log(`[pipeline] Preflight content repair: changed=${repairResult.changed} removed_sources=${repairResult.removedSources}`);
  }

  // Stage 1: Discovery
  console.log('[pipeline] Stage 1: Discovery...');
  try {
    discoveryResult = await runDiscovery({ ...options, braveApiKey, googleApiKey, googleCx });
    stats.discovery_candidates = discoveryResult.candidates.length;
    console.log(`[pipeline] Discovery found ${stats.discovery_candidates} candidates`);

    const discoveredPoolStats = mergeDiscoveredNews(discoveryResult.candidates);
    stageResults.discovery = {
      stage: 'discovery',
      success: discoveryResult.candidates.length > 0,
      error: discoveryResult.candidates.length === 0 ? 'No candidates discovered' : null,
      data: { candidatesCount: discoveryResult.candidates.length, discoveredPoolTotal: discoveredPoolStats.total },
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
    normalizedBriefs = [];
    eventClusters = clusterDiscoveredCandidates(discoveryResult.candidates, { threshold: options.clusterThreshold || 6 });
    stats.event_clusters = eventClusters.length;
    const topClusters = eventClusters.slice(0, options.clusterSelectionLimit || 6);

    for (const cluster of topClusters) {
      try {
        const normalized = await normalizeClusteredBrief(cluster, openAiApiKey);
        normalized.discoveryContext = cluster.candidates || [];
        normalized.cluster_size = cluster.candidateCount;
        normalizedBriefs.push(normalized);
        stats.briefs_normalized++;
      } catch (error) {
        console.error(`[pipeline] Brief normalization failed: ${error.message}`);
      }
    }

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
    const candidatesWithSources = [];
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
    const readyBriefs = getReadySelectableBriefs({ limit: readyBriefLimit, includeSelected: true });
    const poolBriefs = getSelectableBriefs({
      limit: sourcePackCandidateLimit,
      prioritizeReady: true,
      readyBoost: Number(options.readyPriorityBoost || 10),
    });
    const mergedBriefs = dedupeBriefCandidates([
      ...normalizedBriefs.map((brief) => ({ ...brief, _selectionOrigin: 'current_run' })),
      ...readyBriefs,
      ...poolBriefs.map((brief) => ({ ...brief, _selectionOrigin: brief._selectionOrigin || 'pool' })),
    ]);

    const briefsForSelection = mergedBriefs.slice(0, sourcePackCandidateLimit);
    console.log(`[pipeline] Source-pack candidates from merged current+pool+ready set: ${briefsForSelection.length}`);
    if (readyBriefs.length > 0) {
      console.log(`[pipeline] Ready backlog prioritized for selection: ${readyBriefs.length}`);
    }
    if (briefsForSelection[0]?.selectionScore !== undefined) {
      console.log(`[pipeline] Top ranked brief score=${briefsForSelection[0].selectionScore} origin=${briefsForSelection[0]._selectionOrigin} title=${briefsForSelection[0].title}`);
    }

    for (const brief of briefsForSelection) {
      try {
        const sourcePack = await assembleSourcePack(brief, { ...options, braveApiKey, googleApiKey, googleCx });
        const stage3EditorialGate = evaluateSourcePackEditorialIntegrity({ brief, sourcePack });
        sourcePack.stage3EditorialGate = stage3EditorialGate;
        const stage3BlockingErrors = Array.isArray(stage3EditorialGate.blocking_errors) ? stage3EditorialGate.blocking_errors : [];
        const hardSourceIntegrityErrors = stage3BlockingErrors.filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
        const placementRepairErrors = stage3BlockingErrors.filter((message) => String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));

        if (hardSourceIntegrityErrors.length > 0) {
          const existingNotes = Array.isArray(sourcePack.gateNotes) ? sourcePack.gateNotes : [];
          sourcePack.passesGate = false;
          sourcePack.gateDecision = 'FAIL';
          sourcePack.gateNotes = Array.from(new Set([...existingNotes, ...hardSourceIntegrityErrors, ...stage3EditorialGate.warnings]));
          console.log(`[pipeline] Stage 3 aligned gate blocked :: ${brief.title} :: ${hardSourceIntegrityErrors.join(' | ')}`);
        } else {
          const advisoryNotes = [
            ...stage3EditorialGate.warnings,
            ...placementRepairErrors.map((message) => `${message} (deferred to placement repair)`),
          ];
          if (advisoryNotes.length > 0) {
            sourcePack.gateNotes = Array.from(new Set([...(Array.isArray(sourcePack.gateNotes) ? sourcePack.gateNotes : []), ...advisoryNotes]));
          }
          if (placementRepairErrors.length > 0) {
            console.log(`[pipeline] Stage 3 placement repair queued :: ${brief.title} :: ${placementRepairErrors.join(' | ')}`);
          }
        }

        candidatesWithSources.push({ brief, sourcePack });
        stats.source_packs_assembled++;

        if (sourcePack.passesGate) {
          stats.publishable_candidates++;
        }
      } catch (error) {
        console.error(`[pipeline] Source pack assembly failed: ${error.message}`);
      }
    }

    console.log(`[pipeline] Assembled ${stats.source_packs_assembled} source packs, ${stats.publishable_candidates} publishable`);

    const candidateSetForSelection = candidatesWithSources;
    selectedCandidates = selectPublishableCandidates(candidateSetForSelection, {
      maxArticlesPerRun,
      maxPerSection: Number(options.maxPerSection || 2),
      maxPerTopic: Number(options.maxPerTopic || 2),
      relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
      relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
    });
    selected = selectedCandidates[0] || null;

    const selectedIdentityKeys = selectedCandidates
      .map((candidate) => candidate?.brief?.poolIdentityKey)
      .filter(Boolean);

    const readyBacklog = recordReadyArticleCandidates(candidateSetForSelection, {
      selectedIdentityKeys,
      limit: options.readyCandidateLimit || 10,
    });
    stats.ready_candidates = readyBacklog.readyCount;
    stats.additional_ready_candidates = readyBacklog.additionalReadyCandidates.length;
    stats.articles_attempted = selectedCandidates.length;
    stats.selected_topic = selected?.brief?.title || null;
    stats.selected_topics = selectedCandidates.map((candidate) => candidate?.brief?.title).filter(Boolean);

    if (readyBacklog.additionalReadyCandidates.length > 0) {
      console.log(`[pipeline] Additional ready article candidates: ${readyBacklog.additionalReadyCandidates.length}`);
      for (const candidate of readyBacklog.additionalReadyCandidates.slice(0, 5)) {
        console.log(`[pipeline]   backlog rank=${candidate.rank} score=${candidate.score} section=${candidate.section_id || 'unassigned'} topic=${candidate.topic_id || 'unassigned'} title=${candidate.title}`);
      }
      console.log(`[pipeline] Ready candidate backlog saved: ${readyBacklog.filePath}`);
    }

    stageResults.sourcePackAssembly = {
      stage: 'sourcePackAssembly',
      success: selectedCandidates.length > 0,
      error: selectedCandidates.length === 0 ? 'No publishable candidates selected' : null,
      data: {
        selectedCount: selectedCandidates.length,
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
        },
      },
    };

    if (selectedCandidates.length === 0) {
      console.log('[pipeline] SOURCE PACK GATE: FAIL - No publishable candidate');
      return finalizePipelineResult(false, 'Source pack gate failed: No publishable candidate', null, {
        published_paths: [],
        verified_urls: [],
        selected_candidates: [],
        published_articles: [],
      });
    }

    for (const candidate of selectedCandidates) {
      if (candidate?.brief?.poolIdentityKey) {
        markBriefSelected(candidate.brief.poolIdentityKey);
      }
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

  // Stage 4-8: Per-article execution loop
  const claimMapItems = [];
  const draftItems = [];
  const imageItems = [];
  const publishItems = [];
  const verificationItems = [];
  const articleErrors = [];

  for (const candidate of selectedCandidates) {
    const articleLabel = candidate?.brief?.title || candidate?.sourcePack?.topic || 'Untitled candidate';
    console.log(`[pipeline] === Article run start: ${articleLabel} ===`);

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

      const imageResult = await generateImagePackage(candidate, slug, { pexelsApiKey, pixabayApiKey });
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

    // Stage 7: Publish Article (GATE)
    console.log('[pipeline] Stage 7: Publishing article...');
    try {
      const prePublishValidation = validatePrePublishGraph(candidate);
      if (!prePublishValidation.valid) {
        publishItems.push({
          title: articleLabel,
          success: false,
          error: `Pre-publish graph invalid: ${prePublishValidation.errors.join(', ')}`,
          data: { warnings: prePublishValidation.warnings, placement: prePublishValidation.placement },
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

    // Stage 8: Local Visibility Verification (GATE)
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

  stageResults.claimMapCreation = buildAggregateStageResult('claimMapCreation', claimMapItems, articleErrors);
  stageResults.articleDrafting = buildAggregateStageResult('articleDrafting', draftItems, articleErrors);
  stageResults.imageSupport = buildAggregateStageResult('imageSupport', imageItems, articleErrors, { allowFailures: true });
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
  const searchTokens = Array.from(new Set([
    ...titleTokens,
    ...selectionTokens(sourcePack?.topic || ''),
    ...selectionTokens((brief.entities || brief.involvedParties || []).join(' ')),
  ]));
  const topicId = getCandidateSelectionTopicId(candidate);

  return inventoryEntries.some((entry) => {
    const entryTitleTokens = selectionTokens(entry.title);
    const entryKeywordTokens = selectionTokens((entry.search_keywords || []).join(' '));
    const titleOverlap = overlapCount(titleTokens, entryTitleTokens);
    const keywordOverlap = overlapCount(searchTokens, entryKeywordTokens);
    const sameTopic = topicId && topicId === String(entry.topic_id || '').trim().toLowerCase();

    if (titleOverlap >= 4) return true;
    if (sameTopic && titleOverlap >= 3) return true;
    if (titleOverlap >= 3 && keywordOverlap >= 3) return true;
    return false;
  });
}

function filterRecentDuplicateCandidates(candidates) {
  const recentInventory = loadRecentPublishedInventory();
  if (!recentInventory.length) return Array.isArray(candidates) ? candidates : [];
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !isRecentDuplicateCandidate(candidate, recentInventory));
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
    } catch (error) {
      console.error('[pipeline] Fatal error:', error.message);
      process.exit(1);
    }
  })();
}
