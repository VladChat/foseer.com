// File: qwen-scripts/qna-pipeline.js
// Purpose: Run an isolated question-led article pipeline that reuses shared discovery cache and downstream editorial modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSourcePack } from './source-pack.js';
import { createClaimMap, validateClaimMap } from './claim-map.js';
import { draftArticle, hardenDraft } from './article-drafter.js';
import { generateImagePackage } from './nodes/image-node.js';
import { publishArticle } from './publisher.js';
import { validatePrePublishGraph, buildCanonicalPublishPayload, buildPublishManifest, writePublishManifest, validatePublishedArtifact, evaluateSourcePackEditorialIntegrity } from './validate-publish-graph.js';
import { markBriefSelected, markBriefPublished, getNewsPoolStats, getBriefIdentityKey, isIdentityAlreadyPublished } from './utils/news-pool.js';
import { getProviderStats } from './utils/api-clients.js';
import { writeQualityAuditRun } from './utils/quality-audit.js';
import { extractQuestionCandidate, extractQuestionCandidates } from './question-extractor.js';
import { loadSharedBriefCandidatesFromPool, runPreWriterDiscoveryIntake, runSharedSourcePackEngine, mergeRescueDiagnostics, estimateSourcePackCoherence } from './pre-writer-engine.js';
import { evaluatePreWriteQualityGate } from './pre-write-quality-gate.js';
import { attemptImageRescuePass, hasImageTopicMismatchError, splitPreWriteGraphErrors } from './utils/publish-rescue.js';

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
  const duplicateGuardRejections = [];

  const trackPublishedIdentityRejection = (brief = {}, stage = 'pre_selection') => {
    const identityKey = resolveBriefIdentityKey(brief);
    if (!identityKey) return false;
    if (!isIdentityAlreadyPublished(identityKey)) return false;
    const title = String(brief?.title || '').trim() || null;
    duplicateGuardRejections.push({
      stage,
      brief_title: title,
      identity_key: identityKey,
      reason: 'identity_already_published',
    });
    console.log(`[qna-pipeline] Duplicate guard: skip published identity ${identityKey} :: ${title || 'Untitled brief'}`);
    return true;
  };

  const initialIntake = await runPreWriterDiscoveryIntake({
    braveApiKey,
    googleApiKey,
    googleCx,
    openAiApiKey,
    candidateLimit,
    leaseOwner: workflowLeaseOwner,
    options,
  });
  result.stages.discovery_refresh = initialIntake.stage;

  let briefs = loadSharedBriefCandidatesFromPool(candidateLimit, { leaseOwner: workflowLeaseOwner });
  result.stats.brief_candidates = briefs.length;
  result.stages.shared_cache_load = {
    success: briefs.length > 0,
    count: briefs.length,
    source: briefs.length > 0 ? 'shared-news-pool' : 'empty',
  };

  if (briefs.length === 0) {
    result.hard_blocker = 'No brief candidates available from shared discovery cache';
    return finalizeRun(result, [], null, startTime);
  }

  let screened = await runSharedSourcePackEngine({
    briefs,
    options,
    braveApiKey,
    googleApiKey,
    googleCx,
    maxSelectionCount: Math.max(sourcePackTryLimit, 2),
    selectionLimits: {
      maxPerSection: Number(options.maxPerSection || 2),
      maxPerTopic: Number(options.maxPerTopic || 2),
      relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
      relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
    },
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
    const refreshed = await runPreWriterDiscoveryIntake({
      braveApiKey,
      googleApiKey,
      googleCx,
      openAiApiKey,
      candidateLimit: Math.max(candidateLimit * 2, 12),
      leaseOwner: workflowLeaseOwner,
      options,
    });
    result.stages.discovery_refresh = refreshed.stage;
    result.stats.brief_candidates = refreshed.briefs.length;
    if (refreshed.briefs.length > 0) {
      screened = await runSharedSourcePackEngine({
        briefs: refreshed.briefs,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        maxSelectionCount: Math.max(sourcePackTryLimit, 2),
        selectionLimits: {
          maxPerSection: Number(options.maxPerSection || 2),
          maxPerTopic: Number(options.maxPerTopic || 2),
          relaxedMaxPerSection: Number(options.relaxedMaxPerSection || 3),
          relaxedMaxPerTopic: Number(options.relaxedMaxPerTopic || 3),
        },
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

  const duplicateFilteredViableBriefs = (Array.isArray(screened.viableBriefs) ? screened.viableBriefs : [])
    .filter((brief) => !trackPublishedIdentityRejection(brief, 'brief_source_pack_gate'));
  screened.viableBriefs = duplicateFilteredViableBriefs;
  result.rejection_report.pre_selection.push(...duplicateGuardRejections);
  if (screened.viableBriefs.length === 0) {
    result.hard_blocker = 'All viable brief candidates were already published (duplicate guard)';
    return finalizeRun(result, [], null, startTime);
  }

  const useLlmBulkQuestionExtraction = String(
    options.questionExtractionUseLlm
    ?? process.env.QNA_QUESTION_EXTRACTION_USE_LLM
    ?? '0'
  ) === '1';
  const questionCandidates = await extractQuestionCandidates(screened.viableBriefs, openAiApiKey, {
    useOpenAi: useLlmBulkQuestionExtraction,
  });
  const extractionModels = Array.from(new Set(questionCandidates.map((candidate) => candidate.model).filter(Boolean)));
  console.log(`[qna-pipeline] Question extraction model(s): ${extractionModels.length > 0 ? extractionModels.join(', ') : 'fallback-only'}`);
  result.stats.question_candidates = questionCandidates.length;
  result.stages.question_extraction = {
    success: questionCandidates.some((candidate) => candidate.selection_eligible),
    count: questionCandidates.length,
    valid_count: questionCandidates.filter((candidate) => candidate.valid).length,
    eligible_count: questionCandidates.filter((candidate) => candidate.selection_eligible).length,
    models: extractionModels,
    mode: useLlmBulkQuestionExtraction ? 'llm_bulk' : 'fallback_bulk',
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

  const preWriterRankByBriefKey = new Map(
    (Array.isArray(screened.selectedCandidates) ? screened.selectedCandidates : [])
      .map((candidate, index) => [getBriefCandidateKey(candidate?.brief || {}), index])
  );
  const rankedQuestions = [...eligibleQuestions]
    .sort((left, right) => {
      const leftRank = preWriterRankByBriefKey.has(getBriefCandidateKey(left?.brief || {}))
        ? Number(preWriterRankByBriefKey.get(getBriefCandidateKey(left?.brief || {})))
        : Number.POSITIVE_INFINITY;
      const rightRank = preWriterRankByBriefKey.has(getBriefCandidateKey(right?.brief || {}))
        ? Number(preWriterRankByBriefKey.get(getBriefCandidateKey(right?.brief || {})))
        : Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return Number(right.selection_score || 0) - Number(left.selection_score || 0);
    });

  result.stages.question_filtering = {
    success: rankedQuestions.length > 0,
    total_candidates: questionCandidates.length,
    eligible_candidates: rankedQuestions.length,
    rejected_candidates: result.rejection_report.pre_selection,
  };

  const sourcePackAttemptQuestions = rankedQuestions
    .filter((candidate) => !trackPublishedIdentityRejection(candidate?.brief || {}, 'question_source_pack_gate'))
    .slice(0, Math.max(sourcePackTryLimit, 2));
  if (duplicateGuardRejections.length > 0) {
    result.rejection_report.pre_selection = dedupeObjectArrayByKey(
      [...result.rejection_report.pre_selection, ...duplicateGuardRejections],
      (item) => `${item.stage || ''}|${item.identity_key || ''}|${item.brief_title || ''}|${item.reason || ''}`,
    );
  }
  let selected = null;
  let selectedMode = 'question-led';

  if (rankedQuestions.length === 0) {
    const standardFallback = await buildStandardFallbackSelection({
      viableBriefs: screened.viableBriefs,
      prioritizedBriefs: (Array.isArray(screened.selectedCandidates) ? screened.selectedCandidates : []).map((candidate) => candidate?.brief).filter(Boolean),
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
      prioritizedBriefs: (Array.isArray(screened.selectedCandidates) ? screened.selectedCandidates : []).map((candidate) => candidate?.brief).filter(Boolean),
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

  const lateFallbackUsedBriefKeys = new Set(sourcePackAttemptQuestions.map((candidate) => getBriefCandidateKey(candidate?.brief || {})));
  if (selected?.brief) lateFallbackUsedBriefKeys.add(getBriefCandidateKey(selected.brief));
  let completed = false;

  while (!completed) {
    selected.briefForDraft = selectedMode === 'standard-fallback'
      ? buildStandardFallbackDraftBrief(selected.brief)
      : buildQuestionDraftBrief(selected.brief, selected.questionCandidate);

    const preWriteCoherence = estimateSourcePackCoherence(selected.sourcePack, selected.brief);
    const preWriteGateBase = evaluatePreWriteQualityGate({
      brief: selected.brief,
      sourcePack: selected.sourcePack,
      questionCandidate: selected.questionCandidate,
      mode: selectedMode === 'question-led' ? 'qna' : 'article',
      coherenceScore: preWriteCoherence,
    }, options.preWriteGate || {});
    const preWriteReasons = Array.isArray(preWriteGateBase.reasons) ? [...preWriteGateBase.reasons] : [];
    const preWriteWarnings = Array.isArray(preWriteGateBase.warnings) ? [...preWriteGateBase.warnings] : [];

    const preWriteGraphValidation = validatePrePublishGraph({
      ...selected,
      draft: {
        title: selected.briefForDraft?.title || selected.brief?.title || 'Developing story',
        excerpt: selected.briefForDraft?.summary || selected.brief?.summary || selected.brief?.whyItMatters || '',
        content: `${selected.briefForDraft?.whatHappened || selected.brief?.whatHappened || ''} ${selected.briefForDraft?.whyItMatters || selected.brief?.whyItMatters || ''}`.trim(),
        articleType: selected.briefForDraft?.articleType || selected.brief?.articleType || 'analysis',
        article_type: selected.briefForDraft?.articleType || selected.brief?.articleType || 'analysis',
      },
    });
    const preWriteGraphErrorsRaw = Array.isArray(preWriteGraphValidation.errors) ? preWriteGraphValidation.errors : [];
    const preWriteGraphErrorSplit = splitPreWriteGraphErrors(preWriteGraphErrorsRaw);
    const preWriteGraphErrors = preWriteGraphErrorSplit.blocking.filter((message) => isPreWriteRelevantGraphError(message));
    if (preWriteGraphErrors.length > 0) {
      preWriteReasons.push(...preWriteGraphErrors);
    }
    if (preWriteGraphErrorSplit.rescued.length > 0) {
      preWriteWarnings.push(...preWriteGraphErrorSplit.warnings);
      console.log(`[qna-pipeline] PRE-WRITE TAG RESCUE: downgraded ${preWriteGraphErrorSplit.rescued.length} tag blocker(s) to warnings`);
    }
    if (preWriteGraphErrorsRaw.length > preWriteGraphErrors.length) {
      preWriteWarnings.push('Pre-publish graph reported post-draft-only errors during precheck');
    }
    if (Array.isArray(preWriteGraphValidation.warnings) && preWriteGraphValidation.warnings.length > 0) {
      preWriteWarnings.push(...preWriteGraphValidation.warnings);
    }
    const preWriteGate = {
      ...preWriteGateBase,
      pass: preWriteReasons.length === 0,
      reasons: Array.from(new Set(preWriteReasons)),
      warnings: Array.from(new Set(preWriteWarnings)),
      metrics: {
        ...(preWriteGateBase.metrics || {}),
        prepublish_graph_precheck: {
          valid: preWriteGraphValidation.valid,
          errors: preWriteGraphValidation.errors || [],
          warnings: preWriteGraphValidation.warnings || [],
        },
        tag_rescue: {
          rescued_errors: preWriteGraphErrorSplit.rescued || [],
          blocking_errors: preWriteGraphErrors || [],
        },
      },
    };
    result.stages.pre_write_quality_gate = {
      success: preWriteGate.pass,
      reasons: preWriteGate.reasons,
      warnings: preWriteGate.warnings,
      metrics: preWriteGate.metrics,
    };
    if (!preWriteGate.pass) {
      const lateFallback = await tryLateStageFallbackSelection({
        selectedMode,
        selected,
        screened,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        result,
        usedBriefKeys: lateFallbackUsedBriefKeys,
        triggerStage: 'pre_write_quality_gate',
        triggerReason: `Pre-write quality gate failed: ${preWriteGate.reasons.join('; ')}`,
      });
      if (lateFallback) {
        selected = lateFallback;
        selectedMode = 'standard-fallback';
        result.stages.source_pack_selection = {
          ...(result.stages.source_pack_selection || {}),
          selected_mode: selectedMode,
        };
        continue;
      }
      result.hard_blocker = `Pre-write quality gate failed: ${preWriteGate.reasons.join('; ')}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }

    const allowQuestionRefinement = String(
      options.qnaRefineSelectedQuestionWithLlm
      ?? process.env.QNA_REFINE_SELECTED_QUESTION_WITH_LLM
      ?? '1'
    ) !== '0';
    if (selectedMode === 'question-led' && allowQuestionRefinement && openAiApiKey) {
      try {
        const refined = await extractQuestionCandidate(selected.brief, openAiApiKey, { useOpenAi: true });
        if (refined?.valid && refined?.selection_eligible) {
          selected.questionCandidate = {
            ...selected.questionCandidate,
            ...refined,
            source_pack_gate: selected.questionCandidate?.source_pack_gate || null,
          };
          result.stages.question_refinement = {
            success: true,
            applied: true,
            provider: refined.provider || 'openai',
            model: refined.model || null,
            question: refined.question || null,
          };
        } else {
          result.stages.question_refinement = {
            success: true,
            applied: false,
            reason: refined?.invalid_reason || 'Refined question failed quality checks',
          };
        }
      } catch (error) {
        result.stages.question_refinement = {
          success: false,
          applied: false,
          error: error.message,
        };
      }
    } else {
      result.stages.question_refinement = {
        success: true,
        applied: false,
        reason: allowQuestionRefinement ? 'No OpenAI key or non-question mode selection' : 'Question refinement disabled',
      };
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
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'claim_map',
          triggerReason: `Claim map failed: ${claimValidation.issues.join('; ')}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
        result.hard_blocker = `Claim map failed: ${claimValidation.issues.join('; ')}`;
        return finalizeRun(result, questionCandidates, null, startTime);
      }
    } catch (error) {
      result.stages.claim_map = { success: false, error: error.message };
      const lateFallback = await tryLateStageFallbackSelection({
        selectedMode,
        selected,
        screened,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        result,
        usedBriefKeys: lateFallbackUsedBriefKeys,
        triggerStage: 'claim_map',
        triggerReason: `Claim map failed: ${error.message}`,
      });
      if (lateFallback) {
        selected = lateFallback;
        selectedMode = 'standard-fallback';
        result.stages.source_pack_selection = {
          ...(result.stages.source_pack_selection || {}),
          selected_mode: selectedMode,
        };
        continue;
      }
      result.hard_blocker = `Claim map failed: ${error.message}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }

    try {
      const draft = await draftArticle(selected.briefForDraft, selected.sourcePack, selected.claimMap, openAiApiKey);
      const hardened = hardenDraft(draft, selected.claimMap);
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
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'draft',
          triggerReason: `Draft not safe for publishing: ${(hardened.qualityIssues || []).join('; ')}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
        result.hard_blocker = `Draft not safe for publishing: ${(hardened.qualityIssues || []).join('; ')}`;
        return finalizeRun(result, questionCandidates, null, startTime);
      }
    } catch (error) {
      result.stages.draft = { success: false, error: error.message };
      const lateFallback = await tryLateStageFallbackSelection({
        selectedMode,
        selected,
        screened,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        result,
        usedBriefKeys: lateFallbackUsedBriefKeys,
        triggerStage: 'draft',
        triggerReason: `Draft failed: ${error.message}`,
      });
      if (lateFallback) {
        selected = lateFallback;
        selectedMode = 'standard-fallback';
        result.stages.source_pack_selection = {
          ...(result.stages.source_pack_selection || {}),
          selected_mode: selectedMode,
        };
        continue;
      }
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
      let prePublishValidation = validatePrePublishGraph(selected);
      let imageRescueDiagnostics = [];
      if (!prePublishValidation.valid && hasImageTopicMismatchError(prePublishValidation.errors || [])) {
        const rescue = await attemptImageRescuePass({
          candidate: selected,
          providerApiKeys: { pexelsApiKey, unsplashApiKey, pixabayApiKey },
          validateGraph: validatePrePublishGraph,
          logPrefix: 'qna-pipeline',
        });
        imageRescueDiagnostics = Array.isArray(rescue?.diagnostics) ? rescue.diagnostics : [];
        if (rescue?.validation) {
          prePublishValidation = rescue.validation;
        } else if (rescue?.applied) {
          prePublishValidation = validatePrePublishGraph(selected);
        }
      }
      if (!prePublishValidation.valid) {
        result.stages.publish_validation = {
          success: false,
          errors: prePublishValidation.errors,
          warnings: prePublishValidation.warnings,
          image_rescue: imageRescueDiagnostics,
        };
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'publish_validation',
          triggerReason: `Pre-publish validation failed: ${prePublishValidation.errors.join('; ')}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
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

      const selectedIdentityKey = resolveBriefIdentityKey(selected?.brief || {});
      if (selectedIdentityKey && isIdentityAlreadyPublished(selectedIdentityKey)) {
        console.log(`[qna-pipeline] Duplicate guard: publish-stage skip for already published identity ${selectedIdentityKey}`);
        result.stages.publish = {
          success: false,
          error: `Duplicate guard blocked publish for already published identity: ${selectedIdentityKey}`,
        };
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'publish_duplicate_guard',
          triggerReason: `Duplicate guard blocked publish for already published identity: ${selectedIdentityKey}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
        result.hard_blocker = `Duplicate guard blocked publish for already published identity: ${selectedIdentityKey}`;
        return finalizeRun(result, questionCandidates, null, startTime);
      }

      selected.publishManifest = buildPublishManifest(selected);
      const publishResult = publishArticle(selected);
      selected.publishResult = publishResult;

      if (!publishResult.success) {
        result.stages.publish = { success: false, error: publishResult.error };
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'publish',
          triggerReason: `Publish failed: ${publishResult.error}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
        result.hard_blocker = `Publish failed: ${publishResult.error}`;
        return finalizeRun(result, questionCandidates, null, startTime);
      }

      selected.placement = { ...(selected.placement || {}), ...(publishResult.placement || {}) };
      selected.publishManifest = buildPublishManifest(selected, publishResult);
      selected.publishManifestPath = writePublishManifest(selected.publishManifest);
      const artifactValidation = validatePublishedArtifact(publishResult.filePath, selected.publishManifest);
      if (!artifactValidation.valid) {
        result.stages.publish = { success: false, error: artifactValidation.errors.join('; ') };
        const lateFallback = await tryLateStageFallbackSelection({
          selectedMode,
          selected,
          screened,
          options,
          braveApiKey,
          googleApiKey,
          googleCx,
          result,
          usedBriefKeys: lateFallbackUsedBriefKeys,
          triggerStage: 'publish_artifact_validation',
          triggerReason: `Published artifact validation failed: ${artifactValidation.errors.join('; ')}`,
        });
        if (lateFallback) {
          selected = lateFallback;
          selectedMode = 'standard-fallback';
          result.stages.source_pack_selection = {
            ...(result.stages.source_pack_selection || {}),
            selected_mode: selectedMode,
          };
          continue;
        }
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
      completed = true;
    } catch (error) {
      result.stages.publish = { success: false, error: error.message };
      const lateFallback = await tryLateStageFallbackSelection({
        selectedMode,
        selected,
        screened,
        options,
        braveApiKey,
        googleApiKey,
        googleCx,
        result,
        usedBriefKeys: lateFallbackUsedBriefKeys,
        triggerStage: 'publish',
        triggerReason: `Publish failed: ${error.message}`,
      });
      if (lateFallback) {
        selected = lateFallback;
        selectedMode = 'standard-fallback';
        result.stages.source_pack_selection = {
          ...(result.stages.source_pack_selection || {}),
          selected_mode: selectedMode,
        };
        continue;
      }
      result.hard_blocker = `Publish failed: ${error.message}`;
      return finalizeRun(result, questionCandidates, null, startTime);
    }
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
    title: brief?.title || question || 'Developing story',
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

async function buildStandardFallbackSelection({
  viableBriefs = [],
  prioritizedBriefs = [],
  sourcePackByKey = new Map(),
  options = {},
  braveApiKey,
  googleApiKey,
  googleCx,
  result,
  usedBriefKeys = new Set(),
  reason = 'unspecified',
} = {}) {
  const prioritizedList = Array.isArray(prioritizedBriefs) ? prioritizedBriefs : [];
  const fallbackCandidates = [
    ...prioritizedList.filter((brief) => !usedBriefKeys.has(getBriefCandidateKey(brief))),
    ...(Array.isArray(viableBriefs) ? viableBriefs : []),
  ]
    .filter(Boolean)
    .filter((brief, index, array) => index === array.findIndex((item) => getBriefCandidateKey(item) === getBriefCandidateKey(brief)))
    .filter((brief) => !usedBriefKeys.has(getBriefCandidateKey(brief)))
    .sort((left, right) => {
      const scoreDiff = Number(right?.selectionScore || right?.publishabilityScore || 0) - Number(left?.selectionScore || left?.publishabilityScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const freshDiff = Number(right?.freshness || 0) - Number(left?.freshness || 0);
      if (freshDiff !== 0) return freshDiff;
      return new Date(right?.discoveredAt || 0) - new Date(left?.discoveredAt || 0);
    });

  for (const fallbackBrief of fallbackCandidates) {
    const identityKey = resolveBriefIdentityKey(fallbackBrief);
    if (identityKey && isIdentityAlreadyPublished(identityKey)) {
      result.rejection_report.pre_selection.push({
        stage: 'standard_fallback',
        brief_title: fallbackBrief.title || null,
        identity_key: identityKey,
        reason: 'identity_already_published',
      });
      console.log(`[qna-pipeline] Duplicate guard: skip standard fallback brief ${identityKey} :: ${fallbackBrief.title || 'Untitled brief'}`);
      continue;
    }

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
      continue;
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

  return null;
}

async function tryLateStageFallbackSelection({
  selectedMode,
  selected,
  screened,
  options,
  braveApiKey,
  googleApiKey,
  googleCx,
  result,
  usedBriefKeys,
  triggerStage,
  triggerReason,
} = {}) {
  if (selectedMode !== 'question-led') return null;
  if (selected?.brief) {
    usedBriefKeys.add(getBriefCandidateKey(selected.brief));
  }

  const fallback = await buildStandardFallbackSelection({
    viableBriefs: screened?.viableBriefs || [],
    prioritizedBriefs: (Array.isArray(screened?.selectedCandidates) ? screened.selectedCandidates : [])
      .map((candidate) => candidate?.brief)
      .filter(Boolean),
    sourcePackByKey: screened?.sourcePackByKey || new Map(),
    options,
    braveApiKey,
    googleApiKey,
    googleCx,
    result,
    usedBriefKeys,
    reason: `late_stage_${String(triggerStage || 'unknown')}`,
  });

  if (!fallback) return null;

  const attempts = Array.isArray(result?.stages?.late_standard_fallback?.attempts)
    ? [...result.stages.late_standard_fallback.attempts]
    : [];
  const attempt = {
    trigger_stage: triggerStage || 'unknown',
    trigger_reason: triggerReason || null,
    from_brief_title: selected?.brief?.title || null,
    fallback_brief_title: fallback?.brief?.title || null,
  };
  attempts.push(attempt);
  result.stages.late_standard_fallback = {
    success: true,
    used: true,
    attempts,
    latest: attempt,
  };

  return fallback;
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

function resolveBriefIdentityKey(brief = {}) {
  return String(brief?.poolIdentityKey || getBriefIdentityKey(brief) || '').trim();
}

function dedupeObjectArrayByKey(values = [], keyBuilder = (value) => JSON.stringify(value)) {
  const seen = new Set();
  const deduped = [];
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(keyBuilder(value) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function isPreWriteRelevantGraphError(message = '') {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('missing selected article slug')) return false;
  if (normalized.includes('missing published path')) return false;
  if (normalized.includes('missing draft')) return false;
  if (normalized.includes('title is required')) return false;
  return normalized.includes('publish-ready source pack')
    || normalized.includes('source-pack')
    || normalized.includes('coherence')
    || normalized.includes('canonical section')
    || normalized.includes('canonical topic')
    || normalized.includes('tag');
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
    publishedArticles: result.success && selected ? [selected] : [],
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
        process.exit(0);
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
    || normalized.includes('pre-write quality gate failed')
    || normalized.includes('source-pack gate failed')
    || normalized.includes('duplicate guard')
    || normalized.includes('direct-event sources')
    || normalized.includes('source_overlap>=2')
  );

  return {
    success: reasons.length === 0,
    reasons,
    controlled_no_article_failure: controlledNoArticleFailure,
  };
}
