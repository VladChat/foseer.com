// File: qwen-scripts/qna-pipeline.js
// Purpose: Run an isolated question-led article pipeline that reuses shared discovery cache and downstream editorial modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDiscovery } from './discovery.js';
import { normalizeClusteredBrief } from './event-brief-builder.js';
import { clusterDiscoveredCandidates } from './nodes/event-clustering-node.js';
import { assembleSourcePack } from './source-pack.js';
import { classifySourceRole } from './nodes/source-role-node.js';
import { createClaimMap, validateClaimMap } from './claim-map.js';
import { draftArticle, hardenDraft } from './article-drafter.js';
import { generateImagePackage } from './nodes/image-node.js';
import { publishArticle } from './publisher.js';
import { validatePrePublishGraph, buildCanonicalPublishPayload, buildPublishManifest, writePublishManifest, validatePublishedArtifact, evaluateSourcePackEditorialIntegrity } from './validate-publish-graph.js';
import { mergeDiscoveredNews, mergeBriefsIntoPool, getSelectableBriefs, getReadySelectableBriefs, dedupeBriefCandidates, markBriefSelected, markBriefPublished, getNewsPoolStats } from './utils/news-pool.js';
import { braveNewsSearch, gdeltSearch, getProviderStats, googleSearch } from './utils/api-clients.js';
import { normalizeSourceMaterial } from './utils/source-normalization.js';
import { writeQualityAuditRun } from './utils/quality-audit.js';
import { extractQuestionCandidates } from './question-extractor.js';
import { OFFICIAL_PRIMARY_DOMAINS, TRUSTED_PUBLISHER_DOMAINS, normalizeDomain } from './config/trusted-publishers.js';

loadProjectEnv();

const QUESTIONS_DIR = path.resolve(process.cwd(), 'qwen-data', 'questions');
const QNA_LAST_RESULT_PATH = path.resolve(process.cwd(), 'qwen-data', 'events', 'qna-pipeline-last-result.json');

