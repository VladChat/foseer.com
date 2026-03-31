// File: qwen-scripts/qna-pipeline.js
// Purpose: Run an isolated question-led article pipeline that reuses shared discovery cache and downstream editorial modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDiscovery } from './discovery.js';
import { normalizeClusteredBrief } from './event-brief-builder.js';
import { clusterDiscoveredCandidates } from './nodes/event-clustering-node.js';
import { assembleSourcePack } from './source-pack.js';
import { createClaimMap, validateClaimMap } from './claim-map.js';
import { draftArticle, hardenDraft } from './article-drafter.js';
import { generateImagePackage } from './nodes/image-node.js';
import { publishArticle } from './publisher.js';
import { validatePrePublishGraph, buildCanonicalPublishPayload, buildPublishManifest, writePublishManifest, validatePublishedArtifact, evaluateSourcePackEditorialIntegrity } from './validate-publish-graph.js';
import { mergeDiscoveredNews, mergeBriefsIntoPool, getSelectableBriefs, getReadySelectableBriefs, dedupeBriefCandidates, markBriefSelected, markBriefPublished, getNewsPoolStats } from './utils/news-pool.js';
import { getProviderStats } from './utils/api-clients.js';
import { writeQualityAuditRun } from './utils/quality-audit.js';
import { extractQuestionCandidates } from './question-extractor.js';

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
  result.rejection_report.brief_source_pack.push(...screened.rejections);
  result.stages.brief_source_pack_gate = {
    success: screened.viableBriefs.length > 0,
    attempted: screened.attempted,
    passed: screened.viableBriefs.length,
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
      result.rejection_report.brief_source_pack.push(...screened.rejections);
      result.stages.brief_source_pack_gate = {
        success: screened.viableBriefs.length > 0,
        attempted: (result.stages.brief_source_pack_gate?.attempted || 0) + screened.attempted,
        passed: screened.viableBriefs.length,
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
    const imageResult = await generateImagePackage(selected, selected.articleSlug, { pexelsApiKey, pixabayApiKey });
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

      const editorialGate = evaluateSourcePackEditorialIntegrity({ brief, sourcePack });
      const hardErrors = (editorialGate.blocking_errors || []).filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
      const gateReasons = [...(Array.isArray(sourcePack.gateNotes) ? sourcePack.gateNotes : []), ...hardErrors];
      const pass = Boolean(sourcePack.passesGate) && hardErrors.length === 0;

      if (!pass) {
        const reasons = Array.from(new Set(gateReasons.length > 0 ? gateReasons : ['Source-pack gate failed']));
        rejectionByBriefKey.set(briefKey, {
          brief_title: brief.title || null,
          poolIdentityKey: brief.poolIdentityKey || null,
          reasons,
        });
        if (isNearMissSourcePackFailure(reasons)) {
          nearMissRetries.push({ brief, briefKey, reasons, rankScore: Number(brief?.selectionScore || brief?.publishabilityScore || 0) });
        }
        console.log(`[qna-pipeline] Brief source-pack rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      sourcePackByKey.set(briefKey, sourcePack);
      viableBriefs.push(brief);
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

  const retryPoolMatchLimit = Math.max(Number(options.poolMatchLimit || 14), Number(options.qnaRetryPoolMatchLimit || 24));
  const retryCandidates = nearMissRetries
    .sort((left, right) => Number(right.rankScore || 0) - Number(left.rankScore || 0))
    .slice(0, 3);

  for (const retryCandidate of retryCandidates) {
    const { brief, briefKey } = retryCandidate;
    attempted += 1;
    console.log(`[qna-pipeline] Brief source-pack near-miss retry :: ${brief.title || 'untitled'} :: poolMatchLimit=${retryPoolMatchLimit}`);
    try {
      const retriedSourcePack = await assembleSourcePack({
        ...brief,
        articleType: 'analysis',
      }, {
        ...options,
        braveApiKey,
        googleApiKey,
        googleCx,
        articleType: 'analysis',
        poolMatchLimit: retryPoolMatchLimit,
      });

      const editorialGate = evaluateSourcePackEditorialIntegrity({ brief, sourcePack: retriedSourcePack });
      const hardErrors = (editorialGate.blocking_errors || []).filter((message) => !String(message).startsWith('Primary topic_id unsupported by source-pack evidence'));
      const gateReasons = [...(Array.isArray(retriedSourcePack.gateNotes) ? retriedSourcePack.gateNotes : []), ...hardErrors];
      const pass = Boolean(retriedSourcePack.passesGate) && hardErrors.length === 0;

      if (!pass) {
        const reasons = Array.from(new Set(gateReasons.length > 0 ? gateReasons : ['Source-pack gate failed']));
        rejectionByBriefKey.set(briefKey, {
          brief_title: brief.title || null,
          poolIdentityKey: brief.poolIdentityKey || null,
          reasons,
        });
        console.log(`[qna-pipeline] Brief source-pack retry rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      rejectionByBriefKey.delete(briefKey);
      sourcePackByKey.set(briefKey, retriedSourcePack);
      if (!viableBriefs.some((item) => getBriefCandidateKey(item) === briefKey)) {
        viableBriefs.push(brief);
      }
      console.log(`[qna-pipeline] Brief source-pack retry passed :: ${brief.title || 'untitled'} :: sources=${retriedSourcePack.sources?.length || 0} domains=${retriedSourcePack.uniqueDomains || 0}`);
    } catch (error) {
      rejectionByBriefKey.set(briefKey, {
        brief_title: brief.title || null,
        poolIdentityKey: brief.poolIdentityKey || null,
        reasons: [`Source-pack assembly error: ${error.message}`],
      });
      console.log(`[qna-pipeline] Brief source-pack retry error :: ${brief.title || 'untitled'} :: ${error.message}`);
    }
  }

  return {
    attempted,
    viableBriefs,
    sourcePackByKey,
    rejections: Array.from(rejectionByBriefKey.values()),
  };
}

function isNearMissSourcePackFailure(reasons = []) {
  const text = Array.isArray(reasons) ? reasons.join(' | ').toLowerCase() : '';
  if (!text) return false;
  return text.includes('need at least 2 publishable sources, found 1')
    || text.includes('need at least 2 different domains among publishable sources, found 1')
    || text.includes('need at least one trusted reporting source or official primary source')
    || text.includes('publishable pack remains thin');
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
