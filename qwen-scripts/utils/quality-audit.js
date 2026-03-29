// File: qwen-scripts/utils/quality-audit.js
// Purpose: Write compact internal quality audit trails for source-pack, tags, image choice, and per-article outcomes.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';
import { validateTagSelection } from '../validate-tags.js';
import { evaluateSemanticIntegrity } from '../validate-publish-graph.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const AUDIT_DIR = path.resolve(PROJECT_ROOT, 'qwen-data', 'quality-audits');

export function writeQualityAuditRun({
  runId,
  startedAt,
  stats = {},
  stageResults = {},
  selectedCandidates = [],
  publishedArticles = [],
  providerStats = null,
  success = false,
  hardBlocker = null,
} = {}) {
  if (!runId) return null;
  ensureDir(AUDIT_DIR);
  const publishedTitleSet = new Set((Array.isArray(publishedArticles) ? publishedArticles : []).map((item) => String(item?.draft?.title || item?.brief?.title || '').trim()).filter(Boolean));
  const articleStageMap = buildArticleStageMap(stageResults);
  const candidates = (Array.isArray(selectedCandidates) ? selectedCandidates : []).map((candidate, index) => {
    const title = String(candidate?.draft?.title || candidate?.brief?.title || '').trim() || `candidate_${index + 1}`;
    const stage = articleStageMap.get(title) || {};
    const semantic = evaluateSemanticIntegrity(candidate, candidate?.placement || null);
    return {
      rank: index + 1,
      title,
      slug: candidate?.publishIdentity?.slug || candidate?.articleSlug || null,
      published: publishedTitleSet.has(title),
      editorial_pass: semantic.editorial_valid,
      editorial_blockers: semantic.blocking_errors,
      editorial_warnings: semantic.warnings,
      stages: stage,
      source_pack: buildSourcePackAudit(candidate?.sourcePack, semantic),
      tags: buildTagAudit(candidate, semantic),
      image: buildImageAudit(candidate, semantic),
      publish: {
        manifest_path: candidate?.publishManifestPath || null,
        file_path: candidate?.publishResult?.filePath || null,
        expected_url: candidate?.publishResult?.expectedUrl || null,
        verified_url: candidate?.verification?.articleUrl || null,
      },
    };
  });

  const payload = {
    version: 2,
    run_id: runId,
    started_at: startedAt || null,
    generated_at: new Date().toISOString(),
    success: Boolean(success),
    hard_blocker: hardBlocker || null,
    stats,
    provider_stats: providerStats || null,
    stage_overview: buildStageOverview(stageResults),
    editorial_overview: {
      candidate_count: candidates.length,
      editorial_pass_count: candidates.filter((item) => item.editorial_pass).length,
      editorial_fail_count: candidates.filter((item) => !item.editorial_pass).length,
    },
    candidates,
  };

  const filePath = path.join(AUDIT_DIR, `${runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function buildStageOverview(stageResults = {}) {
  const output = {};
  for (const [name, value] of Object.entries(stageResults || {})) {
    if (!value) continue;
    output[name] = {
      success: Boolean(value.success),
      error: value.error || null,
      total: Number(value?.data?.total || 0),
      success_count: Number(value?.data?.successCount || 0),
      failure_count: Number(value?.data?.failureCount || 0),
    };
  }
  return output;
}

function buildArticleStageMap(stageResults = {}) {
  const map = new Map();
  for (const [stageName, stageResult] of Object.entries(stageResults || {})) {
    const items = Array.isArray(stageResult?.data?.items) ? stageResult.data.items : [];
    for (const item of items) {
      const title = String(item?.title || '').trim();
      if (!title) continue;
      if (!map.has(title)) map.set(title, {});
      map.get(title)[stageName] = {
        success: Boolean(item?.success),
        error: item?.error || null,
      };
    }
  }
  return map;
}

function buildSourcePackAudit(sourcePack = {}, semantic = {}) {
  const roleResults = Array.isArray(sourcePack?.sourceRoleResults) ? sourcePack.sourceRoleResults : [];
  const roleCounts = roleResults.reduce((acc, result) => {
    const role = String(result?.role || 'unknown');
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});

  return {
    passes_gate: Boolean(sourcePack?.passesGate),
    gate_decision: sourcePack?.gateDecision || (sourcePack?.passesGate ? 'PASS' : 'FAIL'),
    gate_notes: Array.isArray(sourcePack?.gateNotes) ? sourcePack.gateNotes : [],
    placement: {
      section_id: sourcePack?.section_id || null,
      topic_id: sourcePack?.topic_id || null,
      placement_confidence: sourcePack?.placementConfidence || null,
      placement_reason: Array.isArray(sourcePack?.placementReason) ? sourcePack.placementReason : [],
    },
    metrics: {
      total_sources: Number(sourcePack?.metrics?.totalSources || 0),
      unique_domains: Number(sourcePack?.uniqueDomains || 0),
      direct_event_source_count: Number(sourcePack?.metrics?.directEventSourceCount || 0),
      independent_event_domains: Number(sourcePack?.metrics?.independentEventDomains || 0),
      source_consistency_score: Number(sourcePack?.metrics?.sourceConsistencyScore || 0),
      strong_match_count: Number(sourcePack?.metrics?.strongMatchCount || 0),
      core_source_count: Number(sourcePack?.metrics?.coreSourceCount || 0),
      supporting_source_count: Number(sourcePack?.metrics?.supportingSourceCount || 0),
      background_source_count: Number(sourcePack?.metrics?.backgroundSourceCount || 0),
      rejected_source_count: Number(sourcePack?.metrics?.rejectedSourceCount || 0),
    },
    role_counts: roleCounts,
    publish_ready_sources: toSourceList(sourcePack?.publishReadySources, 8),
    excluded_sources: toSourceList(sourcePack?.excludedSources, 6),
    role_sample: roleResults.slice(0, 12).map((result) => ({
      role: result?.role || null,
      title: result?.source?.title || null,
      domain: result?.source?.canonical_domain || result?.source?.domain || null,
      page_kind: result?.source?.page_kind || null,
      same_event_score: numberOrNull(result?.same_event_score),
      topic_fit_score: numberOrNull(result?.topic_fit_score),
      source_quality_score: numberOrNull(result?.source?.sourceQualityScore || result?.source?.source_quality_score),
      article_likelihood: numberOrNull(result?.source?.article_likelihood),
      genericity_score: numberOrNull(result?.source?.genericity_score),
    })),
    semantic: semantic?.source_checks || {},
  };
}

function buildTagAudit(candidate = {}, semantic = {}) {
  const tagging = candidate?.draft?.metadata?.tagging || {};
  const validation = validateTagSelection(tagging);
  return {
    tags: Array.isArray(tagging?.tags) ? tagging.tags : [],
    tag_slugs: Array.isArray(tagging?.tag_slugs) ? tagging.tag_slugs : [],
    primary_topic_tag: tagging?.primary_topic_tag || null,
    primary_topic_slug: tagging?.primary_topic_slug || null,
    warnings: Array.isArray(tagging?.warnings) ? tagging.warnings : [],
    diagnostics: tagging?.diagnostics || {},
    selected: Array.isArray(tagging?.selected)
      ? tagging.selected.map((item) => ({
          label: item?.label || null,
          slug: item?.slug || null,
          score: numberOrNull(item?.score),
          reason: item?.reason || null,
          fallback: Boolean(item?.fallback),
        }))
      : [],
    validation,
    semantic: semantic?.tag_checks || {},
  };
}

function buildImageAudit(candidate = {}, semantic = {}) {
  const image = candidate?.image || {};
  const metadata = image?.metadata || {};
  const auditTrail = metadata?.auditTrail || {};
  return {
    provider: image?.provider || null,
    image_path: image?.imagePath || null,
    source_url: image?.sourceUrl || null,
    selection_mode: metadata?.selectionMode || null,
    query_used: metadata?.queryUsed || null,
    relevance_tier: metadata?.relevanceTier || null,
    article_relevance_score: numberOrNull(metadata?.articleRelevanceScore),
    asset_quality_score: numberOrNull(metadata?.assetQualityScore),
    editorial_fit_score: numberOrNull(metadata?.editorialFitScore),
    scene_type: metadata?.sceneType || null,
    visual_type: metadata?.visualType || null,
    entity_hints: Array.isArray(metadata?.entityHints) ? metadata.entityHints : [],
    geo_hints: Array.isArray(metadata?.geoHints) ? metadata.geoHints : [],
    queries_tried: Array.isArray(auditTrail?.queriesTried) ? auditTrail.queriesTried : [],
    decision_log: Array.isArray(auditTrail?.decisionLog) ? auditTrail.decisionLog.slice(0, 12) : [],
    best_online_decision: auditTrail?.bestOnlineDecision || null,
    online_attempted: Boolean(auditTrail?.onlineAttempted),
    fallback_used: image?.provider === 'fallback',
    semantic: semantic?.image_checks || {},
  };
}

function toSourceList(sources, limit = 6) {
  return (Array.isArray(sources) ? sources : []).slice(0, limit).map((source) => ({
    title: source?.title || null,
    domain: source?.canonical_domain || source?.domain || null,
    url: source?.canonical_url || source?.url || null,
    page_kind: source?.page_kind || null,
    topic_id: source?.topic_id || null,
    section_id: source?.section_id || null,
  }));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
