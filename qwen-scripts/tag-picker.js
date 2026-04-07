// File: qwen-scripts/tag-picker.js
// Purpose: Pick canonical article tags from the controlled tag registry.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';
import { loadTaxonomyRegistry, resolveSectionId, resolveTopicId } from './utils/taxonomy-registry.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const TAG_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/contracts/tag-registry.json');
const MIN_CANONICAL_TAGS = 3;
const MAX_CANONICAL_TAGS = 6;
const SECTION_CATEGORY_FALLBACK_SLUG = {
  news: 'news-category',
  business: 'business-category',
  tech: 'tech-category',
  health: 'health-category',
  sports: 'sports-category',
  culture: 'culture-category',
};

let cachedRegistry = null;

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function loadTagRegistry() {
  if (!cachedRegistry) {
    cachedRegistry = loadJson(TAG_REGISTRY_PATH);
  }
  return cachedRegistry;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseScore(text, aliases = []) {
  let score = 0;
  const normalizedText = normalizeText(text);
  for (const alias of aliases || []) {
    const phrase = normalizeText(alias);
    if (!phrase) continue;
    const pattern = escapeRegex(phrase).replace(/ /g, '\s+');
    const regex = new RegExp(`(^|\b)${pattern}(\b|$)`, 'i');
    if (regex.test(normalizedText)) {
      score = Math.max(score, phrase.includes(' ') ? 10 : 6);
    }
  }
  return score;
}

function isShortAcronymEntity(tag) {
  if (tag?.type !== 'entity') return false;
  const label = String(tag?.label || '').trim();
  return /^[A-Z0-9]{2,4}$/.test(label);
}

function exactTokenHit(text, alias) {
  const raw = String(text || '');
  const cleanAlias = String(alias || '').trim();
  if (!raw || !cleanAlias) return false;
  const regex = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(cleanAlias)}([^A-Za-z0-9]|$)`, 'i');
  return regex.test(raw);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const cleaned = String(value).trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function normalizeArray(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function dedupeStrings(values = []) {
  return Array.from(new Set(normalizeArray(values)));
}

function gatherEntityInputs(context = {}, supportText = '') {
  const brief = context.brief || {};
  const sourcePack = context.sourcePack || {};
  const candidates = dedupeStrings([
    ...(brief.entities || []),
    ...(brief.involvedParties || []),
    ...(sourcePack.entities || []),
  ]);
  if (!supportText) return [];
  return candidates.filter((entity) => exactTokenHit(supportText, entity));
}

function getRoleBuckets(context = {}) {
  const sourcePack = context.sourcePack || {};
  const roleResults = Array.isArray(sourcePack.sourceRoleResults) ? sourcePack.sourceRoleResults : [];
  if (roleResults.length > 0) {
    const buckets = {
      core: [],
      supporting: [],
      background: [],
      signal_only: [],
      reject: [],
    };
    for (const result of roleResults) {
      const role = String(result?.role || 'signal_only');
      if (!buckets[role]) buckets[role] = [];
      if (result?.source) buckets[role].push(result.source);
    }
    return buckets;
  }

  const publishReady = Array.isArray(sourcePack.publishReadySources) && sourcePack.publishReadySources.length > 0
    ? sourcePack.publishReadySources
    : Array.isArray(sourcePack.sources)
      ? sourcePack.sources
      : [];

  return {
    core: publishReady,
    supporting: [],
    background: [],
    signal_only: [],
    reject: [],
  };
}

function tokenizeForOverlap(value) {
  return normalizeText(value).split(' ').filter((token) => token.length >= 3);
}

function countTokenOverlap(left, right) {
  const leftTokens = new Set(tokenizeForOverlap(left));
  if (leftTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of tokenizeForOverlap(right)) {
    if (leftTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function isUsableTagEvidenceSource(result = {}, anchorTitle = '') {
  const source = result?.source || {};
  const role = String(result?.role || '');
  if (!['core', 'supporting'].includes(role)) return false;
  if (source?.title_url_mismatch) return false;
  const pageKind = String(source?.page_kind || '').toLowerCase();
  if (['live', 'search', 'topic_page', 'index', 'landing_page'].includes(pageKind)) return false;
  const sameEvent = Number(result?.same_event_score || 0);
  const overlap = countTokenOverlap(anchorTitle, source?.title || '');
  return sameEvent >= 5 || overlap >= 2 || (sameEvent >= 4 && overlap >= 1);
}

function gatherSourceTitles(context = {}) {
  const buckets = getRoleBuckets(context);
  const sourcePack = context.sourcePack || {};
  const roleResults = Array.isArray(sourcePack.sourceRoleResults) ? sourcePack.sourceRoleResults : [];
  const anchorTitle = firstNonEmpty(context.brief?.title, context.draft?.title, '');
  const evidenceSources = roleResults.length > 0
    ? roleResults.filter((result) => isUsableTagEvidenceSource(result, anchorTitle)).map((result) => result.source)
    : [...(buckets.core || []), ...(buckets.supporting || [])].filter((source) => countTokenOverlap(anchorTitle, source?.title || '') >= 2);
  const directSources = evidenceSources.length > 0 ? evidenceSources : [...(buckets.core || []), ...(buckets.supporting || [])];
  const backgroundSources = [];
  const directSourceTitles = dedupeStrings(directSources.map((source) => source?.title));
  const backgroundSourceTitles = dedupeStrings(backgroundSources.map((source) => source?.title));
  return {
    directSourceTitles,
    backgroundSourceTitles,
    sourceTitles: dedupeStrings([...directSourceTitles, ...backgroundSourceTitles]),
  };
}

function buildTextCorpus(context = {}) {
  const draft = context.draft || {};
  const brief = context.brief || {};
  const titleBundle = [brief.title, draft.title].filter(Boolean).join(' ');
  const { directSourceTitles, backgroundSourceTitles, sourceTitles } = gatherSourceTitles(context);
  const directSourceText = directSourceTitles.join(' ');
  const summaryBundle = [draft.excerpt].filter(Boolean).join(' ');
  const supportText = [titleBundle, summaryBundle, directSourceText].filter(Boolean).join(' ');
  const entities = gatherEntityInputs(context, supportText);
  return {
    title: titleBundle,
    summary: summaryBundle,
    body: '',
    titleSummary: [titleBundle, summaryBundle].filter(Boolean).join(' '),
    directSourceTitles,
    backgroundSourceTitles,
    sourceTitles,
    directSourceText,
    entities,
  };
}

function resolveCanonicalPlacement(context = {}) {
  const taxonomy = loadTaxonomyRegistry();
  const draft = context.draft || {};
  const brief = context.brief || {};
  const sourcePack = context.sourcePack || {};
  const placement = context.placement || {};
  let topicId = resolveTopicId(firstNonEmpty(draft.topic_id, placement.topic_id, sourcePack.topic_id, brief.topic_id));
  let sectionId = resolveSectionId(firstNonEmpty(draft.section_id, placement.section_id, sourcePack.section_id, brief.section_id));
  if (topicId && taxonomy.sectionByTopic?.[topicId]) {
    sectionId = taxonomy.sectionByTopic[topicId];
  }
  return { sectionId, topicId };
}

function countExactHits(texts = [], aliases = []) {
  let hits = 0;
  for (const text of texts) {
    if ((aliases || []).some((alias) => exactTokenHit(text, alias))) hits += 1;
  }
  return hits;
}

function scoreWithExactHits(text, aliases = []) {
  const phrase = phraseScore(text, aliases);
  const exact = (aliases || []).some((alias) => exactTokenHit(text, alias)) ? 6 : 0;
  return Math.max(phrase, exact);
}

function buildEvidence(tag, corpus) {
  const aliases = Array.isArray(tag?.aliases) ? tag.aliases : [];
  const titleScore = scoreWithExactHits(corpus.title, aliases);
  const summaryScore = scoreWithExactHits(corpus.summary, aliases);
  const bodyScore = scoreWithExactHits(corpus.body, aliases);
  const directSourceTitleHits = corpus.directSourceTitles.reduce((acc, title) => acc + (scoreWithExactHits(title, aliases) > 0 ? 1 : 0), 0);
  const backgroundTitleHits = corpus.backgroundSourceTitles.reduce((acc, title) => acc + (scoreWithExactHits(title, aliases) > 0 ? 1 : 0), 0);
  const entityHits = corpus.entities.reduce((acc, entity) => acc + (scoreWithExactHits(entity, aliases) > 0 ? 1 : 0), 0);
  const exactTitleHits = countExactHits([corpus.title, corpus.summary], aliases);
  const exactBodyHits = countExactHits([corpus.body], aliases);
  const exactDirectTitleHits = countExactHits(corpus.directSourceTitles, aliases);
  const signalCount = [
    titleScore > 0,
    summaryScore > 0,
    bodyScore > 0,
    directSourceTitleHits > 0,
    entityHits > 0,
  ].filter(Boolean).length;

  return {
    titleScore,
    summaryScore,
    bodyScore,
    directSourceTitleHits,
    backgroundTitleHits,
    entityHits,
    exactTitleHits,
    exactBodyHits,
    exactDirectTitleHits,
    signalCount,
  };
}

function hasPrimaryEvidence(evidence) {
  return evidence.titleScore > 0 || evidence.summaryScore > 0 || evidence.directSourceTitleHits > 0 || evidence.entityHits > 0;
}

function hasStrongCrossSectionSupport(evidence) {
  const anchored = evidence.titleScore > 0 || evidence.summaryScore > 0 || evidence.directSourceTitleHits > 0 || evidence.entityHits > 0;
  return anchored && evidence.signalCount >= 2;
}

function hasDirectEvidence(evidence = {}) {
  return (evidence.titleScore || 0) > 0
    || (evidence.summaryScore || 0) > 0
    || (evidence.directSourceTitleHits || 0) > 0
    || (evidence.entityHits || 0) > 0;
}

function hasExplicitNamedSupport(evidence = {}) {
  return (evidence.exactTitleHits || 0) > 0
    || (evidence.directSourceTitleHits || 0) > 0
    || (evidence.entityHits || 0) > 0;
}

function passesShortEntityGuard(tag, corpus, topicId) {
  if (!isShortAcronymEntity(tag)) return true;

  if (Array.isArray(tag.topic_ids) && topicId && tag.topic_ids.includes(topicId)) {
    return true;
  }

  const evidence = buildEvidence(tag, corpus);
  return hasStrongCrossSectionSupport(evidence) || (evidence.exactTitleHits > 0 && evidence.exactBodyHits > 0);
}

function scoreTopicTag(tag, corpus, topicId, sectionId) {
  const evidence = buildEvidence(tag, corpus);
  let score = 0;
  if (topicId && tag.topic_ids?.includes(topicId)) score += 4;
  if (sectionId && tag.section_ids?.includes(sectionId)) score += 2;
  score += Math.round(evidence.titleScore * 2.5);
  score += Math.round(evidence.summaryScore * 1.5);
  score += Math.min(8, Math.floor(evidence.bodyScore / 2));
  score += evidence.directSourceTitleHits * 4;
  score += evidence.entityHits * 3;
  if (!hasPrimaryEvidence(evidence)) score -= 6;
  if (evidence.backgroundTitleHits > 0 && evidence.directSourceTitleHits === 0 && evidence.titleScore === 0 && evidence.summaryScore === 0) score -= 4;
  return { score, evidence };
}

function scoreThemeTag(tag, corpus, topicId, sectionId) {
  const evidence = buildEvidence(tag, corpus);
  let score = 0;
  if (topicId && tag.topic_ids?.includes(topicId)) score += 6;
  if (sectionId && tag.section_ids?.includes(sectionId)) score += 2;
  score += evidence.titleScore * 2;
  score += Math.round(evidence.summaryScore * 1.5);
  score += Math.min(6, Math.floor(evidence.bodyScore / 2));
  score += evidence.directSourceTitleHits * 3;
  score += evidence.entityHits * 2;
  if (!hasPrimaryEvidence(evidence)) score -= 5;
  return { score, evidence };
}

function scoreEntityTag(tag, corpus, topicId, sectionId) {
  const evidence = buildEvidence(tag, corpus);
  let score = 0;
  if (topicId && tag.topic_ids?.includes(topicId)) score += 5;
  if (sectionId && tag.section_ids?.includes(sectionId)) score += 2;
  score += evidence.entityHits * 8;
  score += evidence.directSourceTitleHits * 4;
  score += evidence.titleScore * 2;
  score += evidence.summaryScore;
  score += Math.min(4, Math.floor(evidence.bodyScore / 3));
  if (!hasPrimaryEvidence(evidence)) score -= 5;
  return { score, evidence };
}

function scoreGeographyTag(tag, corpus) {
  const evidence = buildEvidence(tag, corpus);
  const score = evidence.titleScore * 2 + evidence.summaryScore + Math.min(6, Math.floor(evidence.bodyScore / 2)) + evidence.directSourceTitleHits * 2;
  return { score, evidence };
}

function dedupeSelections(items) {
  const out = [];
  const seenSlugs = new Set();
  const seenLabels = new Set();
  for (const item of items) {
    if (!item?.slug || !item?.label) continue;
    const slugKey = normalizeText(item.slug);
    const labelKey = normalizeText(item.label);
    if (seenSlugs.has(slugKey) || seenLabels.has(labelKey)) continue;
    seenSlugs.add(slugKey);
    seenLabels.add(labelKey);
    out.push(item);
  }
  return out;
}

function hasTagType(items, type) {
  return Array.isArray(items) && items.some((item) => String(item?.type || '').toLowerCase() === String(type || '').toLowerCase());
}

function hasAnyNonTopicTag(items) {
  return Array.isArray(items) && items.some((item) => String(item?.type || '').toLowerCase() !== 'topic');
}

function pushFirstMatchingSelection(target, pool, predicate) {
  if (!Array.isArray(pool) || pool.length === 0) return false;
  const existing = new Set((target || []).map((item) => `${normalizeText(item?.slug)}|${normalizeText(item?.label)}`));
  for (const candidate of pool) {
    if (!candidate) continue;
    if (typeof predicate === 'function' && !predicate(candidate)) continue;
    const key = `${normalizeText(candidate?.slug)}|${normalizeText(candidate?.label)}`;
    if (existing.has(key)) continue;
    target.push(candidate);
    return true;
  }
  return false;
}

function buildFormatTagSelection(registry, articleType) {
  const normalized = String(articleType || '').trim().toLowerCase();
  if (!normalized) return null;
  const formatTag = Object.values(registry.bySlug || {}).find((tag) => tag.type === 'format' && normalizeText(tag.label) === normalizeText(normalized));
  return formatTag ? { ...formatTag, score: 10, reason: `Format from article type: ${articleType}` } : null;
}

function buildSectionCategoryFallbackSelection(registry, sectionId, topicId) {
  const slug = SECTION_CATEGORY_FALLBACK_SLUG[String(sectionId || '').trim().toLowerCase()];
  if (!slug) return null;
  const tag = registry.bySlug?.[slug];
  if (!tag) return null;
  if (topicId && Array.isArray(tag.topic_ids) && tag.topic_ids.length > 0 && !tag.topic_ids.includes(topicId)) return null;
  return buildSelectionItem(tag, 14, `Section category fallback (${sectionId})`, null, true);
}

function selectPrimaryTopicTag(registry, topicId, corpus, sectionId) {
  const mappedSlug = topicId ? registry.topicTagByTopicId?.[topicId] : null;
  const mappedTag = mappedSlug ? registry.bySlug?.[mappedSlug] || null : null;
  const topicCandidates = Object.values(registry.bySlug || {}).filter((tag) => tag.type === 'topic' && (!sectionId || tag.section_ids?.includes(sectionId) || tag.slug === mappedSlug));
  const scored = topicCandidates
    .map((tag) => {
      const { score, evidence } = scoreTopicTag(tag, corpus, topicId, sectionId);
      return { tag, score, evidence };
    })
    .filter((entry) => entry.score >= 8)
    .sort((a, b) => b.score - a.score);

  const best = scored[0] || null;
  const mappedEntry = mappedTag
    ? scored.find((entry) => entry.tag.slug === mappedTag.slug) || { tag: mappedTag, ...scoreTopicTag(mappedTag, corpus, topicId, sectionId) }
    : null;

  if (mappedEntry && mappedEntry.score >= 12) {
    return {
      tag: mappedEntry.tag,
      score: Math.max(mappedEntry.score, 40),
      reason: `Primary topic tag validated from topic_id=${topicId}`,
      evidence: mappedEntry.evidence,
    };
  }

  if (mappedTag) {
    return {
      tag: mappedTag,
      score: Math.max(mappedEntry?.score || 0, 24),
      reason: `Primary topic fallback locked to canonical topic_id=${topicId}`,
      evidence: mappedEntry?.evidence || null,
    };
  }

  if (best && best.score >= 12) {
    return {
      tag: best.tag,
      score: Math.max(best.score, 36),
      reason: mappedTag
        ? `Primary topic tag overridden by stronger evidence (${best.tag.label})`
        : `Primary topic tag selected from strongest evidence (${best.tag.label})`,
      evidence: best.evidence,
    };
  }

  return null;
}

function inferPrimaryTopicFromSupportCandidates(registry, candidates = [], preferredSectionId = null) {
  const sorted = [...candidates]
.filter((candidate) => candidate?.topic_ids?.length > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const candidate of sorted) {
    const topicIds = Array.isArray(candidate.topic_ids) ? candidate.topic_ids : [];
    const preferredTopicId = topicIds.find((topic) => {
      const topicSlug = registry.topicTagByTopicId?.[topic];
      const topicTag = topicSlug ? registry.bySlug?.[topicSlug] : null;
      return topicTag && (!preferredSectionId || topicTag.section_ids?.includes(preferredSectionId));
    }) || topicIds[0];
    if (!preferredTopicId) continue;
    const slug = registry.topicTagByTopicId?.[preferredTopicId];
    const topicTag = slug ? registry.bySlug?.[slug] : null;
    if (!topicTag) continue;
    return {
      tag: topicTag,
      score: Math.max((candidate.score || 0) + 6, 22),
      reason: `Primary topic inferred from supported ${candidate.type} tag ${candidate.label}`,
      evidence: candidate.evidence,
    };
  }

  return null;
}

function isWeakPrimaryTopicSelection(selection) {
  const evidence = selection?.evidence || {};
  return (evidence.titleScore || 0) === 0
    && (evidence.summaryScore || 0) === 0
    && (evidence.entityHits || 0) === 0
    && (evidence.directSourceTitleHits || 0) <= 1;
}

function buildSelectionItem(tag, score, reason, evidence, fallback = false) {
  return {
    slug: tag.slug,
    label: tag.label,
    type: tag.type,
    topic_ids: Array.isArray(tag.topic_ids) ? [...tag.topic_ids] : [],
    section_ids: Array.isArray(tag.section_ids) ? [...tag.section_ids] : [],
    score,
    reason,
    fallback,
    evidence: evidence ? {
      signal_count: evidence.signalCount,
      direct_source_title_hits: evidence.directSourceTitleHits,
      entity_hits: evidence.entityHits,
      title_score: evidence.titleScore,
      summary_score: evidence.summaryScore,
    } : undefined,
  };
}

function matchesPlacement(tag, sectionId, topicId) {
  const sectionMatch = !sectionId || !Array.isArray(tag?.section_ids) || tag.section_ids.length === 0 || tag.section_ids.includes(sectionId);
  const topicMatch = !topicId || !Array.isArray(tag?.topic_ids) || tag.topic_ids.length === 0 || tag.topic_ids.includes(topicId);
  return sectionMatch && topicMatch;
}

function hasAnchoredEvidence(evidence = {}) {
  return (evidence.titleScore || 0) > 0
    || (evidence.summaryScore || 0) > 0
    || (evidence.directSourceTitleHits || 0) > 0
    || (evidence.entityHits || 0) > 0;
}

function hasOnlyBodyEvidence(evidence = {}) {
  return (evidence.bodyScore || 0) > 0 && !hasAnchoredEvidence(evidence);
}

function anchoredSignalCount(evidence = {}) {
  return [
    (evidence.titleScore || 0) > 0,
    (evidence.summaryScore || 0) > 0,
    (evidence.directSourceTitleHits || 0) > 0,
    (evidence.entityHits || 0) > 0,
  ].filter(Boolean).length;
}

function isGenericAliasRisk(tag) {
  const values = [tag?.label, ...(Array.isArray(tag?.aliases) ? tag.aliases : [])]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  return values.some((value) => {
    const parts = value.split(' ').filter(Boolean);
    return parts.length === 1 && parts[0].length <= 4;
  });
}

function passesTagSanityGate(tag, evidence, sectionId, topicId) {
  const placementMatch = matchesPlacement(tag, sectionId, topicId);
  const anchored = hasAnchoredEvidence(evidence);
  const anchoredCount = anchoredSignalCount(evidence);
  const exactOrNamed = (evidence.exactTitleHits || 0) > 0 || (evidence.directSourceTitleHits || 0) > 0 || (evidence.entityHits || 0) > 0;

  if (hasOnlyBodyEvidence(evidence)) return false;

  switch (tag?.type) {
    case 'topic':
      if (Array.isArray(tag.topic_ids) && topicId && tag.topic_ids.includes(topicId)) {
        return hasDirectEvidence(evidence) && ((evidence.titleScore || 0) > 0 || (evidence.summaryScore || 0) > 0 || exactOrNamed);
      }
      return placementMatch
        ? hasDirectEvidence(evidence) && ((evidence.titleScore || 0) > 0 || (evidence.summaryScore || 0) > 0 || exactOrNamed)
        : hasStrongCrossSectionSupport(evidence) && exactOrNamed;
    case 'theme':
      if (!placementMatch) {
        if (isGenericAliasRisk(tag) && !exactOrNamed) return false;
        return hasStrongCrossSectionSupport(evidence) && exactOrNamed;
      }
      return hasDirectEvidence(evidence);
    case 'entity':
      if (!placementMatch && !exactOrNamed) return false;
      return hasExplicitNamedSupport(evidence) && (placementMatch || anchoredCount >= 2 || hasStrongCrossSectionSupport(evidence));
    case 'geography':
      return exactOrNamed || ((evidence.titleScore || 0) > 0 && (evidence.summaryScore || 0) > 0);
    case 'format':
      return true;
    default:
      return anchored;
  }
}

function shouldUseRelaxedFallback(tag, evidence, sectionId, topicId) {
  if (!passesTagSanityGate(tag, evidence, sectionId, topicId)) return false;
  if (tag?.type === 'topic' || tag?.type === 'entity') return false;
  if (matchesPlacement(tag, sectionId, topicId)) return hasDirectEvidence(evidence) && hasExplicitNamedSupport(evidence);
  return hasStrongCrossSectionSupport(evidence) && hasExplicitNamedSupport(evidence);
}

function shouldKeepCrossSectionTag(tag, evidence, sectionId, topicId) {
  const matchesCurrentSection = !sectionId || !Array.isArray(tag.section_ids) || tag.section_ids.includes(sectionId);
  const matchesCurrentTopic = !topicId || !Array.isArray(tag.topic_ids) || tag.topic_ids.includes(topicId);
  if (matchesCurrentSection || matchesCurrentTopic) return true;
  return hasStrongCrossSectionSupport(evidence) && hasExplicitNamedSupport(evidence);
}

function pushRankedSelections(target, entries, limit) {
  target.push(...entries.slice(0, limit));
}

function buildGeographyParentFallbacks(registry, geographySelections = []) {
  const stateToCountry = new Set(['california', 'new-york', 'washington', 'florida', 'texas']);
  const hasStateTag = geographySelections.some((item) => stateToCountry.has(String(item?.slug || '').trim().toLowerCase()));
  const hasUnitedStates = geographySelections.some((item) => normalizeText(item?.slug) === 'united-states');
  if (!hasStateTag || hasUnitedStates) return [];
  const unitedStatesTag = registry.bySlug?.['united-states'];
  if (!unitedStatesTag) return [];
  return [buildSelectionItem(unitedStatesTag, 12, 'Geography fallback inferred from U.S. state coverage', null, true)];
}

function sanitizeStoredTagging(selection = null) {
  if (!selection || typeof selection !== 'object') return null;
  const tags = Array.isArray(selection.tags) ? selection.tags.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const tag_slugs = Array.isArray(selection.tag_slugs) ? selection.tag_slugs.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (tags.length === 0 || tag_slugs.length === 0 || tags.length !== tag_slugs.length) return null;
  if (tags.length < 2 || tags.length > MAX_CANONICAL_TAGS) return null;
  if (!selection.primary_topic_slug) return null;
  const registry = loadTagRegistry();
  const tagRecords = [];
  for (const slug of tag_slugs) {
    const record = registry.bySlug?.[slug];
    if (!record) return null;
    tagRecords.push(record);
  }
  const hasTopic = tagRecords.some((record) => String(record?.type || '').toLowerCase() === 'topic');
  const hasNonTopic = tagRecords.some((record) => String(record?.type || '').toLowerCase() !== 'topic');
  if (!hasTopic || !hasNonTopic) return null;
  return {
    ...selection,
    tags,
    tag_slugs,
    selected: Array.isArray(selection.selected) ? selection.selected : [],
    warnings: Array.isArray(selection.warnings) ? selection.warnings : [],
    diagnostics: selection.diagnostics || {},
    source_of_truth: 'stored',
  };
}

export function resolveCanonicalTagFrame(context = {}) {
  const stored = sanitizeStoredTagging(context?.draft?.metadata?.tagging);
  if (stored) return stored;
  const picked = pickArticleTags(context);
  return { ...picked, source_of_truth: 'picked' };
}

export function pickArticleTags(context = {}) {
  const registry = loadTagRegistry();
  const { sectionId, topicId } = resolveCanonicalPlacement(context);
  const articleType = firstNonEmpty(context.draft?.article_type, context.draft?.articleType, context.brief?.article_type, context.brief?.articleType) || 'report';
  const corpus = buildTextCorpus(context);
  const warnings = [];
  const selected = [];
  const strictThemeLimit = 2;
  const strictEntityLimit = 1;

  const secondaryTopicEntries = Object.values(registry.bySlug || {})
    .filter((tag) => tag.type === 'topic')
    .filter((tag) => !topicId || !Array.isArray(tag.topic_ids) || !tag.topic_ids.includes(topicId))
    .map((tag) => {
      const { score, evidence } = scoreTopicTag(tag, corpus, topicId, sectionId);
      return { tag, score, evidence };
    })
    .filter((entry) => shouldKeepCrossSectionTag(entry.tag, entry.evidence, sectionId, topicId))
    .filter((entry) => passesTagSanityGate(entry.tag, entry.evidence, sectionId, topicId))
    .sort((a, b) => b.score - a.score);
  const secondaryTopicSelections = secondaryTopicEntries
    .filter((entry) => entry.score >= 10)
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Secondary topic score ${score}`, evidence));
  const secondaryTopicFallbackSelections = secondaryTopicEntries
    .filter((entry) => entry.score >= 6)
    .filter((entry) => shouldUseRelaxedFallback(entry.tag, entry.evidence, sectionId, topicId))
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Secondary topic fallback score ${score}`, evidence, true));

  const candidateThemeSlugs = Array.from(new Set([
    ...(registry.themeTagSlugsByTopicId?.[topicId] || []),
    ...Object.values(registry.bySlug || {}).filter((tag) => tag.type === 'theme').map((tag) => tag.slug),
  ]));
  const rawThemeEntries = candidateThemeSlugs
    .map((slug) => registry.bySlug?.[slug])
    .filter(Boolean)
    .map((tag) => {
      const { score, evidence } = scoreThemeTag(tag, corpus, topicId, sectionId);
      return { tag, score, evidence };
    })
    .filter((entry) => shouldKeepCrossSectionTag(entry.tag, entry.evidence, sectionId, topicId))
    .filter((entry) => passesTagSanityGate(entry.tag, entry.evidence, sectionId, topicId))
    .sort((a, b) => b.score - a.score);
  const themeSelections = rawThemeEntries
    .filter((entry) => entry.score >= 10)
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Theme match score ${score}`, evidence));
  const themeFallbackSelections = rawThemeEntries
    .filter((entry) => entry.score >= 6)
    .filter((entry) => shouldUseRelaxedFallback(entry.tag, entry.evidence, sectionId, topicId))
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Theme fallback score ${score}`, evidence, true));

  const candidateEntitySlugs = Array.from(new Set([
    ...(registry.entityTagSlugsByTopicId?.[topicId] || []),
    ...Object.values(registry.bySlug || {}).filter((tag) => tag.type === 'entity').map((tag) => tag.slug),
  ]));
  const rawEntityEntries = candidateEntitySlugs
    .map((slug) => registry.bySlug?.[slug])
    .filter(Boolean)
    .filter((tag) => passesShortEntityGuard(tag, corpus, topicId))
    .map((tag) => {
      const { score, evidence } = scoreEntityTag(tag, corpus, topicId, sectionId);
      return { tag, score, evidence };
    })
    .filter((entry) => shouldKeepCrossSectionTag(entry.tag, entry.evidence, sectionId, topicId))
    .filter((entry) => passesTagSanityGate(entry.tag, entry.evidence, sectionId, topicId))
    .sort((a, b) => b.score - a.score);
  const entitySelections = rawEntityEntries
    .filter((entry) => entry.score >= 10)
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Entity match score ${score}`, evidence));
  const entityFallbackSelections = rawEntityEntries
    .filter((entry) => entry.score >= 6)
    .filter((entry) => shouldUseRelaxedFallback(entry.tag, entry.evidence, sectionId, topicId))
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Entity fallback score ${score}`, evidence, true));

  let primaryTopicSelection = selectPrimaryTopicTag(registry, topicId, corpus, sectionId);
  const inferredPrimaryTopic = inferPrimaryTopicFromSupportCandidates(registry, [...themeSelections, ...entitySelections], sectionId);
  if (!primaryTopicSelection && inferredPrimaryTopic) {
    primaryTopicSelection = inferredPrimaryTopic;
  } else if (primaryTopicSelection && inferredPrimaryTopic && isWeakPrimaryTopicSelection(primaryTopicSelection) && inferredPrimaryTopic.tag?.slug !== primaryTopicSelection.tag?.slug) {
    primaryTopicSelection = inferredPrimaryTopic;
    warnings.push(`Primary topic tag overridden by stronger secondary evidence (${inferredPrimaryTopic.tag?.label})`);
  }
  if (!primaryTopicSelection && topicId) {
    warnings.push(`Primary topic tag omitted because validated evidence for topic_id=${topicId} remained sparse`);
  }

  if (primaryTopicSelection?.tag) {
    selected.push(buildSelectionItem(primaryTopicSelection.tag, primaryTopicSelection.score, primaryTopicSelection.reason));
  } else {
    warnings.push('Missing primary topic tag mapping');
  }

  pushRankedSelections(selected, secondaryTopicSelections, 0);
  pushRankedSelections(selected, themeSelections, strictThemeLimit);
  pushRankedSelections(selected, entitySelections, strictEntityLimit);

  const rawGeographyEntries = (registry.geographyTagSlugs || [])
    .map((slug) => registry.bySlug?.[slug])
    .filter(Boolean)
    .map((tag) => {
      const { score, evidence } = scoreGeographyTag(tag, corpus);
      return { tag, score, evidence };
    })
    .filter((entry) => passesTagSanityGate(entry.tag, entry.evidence, sectionId, topicId))
    .sort((a, b) => b.score - a.score);
  const geographySelections = rawGeographyEntries
    .filter((entry) => entry.score >= 8)
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Geography match score ${score}`, evidence));
  const geographyFallbackSelections = rawGeographyEntries
    .filter((entry) => entry.score >= 6)
    .filter((entry) => shouldUseRelaxedFallback(entry.tag, entry.evidence, sectionId, topicId))
    .map(({ tag, score, evidence }) => buildSelectionItem(tag, score, `Geography fallback score ${score}`, evidence, true));
  const geographyParentFallbackSelections = buildGeographyParentFallbacks(registry, geographySelections);
  pushRankedSelections(selected, geographySelections, 1);

  const formatSelection = buildFormatTagSelection(registry, articleType);
  if (formatSelection) selected.push(buildSelectionItem(formatSelection, formatSelection.score, formatSelection.reason));

  let deduped = dedupeSelections(selected);
  const nonTopicFallbackPool = dedupeSelections([
    ...themeSelections,
    ...entitySelections,
    ...geographySelections,
    ...themeFallbackSelections,
    ...entityFallbackSelections,
    ...geographyFallbackSelections,
    ...geographyParentFallbackSelections,
    ...(formatSelection ? [buildSelectionItem(formatSelection, formatSelection.score, formatSelection.reason, null, true)] : []),
  ]).sort((a, b) => (b.score || 0) - (a.score || 0));

  if (!hasTagType(deduped, 'topic')) {
    const inferredPrimary = inferPrimaryTopicFromSupportCandidates(registry, [...themeSelections, ...entitySelections, ...secondaryTopicSelections], sectionId);
    if (inferredPrimary?.tag) {
      deduped.push(buildSelectionItem(inferredPrimary.tag, inferredPrimary.score, inferredPrimary.reason, inferredPrimary.evidence, true));
    }
  }

  if (!hasAnyNonTopicTag(deduped)) {
    const added = pushFirstMatchingSelection(deduped, nonTopicFallbackPool, (item) => String(item?.type || '').toLowerCase() !== 'topic');
    if (!added) {
      const sectionFallback = buildSectionCategoryFallbackSelection(registry, sectionId, topicId);
      if (sectionFallback) {
        deduped.push(sectionFallback);
        warnings.push(`Non-topic evidence tag fallback applied from section category (${sectionId})`);
      } else {
        warnings.push('Missing non-topic evidence tag (entity/theme/geography/format)');
      }
    }
  }

  if (deduped.length < MIN_CANONICAL_TAGS) {
    const fallbackPool = dedupeSelections([
      ...secondaryTopicFallbackSelections,
      ...themeFallbackSelections,
      ...entityFallbackSelections,
      ...geographyFallbackSelections,
      ...geographyParentFallbackSelections,
      ...(formatSelection ? [buildSelectionItem(formatSelection, formatSelection.score, formatSelection.reason, null, true)] : []),
    ]).sort((a, b) => (b.score || 0) - (a.score || 0));

    for (const candidate of fallbackPool) {
      if (deduped.some((item) => normalizeText(item.slug) === normalizeText(candidate.slug) || normalizeText(item.label) === normalizeText(candidate.label))) continue;
      deduped.push(candidate);
      if (deduped.length >= MIN_CANONICAL_TAGS) break;
    }
  }

  const finalSelected = dedupeSelections(deduped).slice(0, MAX_CANONICAL_TAGS);
  const tags = finalSelected.map((item) => item.label);
  const tag_slugs = finalSelected.map((item) => item.slug);

  if (tags.length < MIN_CANONICAL_TAGS) warnings.push(`Canonical tag set is thin (${tags.length})`);
  if (tags.length > MAX_CANONICAL_TAGS) warnings.push(`Canonical tag set is too large (${tags.length})`);
  if (!hasTagType(finalSelected, 'topic')) warnings.push('Canonical tag set is missing required topic tag');
  if (!hasAnyNonTopicTag(finalSelected)) warnings.push('Canonical tag set is missing required non-topic evidence tag');

  return {
    tags,
    tag_slugs,
    primary_topic_tag: primaryTopicSelection?.tag?.label || null,
    primary_topic_slug: primaryTopicSelection?.tag?.slug || null,
    selected: finalSelected,
    warnings,
    diagnostics: {
      section_id: sectionId || null,
      topic_id: topicId || null,
      article_type: articleType || null,
      source_entity_count: corpus.entities.length,
      source_title_count: corpus.sourceTitles.length,
      direct_source_title_count: corpus.directSourceTitles.length,
      background_source_title_count: corpus.backgroundSourceTitles.length,
    },
  };
}