export async function runQnaPipeline(options = {}) {
  ensureQuestionsDir();
  const startTime = Date.now();
  const runId = `qna-pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const workflowLeaseOwner = {
    workflow: String(process.env.GITHUB_WORKFLOW || 'QnA Pipeline').trim() || 'QnA Pipeline',
    runId: String(process.env.GITHUB_RUN_ID || runId).trim() || runId,
    leaseMinutes: Number(options.selectionLeaseMinutes || process.env.SELECTION_LEASE_MINUTES || 75),
  };
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  const googleApiKey = process.env.SEARCH_WEB_API;
  const googleCx = process.env.SEARCH_WEB_CX;
  const pexelsApiKey = process.env.PEXELS_API_KEY;
  const unsplashApiKey = process.env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_API_KEY;
  const pixabayApiKey = process.env.PIXABAY_API_KEY;

  const result = {
    started_at: new Date(startTime).toISOString(),
    success: false,
    runId,
    mode: 'question-led',
    used_shared_discovery_cache: true,
    selected_question: null,
    published_path: null,
    published_url: null,
    stats: {
      cache_stats: null,
      duration_ms: 0,
      news_pool: getNewsPoolStats(),
      brief_candidates: 0,
      question_candidates: 0,
      source_pack_attempts: 0,
      source_pack_near_miss: 0,
      source_pack_rescue_attempts: 0,
      source_pack_rescue_successes: 0,
    },
    stages: {},
    artifacts: {},
    hard_blocker: null,
    rejection_report: {
      pre_selection: [],
      brief_source_pack: [],
      source_pack: [],
    },
  };

  const candidateLimit = Math.max(4, Number(options.candidateLimit || process.env.QNA_BRIEF_CANDIDATE_LIMIT || 8));
  const sourcePackTryLimit = Math.max(1, Number(options.sourcePackTryLimit || process.env.QNA_SOURCE_PACK_TRY_LIMIT || candidateLimit));

  let briefs = loadSharedBriefCandidates(candidateLimit, { leaseOwner: workflowLeaseOwner });
  result.stats.brief_candidates = briefs.length;
  result.stages.shared_cache_load = {
    success: briefs.length > 0,
    count: briefs.length,
    source: briefs.length > 0 ? 'shared-news-pool' : 'empty',
  };

  if (briefs.length === 0) {
    const refreshed = await refreshSharedDiscoveryCache({
      braveApiKey,
      googleApiKey,
      googleCx,
      openAiApiKey,
      candidateLimit,
      leaseOwner: workflowLeaseOwner,
    });
    briefs = refreshed.briefs;
    result.stages.discovery_refresh = refreshed.stage;
    result.stats.brief_candidates = briefs.length;
  }

  if (briefs.length === 0) {
    result.hard_blocker = 'No brief candidates available from shared discovery cache';
    return finalizeRun(result, [], null, startTime);
  }

  let screened = await screenBriefSourcePackViability(briefs, {
    options,
    braveApiKey,
    googleApiKey,
    googleCx,
  });
  result.stats.source_pack_attempts += screened.attempted;
  result.stats.source_pack_near_miss += Number(screened?.rescue?.nearMissTotal || 0);
  result.stats.source_pack_rescue_attempts += Number(screened?.rescue?.attempted || 0);
  result.stats.source_pack_rescue_successes += Number(screened?.rescue?.rescued || 0);
  result.rejection_report.brief_source_pack.push(...screened.rejections);
  result.stages.brief_source_pack_gate = {
    success: screened.viableBriefs.length > 0,
    attempted: screened.attempted,
    passed: screened.viableBriefs.length,
    rescue: screened.rescue || null,
    rejected: screened.rejections,
  };

  if (screened.viableBriefs.length === 0) {
    const refreshed = await refreshSharedDiscoveryCache({
      braveApiKey,
      googleApiKey,
      googleCx,
      openAiApiKey,
      candidateLimit: Math.max(candidateLimit * 2, 12),
      leaseOwner: workflowLeaseOwner,
    });
    result.stages.discovery_refresh = refreshed.stage;
    result.stats.brief_candidates = refreshed.briefs.length;
    if (refreshed.briefs.length > 0) {
      screened = await screenBriefSourcePackViability(refreshed.briefs, {
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
      });
      result.stats.source_pack_attempts += screened.attempted;
      result.stats.source_pack_near_miss += Number(screened?.rescue?.nearMissTotal || 0);
      result.stats.source_pack_rescue_attempts += Number(screened?.rescue?.attempted || 0);
      result.stats.source_pack_rescue_successes += Number(screened?.rescue?.rescued || 0);
      result.rejection_report.brief_source_pack.push(...screened.rejections);
      result.stages.brief_source_pack_gate = {
        success: screened.viableBriefs.length > 0,
        attempted: (result.stages.brief_source_pack_gate?.attempted || 0) + screened.attempted,
        passed: screened.viableBriefs.length,
        rescue: mergeRescueDiagnostics(result.stages.brief_source_pack_gate?.rescue, screened.rescue),
        rejected: result.rejection_report.brief_source_pack,
      };
    }
  }

  if (screened.viableBriefs.length === 0) {
    result.hard_blocker = 'No brief candidate passed source-pack viability gate';
    return finalizeRun(result, [], null, startTime);
  }

  const questionCandidates = await extractQuestionCandidates(screened.viableBriefs, openAiApiKey, {});
  const extractionModels = Array.from(new Set(questionCandidates.map((candidate) => candidate.model).filter(Boolean)));
  console.log(`[qna-pipeline] Question extraction model(s): ${extractionModels.length > 0 ? extractionModels.join(', ') : 'fallback-only'}`);
  result.stats.question_candidates = questionCandidates.length;
  result.stages.question_extraction = {
    success: questionCandidates.some((candidate) => candidate.selection_eligible),
    count: questionCandidates.length,
    valid_count: questionCandidates.filter((candidate) => candidate.valid).length,
    eligible_count: questionCandidates.filter((candidate) => candidate.selection_eligible).length,
    models: extractionModels,
  };

  const questionArtifactPath = writeQuestionArtifacts(runId, questionCandidates);
  result.artifacts.question_candidates = questionArtifactPath;

  const eligibleQuestions = [];
  for (const candidate of questionCandidates) {
    const rejectionReasons = [];
    if (candidate.valid === false) {
      rejectionReasons.push(candidate.invalid_reason || 'Candidate failed question validation');
    }
    if (candidate.selection_eligible === false) {
      rejectionReasons.push(...(Array.isArray(candidate.rejection_reasons) ? candidate.rejection_reasons : ['Candidate not selection eligible']));
    }

    if (rejectionReasons.length > 0) {
      const rejection = {
        question: candidate.question,
        brief_title: candidate.briefTitle,
        provider: candidate.provider,
        model: candidate.model,
        reasons: Array.from(new Set(rejectionReasons)),
      };
      result.rejection_report.pre_selection.push(rejection);
      console.log(`[qna-pipeline] Rejecting candidate before source-pack :: ${candidate.question} :: ${rejection.reasons.join(' | ')}`);
      continue;
    }

    console.log(`[qna-pipeline] Candidate eligible for source-pack :: ${candidate.question} :: score=${candidate.selection_score} :: provider=${candidate.provider}${candidate.model ? ` :: model=${candidate.model}` : ''}`);
    eligibleQuestions.push(candidate);
  }

  const rankedQuestions = [...eligibleQuestions]
    .sort((left, right) => Number(right.selection_score || 0) - Number(left.selection_score || 0));

  result.stages.question_filtering = {
    success: rankedQuestions.length > 0,
    total_candidates: questionCandidates.length,
    eligible_candidates: rankedQuestions.length,
    rejected_candidates: result.rejection_report.pre_selection,
  };

  const sourcePackAttemptQuestions = rankedQuestions.slice(0, Math.max(sourcePackTryLimit, 2));
  let selected = null;
  let selectedMode = 'question-led';

  if (rankedQuestions.length === 0) {
    const standardFallback = await buildStandardFallbackSelection({
      viableBriefs: screened.viableBriefs,
      sourcePackByKey: screened.sourcePackByKey,
      options,
      braveApiKey,
      googleApiKey,
      googleCx,
      result,
      usedBriefKeys: new Set(),
      reason: 'no_viable_question_candidates_after_quality_filtering',
    });
    if (standardFallback) {
      selected = standardFallback;
      selectedMode = 'standard-fallback';
      result.stages.question_filtering.fallback_to_standard = {
        used: true,
        reason: 'No viable question candidate survived filtering',
        brief_title: selected.brief?.title || null,
      };
    } else {
      result.hard_blocker = 'No viable question candidates after quality filtering';
      return finalizeRun(result, questionCandidates, null, startTime);
    }
  }

  if (!selected) {
    for (const questionCandidate of sourcePackAttemptQuestions) {
      const brief = questionCandidate.brief;
      const briefKey = getBriefCandidateKey(brief);
      let sourcePack = screened.sourcePackByKey.get(briefKey) || null;
      console.log(`[qna-pipeline] Source-pack attempt (prevalidated=${sourcePack ? 'yes' : 'no'}) :: ${questionCandidate.question} :: score=${questionCandidate.selection_score}`);
      try {
        if (!sourcePack) {
          result.stats.source_pack_attempts += 1;
          sourcePack = await assembleSourcePack({
            ...brief,
            articleType: resolveQuestionArticleType(questionCandidate),
          }, {
            ...options,
            braveApiKey,
            googleApiKey,
            googleCx,
            articleType: resolveQuestionArticleType(questionCandidate),
          });
        }

        const editorialGate = evaluateSourcePackEditorialIntegrity({ brief, sourcePack });
        sourcePack.stage3EditorialGate = editorialGate;
        const hardErrors = (editorialGate.blocking_errors || []).filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
        if (hardErrors.length > 0) {
          sourcePack.passesGate = false;
          sourcePack.gateDecision = 'FAIL';
          sourcePack.gateNotes = Array.from(new Set([...(sourcePack.gateNotes || []), ...hardErrors]));
        }

        if (!sourcePack.passesGate) {
          questionCandidate.source_pack_gate = {
            passes: false,
            notes: sourcePack.gateNotes || [],
          };
          const reasons = Array.from(new Set(sourcePack.gateNotes || ['Source-pack gate failed']));
          result.rejection_report.source_pack.push({
            question: questionCandidate.question,
            brief_title: questionCandidate.briefTitle,
            reasons,
          });
          console.log(`[qna-pipeline] Source-pack rejected :: ${questionCandidate.question} :: ${reasons.join(' | ')}`);
          continue;
        }

        questionCandidate.source_pack_gate = {
          passes: true,
          notes: [],
        };
        console.log(`[qna-pipeline] Source-pack passed :: ${questionCandidate.question}`);

        selected = {
          brief,
          questionCandidate,
          sourcePack,
        };
        break;
      } catch (error) {
        questionCandidate.source_pack_gate = {
          passes: false,
          notes: [`Source-pack assembly error: ${error.message}`],
        };
        result.rejection_report.source_pack.push({
          question: questionCandidate.question,
          brief_title: questionCandidate.briefTitle,
          reasons: questionCandidate.source_pack_gate.notes,
        });
        console.log(`[qna-pipeline] Source-pack error :: ${questionCandidate.question} :: ${error.message}`);
      }
    }
  }

  if (!selected) {
    const usedBriefKeys = new Set(sourcePackAttemptQuestions.map((candidate) => getBriefCandidateKey(candidate?.brief)));
    const standardFallback = await buildStandardFallbackSelection({
      viableBriefs: screened.viableBriefs,
      sourcePackByKey: screened.sourcePackByKey,
      options,
      braveApiKey,
      googleApiKey,
      googleCx,
      result,
      usedBriefKeys,
      reason: 'question_candidates_failed_source_pack',
    });
    if (standardFallback) {
      selected = standardFallback;
      selectedMode = 'standard-fallback';
      result.stages.source_pack_selection_fallback = {
        used: true,
        reason: 'Question framing failed source-pack, standard mode selected',
        brief_title: selected.brief?.title || null,
      };
    }
  }

  result.stages.source_pack_selection = {
    success: !!selected,
    attempted: sourcePackAttemptQuestions.length,
    selected_question: selected?.questionCandidate?.question || null,
    selected_mode: selectedMode,
    rejected_candidates: result.rejection_report.source_pack,
  };

  if (!selected) {
    result.hard_blocker = 'No question candidate passed source-pack assembly (see rejection_report)';
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  result.selected_question = {
    question: selected.questionCandidate?.question || null,
    question_type: selected.questionCandidate?.question_type || null,
    score: selected.questionCandidate?.score || null,
    selection_score: selected.questionCandidate?.selection_score || null,
    signal: selected.questionCandidate?.signal || null,
    mode: selectedMode,
    brief_title: selected.brief.title,
    source_pack_sources: selected.sourcePack.sources?.length || 0,
    source_pack_domains: selected.sourcePack.uniqueDomains || 0,
  };

  if (selected.brief.poolIdentityKey) {
    markBriefSelected(selected.brief.poolIdentityKey, workflowLeaseOwner);
  }

  try {
    const claimMap = await createClaimMap(selected.sourcePack, openAiApiKey);
    selected.claimMap = claimMap;
    const claimValidation = validateClaimMap(claimMap);
    result.stages.claim_map = {
      success: claimValidation.passes,
      issues: claimValidation.issues,
      supported_claims: claimMap.supportedClaims,
      total_claims: claimMap.totalClaims,
    };
    if (!claimValidation.passes) {
      result.hard_blocker = `Claim map failed: ${claimValidation.issues.join('; ')}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }
  } catch (error) {
    result.stages.claim_map = { success: false, error: error.message };
    result.hard_blocker = `Claim map failed: ${error.message}`;
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  try {
    const briefForDraft = selectedMode === 'standard-fallback'
      ? buildStandardFallbackDraftBrief(selected.brief)
      : buildQuestionDraftBrief(selected.brief, selected.questionCandidate);
    const draft = await draftArticle(briefForDraft, selected.sourcePack, selected.claimMap, openAiApiKey);
    const hardened = hardenDraft(draft, selected.claimMap);
    selected.briefForDraft = briefForDraft;
    selected.draft = hardened;
    selected.publishIdentity = {
      title: hardened.title,
      slug: generateSlug(hardened.title),
    };
    selected.articleSlug = selected.publishIdentity.slug;
    result.stages.draft = {
      success: hardened.safeForPublishing,
      quality: hardened.quality,
      word_count: hardened.wordCount,
      article_type: hardened.articleType,
      title: hardened.title,
    };
    if (!hardened.safeForPublishing) {
      result.hard_blocker = `Draft not safe for publishing: ${(hardened.qualityIssues || []).join('; ')}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }
  } catch (error) {
    result.stages.draft = { success: false, error: error.message };
    result.hard_blocker = `Draft failed: ${error.message}`;
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  try {
    const imageResult = await generateImagePackage(selected, selected.articleSlug, { pexelsApiKey, unsplashApiKey, pixabayApiKey });
    selected.image = imageResult;
    result.stages.image = {
      success: true,
      provider: imageResult.provider,
      imagePath: imageResult.imagePath,
    };
  } catch (error) {
    result.stages.image = { success: false, error: error.message };
  }

  try {
    const prePublishValidation = validatePrePublishGraph(selected);
    if (!prePublishValidation.valid) {
      result.stages.publish_validation = {
        success: false,
        errors: prePublishValidation.errors,
        warnings: prePublishValidation.warnings,
      };
      result.hard_blocker = `Pre-publish validation failed: ${prePublishValidation.errors.join('; ')}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }

    selected.canonicalPublishPayload = prePublishValidation.canonical_publish_payload || buildCanonicalPublishPayload(selected, prePublishValidation);
    selected.placement = {
      ...(selected.placement || {}),
      ...(selected.canonicalPublishPayload?.placement || {}),
    };
    if (selected.canonicalPublishPayload?.tagging) {
      const tagging = selected.canonicalPublishPayload.tagging;
      selected.draft = {
        ...(selected.draft || {}),
        tags: Array.isArray(tagging.tags) ? tagging.tags : (selected.draft?.tags || []),
        tag_slugs: Array.isArray(tagging.tag_slugs) ? tagging.tag_slugs : (selected.draft?.tag_slugs || []),
        subsection: selected.canonicalPublishPayload?.placement?.subsection || selected.draft?.subsection,
        topics: Array.isArray(selected.canonicalPublishPayload?.placement?.topics)
          ? selected.canonicalPublishPayload.placement.topics
          : (selected.draft?.topics || []),
        metadata: {
          ...(selected.draft?.metadata || {}),
          tagging,
          questionIntent: selected.questionCandidate,
        },
      };
    }
    if (selected.sourcePack && Array.isArray(selected.canonicalPublishPayload?.sources)) {
      selected.sourcePack.publicSources = selected.canonicalPublishPayload.sources;
      selected.sourcePack.canonicalPublicSources = selected.canonicalPublishPayload.sources;
    }
    selected.publishManifest = buildPublishManifest(selected);
    const publishResult = publishArticle(selected);
    selected.publishResult = publishResult;

    if (!publishResult.success) {
      result.stages.publish = { success: false, error: publishResult.error };
      result.hard_blocker = `Publish failed: ${publishResult.error}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }

    selected.placement = { ...(selected.placement || {}), ...(publishResult.placement || {}) };
    selected.publishManifest = buildPublishManifest(selected, publishResult);
    selected.publishManifestPath = writePublishManifest(selected.publishManifest);
    const artifactValidation = validatePublishedArtifact(publishResult.filePath, selected.publishManifest);
    if (!artifactValidation.valid) {
      result.stages.publish = { success: false, error: artifactValidation.errors.join('; ') };
      result.hard_blocker = `Published artifact validation failed: ${artifactValidation.errors.join('; ')}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }

    result.success = true;
    result.published_path = publishResult.filePath;
    result.published_url = publishResult.expectedUrl;
    result.artifacts.publish_manifest = selected.publishManifestPath || null;
    result.stages.publish = {
      success: true,
      filename: publishResult.filename,
      expectedUrl: publishResult.expectedUrl,
    };

    if (selected.brief.poolIdentityKey) {
      markBriefPublished(selected.brief.poolIdentityKey, publishResult.canonicalSlug || publishResult.slug || selected.articleSlug);
    }
  } catch (error) {
    result.stages.publish = { success: false, error: error.message };
    result.hard_blocker = `Publish failed: ${error.message}`;
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  return finalizeRun(result, questionCandidates, selected, startTime);
}

function buildQuestionDraftBrief(brief, questionCandidate) {
  const question = String(questionCandidate?.question || '').trim();
  const uncertainty = String(questionCandidate?.uncertainty || '').trim();
  const stakes = String(questionCandidate?.stakes || '').trim();
  const readerQuestionLine = question ? `Reader question: ${question}` : '';
  const focusLine = [uncertainty && `Core uncertainty: ${uncertainty}`, stakes && `Stakes: ${stakes}`].filter(Boolean).join(' ');
  const mergedWhatHappened = [brief?.whatHappened, readerQuestionLine].filter(Boolean).join(' ');
  const mergedWhyItMatters = [brief?.whyItMatters, focusLine].filter(Boolean).join(' ');

  return {
    ...brief,
    articleType: resolveQuestionArticleType(questionCandidate),
    title: question ? `${brief?.title || 'Developing story'} — ${question}` : brief?.title,
    whatHappened: mergedWhatHappened || brief?.whatHappened || brief?.title,
    whyItMatters: mergedWhyItMatters || brief?.whyItMatters,
    summary: [readerQuestionLine, focusLine].filter(Boolean).join(' ') || brief?.summary || brief?.whyItMatters || brief?.whatHappened,
  };
}

function buildStandardFallbackDraftBrief(brief = {}) {
  return {
    ...brief,
    articleType: String(brief?.articleType || 'analysis').toLowerCase() === 'report' ? 'report' : 'analysis',
    title: brief?.title || 'Developing story',
    summary: brief?.summary || brief?.whyItMatters || brief?.whatHappened || brief?.title || 'Developing story',
  };
}

function resolveQuestionArticleType(questionCandidate) {
  const type = String(questionCandidate?.question_type || '').toLowerCase();
  if (type === 'meaning') return 'explainer';
  return 'analysis';
}

function loadSharedBriefCandidates(limit, { leaseOwner = null } = {}) {
  const wideLimit = Math.max(limit * 3, 24);
  const readyBriefs = getReadySelectableBriefs({ limit: wideLimit, includeSelected: false, leaseOwner });
  const poolBriefs = getSelectableBriefs({ limit: wideLimit, prioritizeReady: true, readyBoost: 8, leaseOwner });
  const merged = dedupeBriefCandidates([...readyBriefs, ...poolBriefs])
    .filter(isLikelyViableBrief)
    .sort((left, right) => Number(right.selectionScore || 0) - Number(left.selectionScore || 0));
  return merged.slice(0, Math.max(limit, 12));
}

async function refreshSharedDiscoveryCache({ braveApiKey, googleApiKey, googleCx, openAiApiKey, candidateLimit, leaseOwner = null }) {
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
    const clusters = clusterDiscoveredCandidates(discoveryResult.candidates, { threshold: 6 });
    const normalizedBriefs = [];
    for (const cluster of clusters.slice(0, Math.max(candidateLimit, 6))) {
      const normalized = await normalizeClusteredBrief(cluster, openAiApiKey);
      normalized.discoveryContext = cluster.candidates || [];
      normalized.cluster_size = cluster.candidateCount;
      normalizedBriefs.push(normalized);
    }

    stage.normalized = normalizedBriefs.length;
    mergeBriefsIntoPool(normalizedBriefs);
    stage.success = normalizedBriefs.length > 0;
    return {
      briefs: loadSharedBriefCandidates(candidateLimit, { leaseOwner }),
      stage,
    };
  } catch (error) {
    stage.error = error.message;
    return { briefs: [], stage };
  }
}

