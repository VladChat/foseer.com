// File: qwen-scripts/qna-pipeline.js
// Purpose: Run an isolated question-led article pipeline that reuses shared discovery cache and downstream editorial modules.

import fs from 'node:fs';
import path from 'node:path';

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

export async function runQnaPipeline(options = {}) {
  ensureQuestionsDir();
  const startTime = Date.now();
  const runId = `qna-pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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

  let briefs = loadSharedBriefCandidates(candidateLimit);
  result.stats.brief_candidates = briefs.length;
  result.stages.shared_cache_load = {
    success: briefs.length > 0,
    count: briefs.length,
    source: briefs.length > 0 ? 'shared-news-pool' : 'empty',
  };

  if (briefs.length === 0) {
    const refreshed = await refreshSharedDiscoveryCache({ braveApiKey, googleApiKey, googleCx, openAiApiKey, candidateLimit });
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

  if (rankedQuestions.length === 0) {
    result.hard_blocker = 'No viable question candidates after quality filtering';
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  const sourcePackAttemptQuestions = rankedQuestions.slice(0, Math.max(sourcePackTryLimit, 2));
  let selected = null;

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

  result.stages.source_pack_selection = {
    success: !!selected,
    attempted: sourcePackAttemptQuestions.length,
    selected_question: selected?.questionCandidate?.question || null,
    rejected_candidates: result.rejection_report.source_pack,
  };

  if (!selected) {
    result.hard_blocker = 'No question candidate passed source-pack assembly (see rejection_report)';
    return finalizeRun(result, questionCandidates, null, startTime);
  }

  result.selected_question = {
    question: selected.questionCandidate.question,
    question_type: selected.questionCandidate.question_type,
    score: selected.questionCandidate.score,
    selection_score: selected.questionCandidate.selection_score,
    signal: selected.questionCandidate.signal,
    brief_title: selected.brief.title,
    source_pack_sources: selected.sourcePack.sources?.length || 0,
    source_pack_domains: selected.sourcePack.uniqueDomains || 0,
  };

  if (selected.brief.poolIdentityKey) {
    markBriefSelected(selected.brief.poolIdentityKey);
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
    const briefForDraft = buildQuestionDraftBrief(selected.brief, selected.questionCandidate);
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

function resolveQuestionArticleType(questionCandidate) {
  const type = String(questionCandidate?.question_type || '').toLowerCase();
  if (type === 'meaning') return 'explainer';
  return 'analysis';
}

function loadSharedBriefCandidates(limit) {
  const wideLimit = Math.max(limit * 3, 24);
  const readyBriefs = getReadySelectableBriefs({ limit: wideLimit, includeSelected: false });
  const poolBriefs = getSelectableBriefs({ limit: wideLimit, prioritizeReady: true, readyBoost: 8 });
  const merged = dedupeBriefCandidates([...readyBriefs, ...poolBriefs])
    .filter(isLikelyViableBrief)
    .sort((left, right) => Number(right.selectionScore || 0) - Number(left.selectionScore || 0));
  return merged.slice(0, Math.max(limit, 12));
}

async function refreshSharedDiscoveryCache({ braveApiKey, googleApiKey, googleCx, openAiApiKey, candidateLimit }) {
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
      briefs: loadSharedBriefCandidates(candidateLimit),
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
  const rejections = [];
  const sourcePackByKey = new Map();
  const uniqueBriefs = dedupeBriefCandidates(Array.isArray(briefs) ? briefs : []);

  for (const brief of uniqueBriefs) {
    const briefKey = getBriefCandidateKey(brief);
    try {
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
        rejections.push({
          brief_title: brief.title || null,
          poolIdentityKey: brief.poolIdentityKey || null,
          reasons,
        });
        console.log(`[qna-pipeline] Brief source-pack rejected :: ${brief.title || 'untitled'} :: ${reasons.join(' | ')}`);
        continue;
      }

      sourcePackByKey.set(briefKey, sourcePack);
      viableBriefs.push(brief);
      console.log(`[qna-pipeline] Brief source-pack passed :: ${brief.title || 'untitled'} :: sources=${sourcePack.sources?.length || 0} domains=${sourcePack.uniqueDomains || 0}`);
    } catch (error) {
      const reasons = [`Source-pack assembly error: ${error.message}`];
      rejections.push({
        brief_title: brief.title || null,
        poolIdentityKey: brief.poolIdentityKey || null,
        reasons,
      });
      console.log(`[qna-pipeline] Brief source-pack error :: ${brief.title || 'untitled'} :: ${error.message}`);
    }
  }

  return {
    attempted: uniqueBriefs.length,
    viableBriefs,
    sourcePackByKey,
    rejections,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runQnaPipeline({}).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }).catch((error) => {
    console.error('[qna-pipeline] Fatal error:', error);
    process.exit(1);
  });
}