// ============================================================
// TAG REPAIR/ENRICHMENT — Future-facing tag correction
// Detects wrong tags based on actual content, replaces them with
// correct ones from the registry, adds missing relevant tags.
// ============================================================

/**
 * Sport-specific tag maps for cross-validation and enrichment.
 * Used ONLY for conservative removal of clearly wrong sport tags.
 * NOT used for auto-adding sport tags based on keyword collision.
 */
const SPORT_TAG_MAP = {
  'american-football': {
    tags: ['Football', 'NFL', 'College Football', 'NCAA Football'],
    wrongTags: ['Soccer', 'Premier League', 'FA Cup', 'Champions League', 'NBA', 'MLB', 'NHL'],
    keywords: ['nfl', 'college football', 'ncaa football', 'super bowl', 'touchdown', 'quarterback'],
  },
  'soccer': {
    tags: ['Football', 'Soccer', 'Premier League', 'FA Cup', 'Champions League'],
    wrongTags: ['NBA', 'NFL', 'MLB', 'NHL', 'Basketball', 'College Football'],
    keywords: ['premier league', 'fa cup', 'champions league', 'la liga', 'serie a', 'bundesliga', 'ligue 1'],
  },
  'basketball': {
    tags: ['Basketball', 'NBA', 'NCAA Basketball'],
    wrongTags: ['NFL', 'MLB', 'NHL', 'Soccer', 'Premier League', 'FA Cup'],
    keywords: ['basketball', 'nba', 'ncaa basketball', 'dunk', 'three-pointer', 'point guard'],
  },
  'cycling': {
    tags: ['Cycling'],
    wrongTags: ['Cybersecurity', 'NBA', 'NFL', 'Soccer'],
    keywords: ['cycling', 'cyclist', 'rider', 'peloton', 'tour de france', 'tour of flanders'],
  },
};

