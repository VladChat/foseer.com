// File: qwen-scripts/utils/classification-sanity.js
// Purpose: Keep section/topic classification anchored to publish-ready sources and title, not noisy tags.

import {
  loadTaxonomyRegistry,
  resolveSectionId,
  resolveTopicId,
  getSectionRecord,
  getTopicRecord,
  matchTaxonomyHints,
} from './taxonomy-registry.js';

const GENERIC_CLASSIFICATION_TAGS = new Set([
  'analysis', 'report', 'explainer', 'breaking', 'deep', 'standard',
  'news', 'business', 'tech', 'technology', 'health', 'sports', 'culture',
  'world', 'general', 'featured', 'latest', 'update', 'updates',
]);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeStringArray(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const label = normalizeString(value);
    const key = normalizeKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(label);
  }
  return output;
}

function getPublishReadySources(sourcePack = {}) {
  const candidates = [
    ...(Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : []),
    ...(Array.isArray(sourcePack.primarySources) ? sourcePack.primarySources : []),
    ...(Array.isArray(sourcePack.supportingSources) ? sourcePack.supportingSources : []),
    ...(Array.isArray(sourcePack.sources) ? sourcePack.sources : []),
  ];

  const output = [];
  const seen = new Set();
  for (const source of candidates) {
    const key = normalizeString(source?.canonical_url || source?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output;
}

function buildSourceEvidenceCorpus(sourcePack = {}) {
  const sources = getPublishReadySources(sourcePack);
  return sources
    .map((source) => [
      source?.title,
      source?.summary,
      source?.snippet,
      source?.canonical_domain,
      source?.domain,
      source?.canonical_url,
      source?.url,
      ...(Array.isArray(source?.entities) ? source.entities : []),
    ].filter(Boolean).join(' '))
    .join(' | ')
    .trim();
}

function buildBriefEvidenceCorpus(eventBrief = {}, claimMap = null) {
  const parts = [
    eventBrief?.title,
    eventBrief?.summary,
    eventBrief?.whatHappened,
    eventBrief?.whyItMatters,
    ...(Array.isArray(eventBrief?.entities) ? eventBrief.entities : []),
    ...(Array.isArray(eventBrief?.involvedParties) ? eventBrief.involvedParties : []),
  ];

  const claims = Array.isArray(claimMap?.claims) ? claimMap.claims.slice(0, 6) : [];
  for (const claim of claims) {
    parts.push(claim?.claimText, claim?.evidenceExcerpt);
  }

  return parts.filter(Boolean).join(' | ').trim();
}

function addScore(scoreMap, id, weight, reason) {
  if (!id || !Number.isFinite(weight) || weight <= 0) return;
  const current = scoreMap.get(id) || { score: 0, reasons: [] };
  current.score += weight;
  if (reason) current.reasons.push(reason);
  scoreMap.set(id, current);
}

function getBestEntry(scoreMap) {
  const ranked = Array.from(scoreMap.entries())
    .map(([id, value]) => ({ id, score: Number(value?.score || 0), reasons: Array.isArray(value?.reasons) ? value.reasons : [] }))
    .sort((a, b) => b.score - a.score);
  return {
    best: ranked[0] || null,
    second: ranked[1] || null,
    ranked,
  };
}

function topicSection(topicId, registry = loadTaxonomyRegistry()) {
  const resolvedTopicId = resolveTopicId(topicId);
  return resolvedTopicId ? registry.sectionByTopic?.[resolvedTopicId] || getTopicRecord(resolvedTopicId)?.section_id || null : null;
}

function buildReasonSummary(bestEntry, secondEntry) {
  if (!bestEntry) return [];
  const reasons = Array.from(new Set(bestEntry.reasons.filter(Boolean)));
  if (secondEntry && secondEntry.score > 0) {
    reasons.push(`Won over secondary candidate by ${Math.max(bestEntry.score - secondEntry.score, 0)} points`);
  }
  return reasons.slice(0, 6);
}

function resolveConfidence(bestEntry, secondEntry) {
  const bestScore = Number(bestEntry?.score || 0);
  const gap = bestScore - Number(secondEntry?.score || 0);
  if (bestScore >= 10 && gap >= 3) return 'high';
  if (bestScore >= 6 && gap >= 2) return 'medium';
  return 'low';
}

function isEntityTagSupported(tagLabel, supportText) {
  const normalized = normalizeKey(tagLabel);
  if (!normalized || GENERIC_CLASSIFICATION_TAGS.has(normalized)) return false;
  if (normalized.length <= 2) return false;
  if (supportText.includes(normalized)) return true;
  const parts = normalized.split(' ').filter(Boolean);
  return parts.length >= 2 && parts.every((part) => supportText.includes(part));
}


function phraseSupportedInText(text, phrase) {
  const normalizedText = normalizeKey(text);
  const normalizedPhrase = normalizeKey(phrase);
  if (!normalizedText || !normalizedPhrase) return false;
  if (normalizedText.includes(normalizedPhrase)) return true;
  const parts = normalizedPhrase.split(' ').filter(Boolean);
  return parts.length >= 2 && parts.every((part) => normalizedText.includes(part));
}

function topicSupportedByEvidence(topicId, supportText) {
  const topic = getTopicRecord(topicId);
  if (!topic) return false;
  const phrases = [topic.label, topic.slug, ...(Array.isArray(topic.aliases) ? topic.aliases : [])].filter(Boolean);
  return phrases.some((phrase) => phraseSupportedInText(supportText, phrase));
}


function hasAnchorEvidenceForTopic(topicId, titleSupportText, sourceSupportText) {
  if (!topicId) return false;
  return topicSupportedByEvidence(topicId, titleSupportText) || topicSupportedByEvidence(topicId, sourceSupportText);
}

function sameResolvedTopic(a, b) {
  return Boolean(a) && Boolean(b) && resolveTopicId(a) === resolveTopicId(b);
}

function filterClassificationTags(rawTags, { topicId, topicLabel, sectionLabel, supportText, involvedParties = [] }) {
  const explicit = normalizeStringArray(rawTags);
  const output = [];
  const seen = new Set();

  const push = (value) => {
    const label = normalizeString(value);
    const key = normalizeKey(label);
    if (!label || !key || seen.has(key)) return;
    seen.add(key);
    output.push(label);
  };

  if (topicId && topicLabel) push(topicLabel);
  if (sectionLabel) push(sectionLabel);

  for (const value of involvedParties) {
    if (isEntityTagSupported(value, supportText)) push(value);
    if (output.length >= 6) break;
  }

  for (const value of explicit) {
    const key = normalizeKey(value);
    if (!key || GENERIC_CLASSIFICATION_TAGS.has(key)) continue;
    if (topicId && (key === normalizeKey(topicId) || key === normalizeKey(topicLabel))) {
      push(topicLabel || value);
      continue;
    }
    if (sectionLabel && key === normalizeKey(sectionLabel)) {
      push(sectionLabel);
      continue;
    }
    if (isEntityTagSupported(value, supportText)) push(value);
    if (output.length >= 6) break;
  }

  return output.slice(0, 8);
}

export function sanitizeStoryClassification(rawClassification = {}, eventBrief = {}, sourcePack = {}, claimMap = null) {
  const registry = loadTaxonomyRegistry();
  const sourceEvidence = buildSourceEvidenceCorpus(sourcePack);
  const briefEvidence = buildBriefEvidenceCorpus(eventBrief, claimMap);
  const titleEvidence = normalizeString(eventBrief?.title || sourcePack?.topic || rawClassification?.title || '');

  const sourceHints = matchTaxonomyHints(sourceEvidence, (getPublishReadySources(sourcePack) || []).map((source) => source?.url).filter(Boolean).join(' '));
  const titleHints = matchTaxonomyHints(titleEvidence, '');
  const briefHints = matchTaxonomyHints(briefEvidence, '');

  const topicScores = new Map();
  const sectionScores = new Map();

  const upstreamTopicId = resolveTopicId(sourcePack?.topic_id || eventBrief?.topic_id || rawClassification?.topic_id || null);
  const upstreamSectionId = resolveSectionId(sourcePack?.section_id || eventBrief?.section_id || rawClassification?.section_id || null);

  addScore(topicScores, upstreamTopicId, upstreamTopicId ? 2 : 0, 'Upstream topic carried forward');
  addScore(sectionScores, upstreamSectionId, upstreamSectionId ? 2 : 0, 'Upstream section carried forward');

  addScore(topicScores, sourceHints.detectedTopicId, sourceHints.detectedTopicId ? Math.max(5, Number(sourceHints.confidence || 0) + 1) : 0, 'Publish-ready source evidence');
  addScore(sectionScores, sourceHints.detectedSectionId, sourceHints.detectedSectionId ? Math.max(4, Number(sourceHints.confidence || 0)) : 0, 'Publish-ready source evidence');

  addScore(topicScores, titleHints.detectedTopicId, titleHints.detectedTopicId ? Math.max(4, Number(titleHints.confidence || 0)) : 0, 'Title evidence');
  addScore(sectionScores, titleHints.detectedSectionId, titleHints.detectedSectionId ? Math.max(3, Number(titleHints.confidence || 0) - 1) : 0, 'Title evidence');

  addScore(topicScores, briefHints.detectedTopicId, briefHints.detectedTopicId ? Math.max(2, Number(briefHints.confidence || 0) - 1) : 0, 'Brief evidence');
  addScore(sectionScores, briefHints.detectedSectionId, briefHints.detectedSectionId ? Math.max(2, Number(briefHints.confidence || 0) - 2) : 0, 'Brief evidence');

  if (upstreamTopicId) {
    addScore(sectionScores, topicSection(upstreamTopicId, registry), 2, 'Section implied by upstream topic');
  }
  if (sourceHints.detectedTopicId) {
    addScore(sectionScores, topicSection(sourceHints.detectedTopicId, registry), 3, 'Section implied by source-led topic');
  }
  if (titleHints.detectedTopicId) {
    addScore(sectionScores, topicSection(titleHints.detectedTopicId, registry), 2, 'Section implied by title-led topic');
  }

  const topicResolution = getBestEntry(topicScores);
  const sectionResolution = getBestEntry(sectionScores);

  let topicId = topicResolution.best?.score >= 5 ? topicResolution.best.id : null;
  const upstreamTopicSection = topicSection(upstreamTopicId, registry);
  const sourceLedSectionId = sourceHints.detectedSectionId ? resolveSectionId(sourceHints.detectedSectionId) : null;
  const briefLedSectionId = briefHints.detectedSectionId ? resolveSectionId(briefHints.detectedSectionId) : null;
  const titleSupportText = `${titleEvidence}`;
  const sourceSupportText = `${sourceEvidence}`;
  const anchoredSupportText = `${titleEvidence} | ${sourceEvidence}`;
  const evidenceSupportText = `${titleEvidence} | ${sourceEvidence} | ${briefEvidence}`;
  let droppedUnsupportedUpstreamTopic = false;
  const sourceTitleAgreement = sourceHints.detectedTopicId && titleHints.detectedTopicId && sameResolvedTopic(sourceHints.detectedTopicId, titleHints.detectedTopicId);

  if (
    topicId === upstreamTopicId
    && Number(topicResolution.best?.score || 0) <= 4
    && !hasAnchorEvidenceForTopic(upstreamTopicId, titleSupportText, sourceSupportText)
  ) {
    topicId = null;
    droppedUnsupportedUpstreamTopic = true;
  }

  if (
    topicId === upstreamTopicId
    && Number(topicResolution.best?.score || 0) <= 4
    && sourceLedSectionId
    && upstreamTopicSection
    && sourceLedSectionId !== upstreamTopicSection
  ) {
    topicId = null;
    droppedUnsupportedUpstreamTopic = true;
  }

  if (
    topicId
    && !hasAnchorEvidenceForTopic(topicId, titleSupportText, sourceSupportText)
    && !(sourceTitleAgreement && sameResolvedTopic(topicId, sourceHints.detectedTopicId))
  ) {
    topicId = null;
    droppedUnsupportedUpstreamTopic = true;
  }

  if (
    topicId
    && sourceHints.detectedTopicId
    && titleHints.detectedTopicId
    && !sourceTitleAgreement
    && Number(topicResolution.best?.score || 0) <= 6
  ) {
    topicId = null;
    droppedUnsupportedUpstreamTopic = true;
  }

  let sectionId = topicId ? topicSection(topicId, registry) : (sectionResolution.best?.score >= 3 ? sectionResolution.best.id : null);

  if (!topicId && droppedUnsupportedUpstreamTopic) {
    sectionId = sourceLedSectionId || briefLedSectionId || sectionId || null;
  }

  if (!sectionId && upstreamSectionId) {
    sectionId = upstreamSectionId;
  }
  if (
    !topicId
    && !droppedUnsupportedUpstreamTopic
    && upstreamTopicId
    && topicSection(upstreamTopicId, registry) === sectionId
    && sectionId === upstreamSectionId
    && hasAnchorEvidenceForTopic(upstreamTopicId, titleSupportText, sourceSupportText)
  ) {
    topicId = upstreamTopicId;
  }

  const warnings = [];
  if (upstreamTopicId && topicId && upstreamTopicId !== topicId) {
    warnings.push(`Topic corrected from ${upstreamTopicId} to ${topicId} using source-first evidence`);
  }
  if (droppedUnsupportedUpstreamTopic && upstreamTopicId && !topicId) {
    warnings.push(`Dropped unsupported upstream topic ${upstreamTopicId}`);
  }
  if (upstreamSectionId && sectionId && upstreamSectionId !== sectionId) {
    warnings.push(`Section corrected from ${upstreamSectionId} to ${sectionId} using source-first evidence`);
  }
  if (!topicId) warnings.push('Topic confidence remained low; section-only placement used');

  const topicRecord = topicId ? getTopicRecord(topicId) : null;
  const sectionRecord = sectionId ? getSectionRecord(sectionId) : null;
  const sectionLabel = sectionRecord?.label || rawClassification?.section || 'News';
  const topicLabel = topicRecord?.label || null;
  const supportText = anchoredSupportText.toLowerCase();
  const involvedParties = normalizeStringArray(eventBrief?.involvedParties || eventBrief?.entities || sourcePack?.entities || []);
  const tags = filterClassificationTags(
    [
      ...(Array.isArray(rawClassification?.tags) ? rawClassification.tags : []),
      ...(Array.isArray(eventBrief?.tags) ? eventBrief.tags : []),
      ...(Array.isArray(sourcePack?.entities) ? sourcePack.entities : []),
      ...involvedParties,
    ],
    { topicId, topicLabel, sectionLabel, supportText, involvedParties },
  );

  return {
    ...rawClassification,
    section: sectionLabel,
    section_id: sectionId || null,
    topic_id: topicId || null,
    topicLabel,
    tags,
    confidence: resolveConfidence(topicResolution.best, topicResolution.second),
    classificationReasons: buildReasonSummary(topicResolution.best || sectionResolution.best, topicResolution.second || sectionResolution.second),
    classificationWarnings: warnings,
    evidence: {
      sourceHints,
      titleHints,
      briefHints,
      sourceEvidenceSize: sourceEvidence.length,
      briefEvidenceSize: briefEvidence.length,
    },
  };
}