function writeQuestionArtifacts(runId, questionCandidates) {
  ensureQuestionsDir();
  const payload = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    items: questionCandidates.map((candidate) => ({
      brief_title: candidate.briefTitle,
      question: candidate.question,
      question_type: candidate.question_type,
      score: candidate.score,
      selection_score: candidate.selection_score,
      uncertainty: candidate.uncertainty,
      stakes: candidate.stakes,
      time_horizon: candidate.time_horizon,
      valid: candidate.valid,
      selection_eligible: candidate.selection_eligible,
      invalid_reason: candidate.invalid_reason || null,
      rejection_reasons: Array.isArray(candidate.rejection_reasons) ? candidate.rejection_reasons : [],
      provider: candidate.provider,
      model: candidate.model || null,
      note: candidate.note || null,
      poolIdentityKey: candidate.poolIdentityKey,
      source_pack_gate: candidate.source_pack_gate || null,
    })),
  };
  const filePath = path.resolve(QUESTIONS_DIR, `${runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.writeFileSync(path.resolve(QUESTIONS_DIR, 'latest-question-candidates.json'), JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
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
        console.log(`[qna-pipeline] Brief source-pack rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      sourcePackByKey.set(briefKey, sourcePack);
      viableBriefs.push(brief);
      rescueDiagnostics.pre_rescue_passed += 1;
      console.log(`[qna-pipeline] Brief source-pack passed :: ${brief.title || 'untitled'} :: sources=${sourcePack.sources?.length || 0} domains=${sourcePack.uniqueDomains || 0}`);
    } catch (error) {
      const reasons = [`Source-pack assembly error: ${error.message}`];
      rejectionByBriefKey.set(briefKey, {
        brief_title: brief.title || null,
        poolIdentityKey: brief.poolIdentityKey || null,
        reasons,
      });
      console.log(`[qna-pipeline] Brief source-pack error :: ${brief.title || 'untitled'} :: ${error.message}`);
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
    console.log(`[qna-pipeline] Brief source-pack near-miss rescue :: ${brief.title || 'untitled'}`);
    try {
      const rescueResult = await runNearMissSourcePackRescue({
        brief,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
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
        console.log(`[qna-pipeline] Brief source-pack rescue rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      const retriedSourcePack = rescueResult.sourcePack;
      rejectionByBriefKey.delete(briefKey);
      sourcePackByKey.set(briefKey, retriedSourcePack);
      if (!viableBriefs.some((item) => getBriefCandidateKey(item) === briefKey)) {
        viableBriefs.push(brief);
      }
      rescueDiagnostics.rescued += 1;
      console.log(`[qna-pipeline] Brief source-pack rescue passed :: ${brief.title || 'untitled'} :: sources=${retriedSourcePack.sources?.length || 0} domains=${retriedSourcePack.uniqueDomains || 0}`);
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
      console.log(`[qna-pipeline] Brief source-pack rescue error :: ${brief.title || 'untitled'} :: ${error.message}`);
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

export async function screenQnaBriefViabilityForTesting(briefs = [], options = {}) {
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
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return TRUSTED_PUBLISHER_DOMAINS.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
}

function isOfficialPrimaryDomainForRescue(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return OFFICIAL_PRIMARY_DOMAINS.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`));
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
    failure_codes: [],
  };

  const rescuedCandidates = [];
  let braveRescueUsed = false;

  for (const queryEntry of queryPlan) {
    const level = String(queryEntry.level || 'strict');
    const intent = String(queryEntry.intent || 'general');
    const query = String(queryEntry.query || '').trim();
    if (!query) continue;

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
    diagnostics.cluster_coherence = clusterView?.dominantCoherence ?? null;
    if (isRescueRoleCoverageReady(roleCoverage)) {
      break;
    }
  }

  if (rescueNeedsBraveFallback(diagnostics.role_coverage) && !braveRescueUsed) {
    const braveQuery = queryPlan.find((entry) => entry.level === 'broad') || queryPlan[queryPlan.length - 1] || null;
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
  diagnostics.cluster_coherence = clusterView?.dominantCoherence ?? null;

  if ((clusterView.totalCandidates || 0) === 0) {
    diagnostics.failure_codes = ['generic_sources_only', 'thin_pack_after_rescue'];
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
  const requiresOfficial = Array.isArray(failureCodes) && failureCodes.includes('missing_official');
  const officialDomainTargets = buildRescueOfficialDomainTargets(brief, {
    requireOfficial: requiresOfficial,
    entityProfile: entity,
  });
  const officialDomainClause = officialDomainTargets.length > 0
    ? `(${officialDomainTargets.slice(0, 4).map((domain) => `site:${domain}`).join(' OR ')})`
    : '';

  const strictAnchor = compactRescueText([mainEntity, title, aliases[0], eventType, dateToken].filter(Boolean).join(' '), 24);
  const relaxedAnchor = compactRescueText([mainEntity || title, aliases[0], broadTopic, eventType].filter(Boolean).join(' '), 22);
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
      intent: 'trusted_reporting',
      query: compactRescueText(`${broadAnchor} ${mainEntity || ''} (news analysis OR report OR investigation)`, 30),
      targetedDomains: [],
    },
    {
      level: 'broad',
      intent: 'official_primary',
      query: compactRescueText(`${mainEntity || broadAnchor} ${eventType} (newsroom OR regulator OR agency OR court OR league OR team OR university OR journal OR investor relations) ${officialDomainClause}`, 36),
      targetedDomains: officialDomainTargets,
    },
  );

  return queries
    .filter((entry) => String(entry.query || '').trim().length >= 8)
    .slice(0, Math.max(3, Math.min(5, maxQueries)));
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
} = {}) {
  const providerStatus = [];
  const rawCandidates = [];
  let genericFiltered = 0;

  if (googleApiKey && googleCx) {
    try {
      const googleResult = await googleSearch(query, googleApiKey, googleCx, {
        num: 8,
        dateRestrict: 'd7',
        logLabel: `qna_rescue_google_${level}`,
      });
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
  }

  if (includeGdelt) {
    try {
      const gdeltResult = await gdeltSearch(query, {
        maxRecords: 12,
        timespan: '7days',
        sort: 'DateDesc',
        logLabel: `qna_rescue_gdelt_${level}`,
      });
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
  }

  if (includeBrave && braveApiKey) {
    try {
      const braveResult = await braveNewsSearch(query, braveApiKey, {
        count: 8,
        freshness: 'pw',
        logLabel: `qna_rescue_brave_${level}`,
      });
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
    if (String(roleResult?.role || '') === 'reject' && Number(roleResult?.same_event_score || 0) < 3) {
      continue;
    }
    if (Number(roleResult?.same_event_score || 0) < 2 && String(roleResult?.role || '') === 'signal_only') {
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

  return {
    totalCandidates: deduped.length,
    clusters: scoredClusters,
    dominantEntries: scoredClusters[0]?.entries || [],
    dominantCoherence: Number(scoredClusters[0]?.coherenceScore || 0),
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
  let briefOverlap = 0;
  for (const token of leftTokens) {
    if (briefTokens.has(token)) briefOverlap += 1;
  }
  for (const token of rightTokens) {
    if (briefTokens.has(token)) briefOverlap += 1;
  }

  const entity = entityProfile || inferRescueEntityProfile(brief);
  const leftEntityCoherence = computeRescueEntityCoherence(left, brief, entity);
  const rightEntityCoherence = computeRescueEntityCoherence(right, brief, entity);

  if (titleOverlap >= 2) return true;
  if (entityOverlap >= 1 && (leftSameEvent >= 3 || rightSameEvent >= 3)) return true;
  if (briefOverlap >= 2 && leftSameEvent >= 3 && rightSameEvent >= 3) return true;
  if (leftEntityCoherence >= 0.5 && rightEntityCoherence >= 0.5 && (leftSameEvent >= 3 || rightSameEvent >= 3)) return true;
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

  const independentConfirming = pickUniqueDomainEntries(confirmingCandidates, 4);
  const optionalContext = pickUniqueDomainEntries(optional, 4);
  return {
    totalCandidates: candidates.length,
    primary_or_official: { count: primaryOfficial.length, items: pickUniqueDomainEntries(primaryOfficial, 4) },
    trusted_reporting: { count: trusted.length, items: pickUniqueDomainEntries(trusted, 4) },
    independent_confirming: { count: independentConfirming.length, items: independentConfirming },
    optional_context: { count: optionalContext.length, items: optionalContext },
    unique_domains: new Set(candidates.map((entry) => normalizeDomain(entry?.source?.canonical_domain || entry?.source?.domain || ''))).size,
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
  if (requireOfficial) {
    for (const domain of OFFICIAL_PRIMARY_DOMAINS) domains.add(domain);
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

async function buildStandardFallbackSelection({
  viableBriefs = [],
  sourcePackByKey = new Map(),
  options = {},
  braveApiKey,
  googleApiKey,
  googleCx,
  result,
  usedBriefKeys = new Set(),
  reason = 'unspecified',
} = {}) {
  const fallbackBrief = [...(Array.isArray(viableBriefs) ? viableBriefs : [])]
    .filter(Boolean)
    .filter((brief) => !usedBriefKeys.has(getBriefCandidateKey(brief)))
    .sort((left, right) => {
      const scoreDiff = Number(right?.selectionScore || right?.publishabilityScore || 0) - Number(left?.selectionScore || left?.publishabilityScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const freshDiff = Number(right?.freshness || 0) - Number(left?.freshness || 0);
      if (freshDiff !== 0) return freshDiff;
      return new Date(right?.discoveredAt || 0) - new Date(left?.discoveredAt || 0);
    })[0] || null;

  if (!fallbackBrief) return null;

  const briefKey = getBriefCandidateKey(fallbackBrief);
  let sourcePack = sourcePackByKey.get(briefKey) || null;
  if (!sourcePack) {
    result.stats.source_pack_attempts += 1;
    sourcePack = await assembleSourcePack({
      ...fallbackBrief,
      articleType: 'analysis',
    }, {
      ...options,
      braveApiKey,
      googleApiKey,
      googleCx,
      articleType: 'analysis',
    });
  }

  const editorialGate = evaluateSourcePackEditorialIntegrity({ brief: fallbackBrief, sourcePack });
  const hardErrors = (editorialGate.blocking_errors || []).filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
  if (!sourcePack.passesGate || hardErrors.length > 0) {
    const reasons = Array.from(new Set([
      ...(Array.isArray(sourcePack.gateNotes) ? sourcePack.gateNotes : []),
      ...hardErrors,
    ]));
    result.rejection_report.source_pack.push({
      question: null,
      brief_title: fallbackBrief.title || null,
      reasons: reasons.length > 0 ? reasons : [`Standard fallback source-pack failed (${reason})`],
    });
    return null;
  }

  const fallbackQuestionCandidate = {
    question: null,
    question_type: 'standard_fallback',
    score: Number(fallbackBrief?.publishabilityScore || 6),
    selection_score: Number(fallbackBrief?.selectionScore || fallbackBrief?.publishabilityScore || 0),
    signal: fallbackBrief?.title || null,
    provider: 'fallback',
    model: null,
    note: `Standard fallback selected (${reason})`,
  };

  return {
    brief: fallbackBrief,
    questionCandidate: fallbackQuestionCandidate,
    sourcePack,
    mode: 'standard-fallback',
  };
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

function finalizeRun(result, questionCandidates = [], selected = null, startTime = Date.now()) {
  void questionCandidates;
  result.stats.cache_stats = getProviderStats();
  result.stats.duration_ms = Date.now() - startTime;
  result.stats.news_pool = getNewsPoolStats();

  const auditPath = writeQualityAuditRun({
    runId: result.runId,
    startedAt: result.started_at || new Date(startTime).toISOString(),
    stats: result.stats,
    stageResults: result.stages,
    selectedCandidates: selected ? [selected] : [],
    publishedArticles: result.success && selected ? [{
      title: selected.draft?.title || selected.brief?.title || null,
      filePath: result.published_path,
      expectedUrl: result.published_url,
      question: selected.questionCandidate?.question || null,
    }] : [],
    providerStats: result.stats.cache_stats,
    success: result.success,
    hardBlocker: result.hard_blocker,
  });

  result.artifacts.quality_audit = auditPath;
  result.artifacts.latest_question_candidates = path.resolve(QUESTIONS_DIR, 'latest-question-candidates.json');
  return result;
}


function ensureQuestionsDir() {
  if (!fs.existsSync(QUESTIONS_DIR)) {
    fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
  }
}

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
    console.warn(`[qna-pipeline] Unable to load .env: ${error.message}`);
  }
}

function generateSlug(title) {
  return String(title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 60) || 'untitled';
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runQnaPipeline({}).then((result) => {
    saveQnaPipelineResult(result, QNA_LAST_RESULT_PATH);
    console.log(JSON.stringify(result, null, 2));
    const exitEvaluation = evaluateQnaRunForExit(result);
    if (!exitEvaluation.success) {
      console.error('[qna-pipeline] FINAL STATUS: FAIL');
      console.error('[qna-pipeline] Exit reason(s):', exitEvaluation.reasons.join(' | '));
      if (exitEvaluation.controlled_no_article_failure) {
        console.error('[qna-pipeline] EXIT CLASS: controlled_no_article_failure');
        process.exit(1);
      }
      console.error('[qna-pipeline] EXIT CLASS: unexpected_failure');
      process.exit(2);
    }
    console.log('[qna-pipeline] FINAL STATUS: PASS');
    process.exit(0);
  }).catch((error) => {
    console.error('[qna-pipeline] Fatal error:', error);
    const fatalResult = {
      started_at: new Date().toISOString(),
      success: false,
      runId: `qna-pipeline-fatal-${Date.now()}`,
      mode: 'question-led',
      hard_blocker: `Fatal error: ${error.message}`,
      stages: {},
      stats: {
        cache_stats: null,
        duration_ms: 0,
        news_pool: getNewsPoolStats(),
        brief_candidates: 0,
        question_candidates: 0,
        source_pack_attempts: 0,
      },
    };
    saveQnaPipelineResult(fatalResult, QNA_LAST_RESULT_PATH);
    process.exit(2);
  });
}

function saveQnaPipelineResult(result, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...result,
  }, null, 2), 'utf-8');
}

function evaluateQnaRunForExit(result) {
  const reasons = [];
  const hardBlocker = String(result?.hard_blocker || '').trim();
  const normalized = hardBlocker.toLowerCase();

  if (result?.success !== true) reasons.push('final Success is false');
  if (hardBlocker) reasons.push(`hard blocker exists: ${hardBlocker}`);
  if (!result?.published_path) reasons.push('published_path is missing');

  const controlledNoArticleFailure = reasons.length > 0 && (
    normalized.includes('no brief candidates available')
    || normalized.includes('no brief candidate passed source-pack viability gate')
    || normalized.includes('no viable question candidates after quality filtering')
    || normalized.includes('no question candidate passed source-pack assembly')
    || normalized.includes('source-pack gate failed')
  );

  return {
    success: reasons.length === 0,
    reasons,
    controlled_no_article_failure: controlledNoArticleFailure,
  };
}