/**
 * Content extraction for tag validation.
 */
function extractContentText(draft, brief, sourcePack) {
  const parts = [];
  if (draft?.title) parts.push(draft.title);
  if (draft?.content) parts.push(draft.content);
  if (draft?.excerpt) parts.push(draft.excerpt);
  if (brief?.title) parts.push(brief.title);
  if (brief?.whatHappened) parts.push(brief.whatHappened);
  if (brief?.summary) parts.push(brief.summary);
  if (sourcePack?.sources) {
    for (const src of sourcePack.sources) {
      if (src?.title) parts.push(src.title);
      if (src?.summary) parts.push(src.summary);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Detect and repair wrong tags based on actual content.
 * Conservative approach:
 *   - Remove clearly invalid tags (sport tags in non-sport articles, vague tags)
 *   - DO NOT auto-add sport tags based on keyword collision
 *   - Tag additions only from locked taxonomy context (handled by caller)
 *
 * @param {Object} params - { tags, draft, brief, sourcePack, sectionId, topicId }
 * @returns {Object} { tags, tag_slugs, repaired, repairedTags, addedTags, removedTags, warnings }
 */
export function repairAndEnrichTags({ tags = [], draft = {}, brief = {}, sourcePack = {}, sectionId = '', topicId = '' } = {}) {
  const content = extractContentText(draft, brief, sourcePack);
  const removedTags = [];
  const addedTags = [];
  const warnings = [];
  const finalTags = [...tags];
  const wrongTagSet = new Set();

  // 1. Conservative remove: detect clearly wrong sport tags
  // Require BOTH: tag is a known wrongTag AND content strongly confirms a DIFFERENT sport
  const contentWords = new Set(content.split(/\s+/).filter((w) => w.length > 2));

  for (const tag of finalTags) {
    // Check if this tag is a sport tag that doesn't belong
    for (const [sport, config] of Object.entries(SPORT_TAG_MAP)) {
      if (!config.wrongTags.includes(tag)) continue;

      // Only remove if content strongly indicates a DIFFERENT sport
      const matchCount = config.keywords.filter((kw) => content.includes(kw.toLowerCase())).length;
      if (matchCount >= 2) {
        // Content matches this sport's keywords, so the wrong tag is genuinely wrong
        wrongTagSet.add(tag);
      }
    }
  }

  // 2. Remove vague/meaningless tags
  for (const tag of finalTags) {
    if (['Strategy', 'General', 'Overview', 'Summary'].includes(tag)) {
      wrongTagSet.add(tag);
    }
  }

  // 3. Remove wrong tags
  const filteredTags = finalTags.filter((tag) => !wrongTagSet.has(tag));
  for (const wrongTag of wrongTagSet) {
    removedTags.push(wrongTag);
    warnings.push(`Removed wrong tag: "${wrongTag}"`);
  }

  // 4. DO NOT auto-add sport tags based on keyword collision.
  // Tag additions should come from locked taxonomy context, not free-text matching.
  // If the caller needs sport tags, they should be added based on locked section/topic.

  // 5. Ensure reasonable tag count
  const enrichedTags = [...filteredTags, ...addedTags];
  const finalResult = enrichedTags.slice(0, 8);
  const slugs = finalResult.map((t) => String(t || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60));

  return {
    tags: finalResult,
    tag_slugs: slugs,
    repaired: wrongTagSet.size > 0 || addedTags.length > 0,
    repairedTags: [...removedTags.map((t) => ({ from: t, to: null })), ...addedTags.map((t) => ({ from: null, to: t }))],
    addedTags,
    removedTags: Array.from(wrongTagSet),
    warnings,
  };
}
