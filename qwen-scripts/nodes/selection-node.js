// File: qwen-scripts/nodes/selection-node.js
// Purpose: Coverage-aware scoring for pool selection and final source-pack candidate choice.

import { loadTaxonomyRegistry } from '../utils/taxonomy-registry.js';

export function buildCoverageContext(items = [], options = {}) {
  const now = Date.now();
  const windowMs = Number(options.windowMs || 48 * 60 * 60 * 1000);
  const recent = (Array.isArray(items) ? items : []).filter((item) => {
    const relevantTs = latestRelevantTimestamp(item);
    return relevantTs && (now - relevantTs) <= windowMs;
  });

  const sectionCounts = Object.create(null);
  const topicCounts = Object.create(null);
  const regionCounts = Object.create(null);
  const angleCounts = Object.create(null);
  const entityCounts = Object.create(null);
  const clusterCounts = Object.create(null);

  for (const item of recent) {
    const brief = item.brief || item;
    increment(sectionCounts, brief.section_id || brief.detectedSectionId || 'news');
    increment(topicCounts, brief.topic_id || brief.detectedTopicId || 'unassigned');
    increment(regionCounts, brief.region || 'global');
    increment(angleCounts, brief.angle || 'general');
    increment(clusterCounts, brief.cluster_id || brief.clusterId || brief.eventKey || brief.poolIdentityKey || 'unknown');
    for (const entity of normalizeEntityList(brief.entities || brief.involvedParties)) {
      increment(entityCounts, entity);
    }
  }

  const registry = loadTaxonomyRegistry();
  const sectionIds = registry.sections.map((section) => section.id);
  const minCount = Math.min(...sectionIds.map((sectionId) => sectionCounts[sectionId] || 0));
  const undercoveredSections = sectionIds.filter((sectionId) => (sectionCounts[sectionId] || 0) === minCount);

  return {
    sectionCounts,
    topicCounts,
    regionCounts,
    angleCounts,
    entityCounts,
    clusterCounts,
    undercoveredSections,
    recentItems: recent.length,
  };
}

export function scoreBriefForSelection(brief, context = {}, item = null) {
  const sectionId = brief.section_id || brief.detectedSectionId || 'news';
  const topicId = brief.topic_id || brief.detectedTopicId || 'unassigned';
  const region = brief.region || 'global';
  const angle = brief.angle || 'general';
  const clusterKey = brief.cluster_id || brief.clusterId || brief.eventKey || brief.poolIdentityKey || 'unknown';
  const entityList = normalizeEntityList(brief.entities || brief.involvedParties);
  const publishability = brief.publishabilityScore || 0;
  const freshness = brief.freshness || 0;
  const urgency = brief.urgency || 0;
  const articleRichCount = Number(brief.article_rich_count || brief.articleRichCount || 0);
  const genericPageCount = Number(brief.generic_page_count || brief.genericPageCount || 0);

  let score = publishability * 2 + freshness * 0.8 + urgency * 0.5 + articleRichCount * 0.8;
  const notes = [];

  const sectionCount = context.sectionCounts?.[sectionId] || 0;
  const topicCount = context.topicCounts?.[topicId] || 0;
  const regionCount = context.regionCounts?.[region] || 0;
  const angleCount = context.angleCounts?.[angle] || 0;
  const clusterCount = context.clusterCounts?.[clusterKey] || 0;
  const repeatedEntityCount = entityList.reduce((sum, entity) => sum + (context.entityCounts?.[entity] || 0), 0);

  if (Array.isArray(context.undercoveredSections) && context.undercoveredSections.includes(sectionId)) {
    score += 4;
    notes.push(`undercovered_section:${sectionId}`);
  }

  if (sectionCount > 0) {
    score -= Math.min(5, sectionCount * 1.4);
    notes.push(`section_penalty:${sectionCount}`);
  }
  if (topicCount > 0) {
    score -= Math.min(6, topicCount * 2.2);
    notes.push(`topic_penalty:${topicCount}`);
  }
  if (regionCount > 1) {
    score -= Math.min(3, (regionCount - 1) * 1.1);
    notes.push(`region_penalty:${regionCount}`);
  }
  if (angleCount > 1) {
    score -= Math.min(3, (angleCount - 1) * 0.9);
    notes.push(`angle_penalty:${angleCount}`);
  }
  if (clusterCount > 0) {
    score -= Math.min(8, clusterCount * 3);
    notes.push(`cluster_repeat:${clusterCount}`);
  }
  if (repeatedEntityCount > 0) {
    score -= Math.min(5, repeatedEntityCount * 0.7);
    notes.push(`entity_penalty:${repeatedEntityCount}`);
  }
  if (genericPageCount > articleRichCount && articleRichCount === 0) {
    score -= 3;
    notes.push('generic_cluster_without_articles');
  }

  if (item?.lastSelectedAt) {
    const hoursSinceSelected = (Date.now() - new Date(item.lastSelectedAt).getTime()) / 3600000;
    if (hoursSinceSelected < 18) {
      score -= 6;
      notes.push('recently_selected');
    }
  }

  if (item?.lastPublishedAt) {
    score -= 8;
    notes.push('already_published');
  }

  return {
    score: Math.round(score * 10) / 10,
    notes,
  };
}

export function scoreCandidateWithSourcePack(candidate, context = {}) {
  const briefScore = scoreBriefForSelection(candidate?.brief || {}, context, candidate?.poolItem || null);
  const sourcePack = candidate?.sourcePack || {};
  const metrics = sourcePack.metrics || {};

  let score = briefScore.score;
  score += (sourcePack.uniqueDomains || 0) * 4;
  score += (metrics.sourceConsistencyScore || 0) * 1.1;
  score += (metrics.strongMatchCount || 0) * 2.2;
  score += (metrics.primaryishCount || 0) * 1.8;
  score += (metrics.averageSourceScore || 0) * 0.6;
  score += (metrics.coreSourceCount || 0) * 3.5;
  score += (metrics.supportingSourceCount || 0) * 1.8;
  score += Math.max(0, (metrics.clusterArticleRichCount || 0) - (metrics.clusterGenericSignalCount || 0)) * 0.8;
  if ((metrics.coreSourceCount || 0) === 0) score -= 12;
  if (!sourcePack.passesGate) score -= 30;

  return {
    score: Math.round(score * 10) / 10,
    notes: [
      ...briefScore.notes,
      `domains:${sourcePack.uniqueDomains || 0}`,
      `consistency:${metrics.sourceConsistencyScore || 0}`,
      `core:${metrics.coreSourceCount || 0}`,
      `supporting:${metrics.supportingSourceCount || 0}`,
    ],
  };
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function latestRelevantTimestamp(item) {
  const values = [
    item?.lastPublishedAt,
    item?.lastSelectedAt,
    item?.lastSeenAt,
    item?.discoveredAt,
    item?.brief?.discoveredAt,
  ].filter(Boolean);
  if (values.length === 0) return 0;
  return Math.max(...values.map((value) => new Date(value).getTime()).filter(Boolean));
}

function normalizeEntityList(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/,|;/);
  return Array.from(new Set(raw
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  ));
}
