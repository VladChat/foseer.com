// File: qwen-scripts/validate-publish-graph.js
// Purpose: Validate the writer→image→publisher graph and emit a canonical publish manifest.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

import { loadTaxonomyRegistry, getSectionRecord, getTopicRecord, resolveSectionId, resolveTopicId, getTopicIdsBySection, matchTaxonomyHints } from './utils/taxonomy-registry.js';
import { validateTagSelection } from './validate-tags.js';
import { loadTagRegistry, resolveCanonicalTagFrame } from './tag-picker.js';

const MANIFEST_DIR = path.resolve(PROJECT_ROOT, 'qwen-data', 'publish-manifests');
const INVALID_PUBLISHABLE_KINDS = new Set(['live', 'roundup', 'homepage', 'section', 'topic', 'video', 'audio']);
const GENERIC_SOURCE_PATTERNS = [
  /suggested search/i,
  /search results?/i,
  /topic page/i,
  /section page/i,
  /category page/i,
  /live updates?/i,
  /roundup/i,
];
const GENERIC_URL_PATTERNS = [
  /\/search(?:\/|\?|$)/i,
  /\/topic(?:\/|\?|$)/i,
  /\/topics(?:\/|\?|$)/i,
  /\/section(?:\/|\?|$)/i,
  /\/sections(?:\/|\?|$)/i,
  /\/category(?:\/|\?|$)/i,
  /\/categories(?:\/|\?|$)/i,
  /\/tag(?:\/|\?|$)/i,
  /\/tags(?:\/|\?|$)/i,
  /\/live(?:\/|\?|$)/i,
  /\/roundup(?:\/|\?|$)/i,
];
const STOP_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'how', 'in', 'into', 'is',
  'it', 'its', 'less', 'more', 'new', 'of', 'on', 'or', 'out', 's', 'says', 'still', 'suddenly', 'that', 'the', 'their',
  'them', 'this', 'to', 'up', 'what', 'when', 'why', 'with', 'would', 'you', 'your', 'photo', 'image', 'cover', 'illustration',
]);
const TOPIC_EXTRA_ALIASES = {
  'creators-platforms': ['social media', 'social media platforms', 'platform design', 'online platforms'],
  'economy-markets': ['market', 'stock market', 'market opens', 'stocks'],
  'climate-extreme-weather': ['climate damage', 'emissions', 'warming'],
  'athletes-culture': ['sports leagues', 'youth sports', 'athlete'],
  'events-tournaments': ['olympic', 'olympics', 'ioc'],
  'major-leagues': ['mlb', 'nba', 'major league baseball', 'national basketball association', 'baseball', 'basketball'],
  'world-geopolitics': [
    'israel',
    'palestinian',
    'gaza',
    'west bank',
    'ceasefire',
    'middle east',
    'diplomatic',
    'iran',
    'hormuz',
    'strait',
    'geopolitics',
    'geopolitical',
    'military escalation',
  ],
};

function resolvePlacement(selected = {}) {
  const registry = loadTaxonomyRegistry();
  const draft = selected.draft || {};
  const brief = selected.brief || {};
  const sourcePack = selected.sourcePack || {};
  const draftClassification = draft.metadata?.classification || {};

  const rawTopicId = resolveTopicId(firstNonEmpty(
    draft.topic_id,
    selected.placement?.topic_id,
    brief.topic_id,
    sourcePack.topic_id,
    draftClassification.topic_id,
  ));
  const rawSectionId = resolveSectionId(firstNonEmpty(
    draft.section_id,
    selected.placement?.section_id,
    brief.section_id,
    sourcePack.section_id,
    draftClassification.section_id,
  ));
  const article_type = normalizeArticleType(firstNonEmpty(draft.article_type, draft.articleType, brief.articleType, sourcePack.articleType, 'report'));
  const repairedPlacement = repairPlacementAgainstEvidence({
    topic_id: rawTopicId,
    section_id: rawTopicId ? (registry.sectionByTopic?.[rawTopicId] || rawSectionId) : rawSectionId,
    topic_label: firstNonEmpty(selected.placement?.topic_label, null),
  }, buildEvidenceText({ draft, brief, sourcePack }));
  const topic_id = repairedPlacement.topic_id || rawTopicId || null;
  const section_id = repairedPlacement.section_id || (topic_id ? registry.sectionByTopic?.[topic_id] || rawSectionId : rawSectionId);
  const topic = topic_id ? getTopicRecord(topic_id) : null;
  const section = section_id ? getSectionRecord(section_id) : null;
  const subsection = firstNonEmpty(draft.subsection, selected.placement?.subsection, topic?.label);

  return {
    section_id,
    section_label: section?.label || firstNonEmpty(draft.section, draftClassification.section, 'News'),
    topic_id,
    topic_label: topic?.label || repairedPlacement.topic_label || subsection || firstNonEmpty(brief.title, draft.title, 'Untitled topic'),
    subsection: subsection || null,
    article_type,
    repaired_from_topic_id: repairedPlacement.repaired_from_topic_id || null,
    repaired_from_section_id: repairedPlacement.repaired_from_section_id || null,
  };
}

export function evaluateSemanticIntegrity(selected = {}, placementOverride = null) {
  const draft = selected.draft || {};
  const brief = selected.brief || {};
  const sourcePack = selected.sourcePack || {};
  const image = selected.image || {};
  const placement = placementOverride || resolvePlacement(selected);
  const publishableSources = Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : [];

  const sourceChecks = evaluatePublishableSourceIntegrity({ draft, brief, sourcePack, publishableSources });
  const tagChecks = evaluateTagIntegrity({ draft, brief, sourcePack, placement });
  const imageChecks = evaluateImageIntegrity({ draft, brief, sourcePack, image, placement });

  const blocking_errors = [
    ...sourceChecks.errors,
    ...tagChecks.errors,
    ...imageChecks.errors,
  ];
  const warnings = [
    ...sourceChecks.warnings,
    ...tagChecks.warnings,
    ...imageChecks.warnings,
  ];

  return {
    editorial_valid: blocking_errors.length === 0,
    blocking_errors,
    warnings,
    source_checks: sourceChecks.details,
    tag_checks: tagChecks.details,
    image_checks: imageChecks.details,
  };
}

export function evaluateSourcePackEditorialIntegrity(candidate = {}, placementOverride = null) {
  const brief = candidate.brief || {};
  const sourcePack = candidate.sourcePack || {};
  const placement = placementOverride || resolveStage3Placement(brief, sourcePack);
  const publishableSources = Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : [];

  const sourceChecks = evaluatePublishableSourceIntegrity({ brief, sourcePack, publishableSources });
  const placementChecks = evaluatePlacementEvidenceIntegrity({ brief, sourcePack, placement });

  const blocking_errors = [
    ...sourceChecks.errors,
    ...placementChecks.errors,
  ];
  const warnings = [
    ...sourceChecks.warnings,
    ...placementChecks.warnings,
  ];

  return {
    editorial_valid: blocking_errors.length === 0,
    blocking_errors,
    warnings,
    placement,
    source_checks: sourceChecks.details,
    placement_checks: placementChecks.details,
  };
}

export function buildCanonicalPublishPayload(selected = {}, validated = null) {
  const draft = selected.draft || {};
  const brief = selected.brief || {};
  const sourcePack = selected.sourcePack || {};
  const placementBase = validated?.placement || resolvePlacement(selected);
  const effectiveTagging = validated?.effective_tagging || buildEffectiveTagging({ draft, brief, sourcePack, placement: placementBase });
  const topicRecord = placementBase.topic_id ? getTopicRecord(placementBase.topic_id) : null;
  const sectionRecord = placementBase.section_id ? getSectionRecord(placementBase.section_id) : null;
  const subsection = firstNonEmpty(placementBase.subsection, topicRecord?.label, null);
  const topics = dedupeStrings([
    ...(Array.isArray(selected?.placement?.topics) ? selected.placement.topics : []),
    ...(Array.isArray(draft.topics) ? draft.topics : []),
    subsection,
  ]).slice(0, 4);
  const canonicalSources = sanitizeCanonicalSources(
    sourcePack.canonicalPublicSources || sourcePack.publicSources || sourcePack.publishReadySources || sourcePack.sources,
  ).slice(0, 4);

  return {
    title: String(draft.title || brief.title || '').trim(),
    excerpt: String(draft.excerpt || brief.summary || '').trim(),
    placement: {
      section_id: placementBase.section_id || null,
      section_label: placementBase.section_label || sectionRecord?.label || null,
      section: placementBase.section_label || sectionRecord?.label || 'News',
      topic_id: placementBase.topic_id || null,
      topic_label: placementBase.topic_label || topicRecord?.label || subsection || null,
      subsection: subsection || null,
      topics,
      article_type: placementBase.article_type || normalizeArticleType(draft.article_type || draft.articleType),
    },
    tagging: {
      tags: Array.isArray(effectiveTagging.tags) ? effectiveTagging.tags.slice(0, 6) : [],
      tag_slugs: Array.isArray(effectiveTagging.tag_slugs) ? effectiveTagging.tag_slugs.slice(0, 6) : [],
      primary_topic_tag: effectiveTagging.primary_topic_tag || null,
      primary_topic_slug: effectiveTagging.primary_topic_slug || null,
      selected: Array.isArray(effectiveTagging.selected) ? effectiveTagging.selected : [],
      warnings: Array.isArray(effectiveTagging.warnings) ? effectiveTagging.warnings : [],
    },
    sources: canonicalSources,
  };
}

export function validatePrePublishGraph(selected = {}) {
  const errors = [];
  const warnings = [];
  const placement = resolvePlacement(selected);
  const draft = selected.draft || {};
  const sourcePack = selected.sourcePack || {};
  const image = selected.image || {};
  const registry = loadTaxonomyRegistry();
  const expectedSlug = buildExpectedSlug(draft.title || selected.publishIdentity?.title || selected.brief?.title || '');
  const actualSlug = String(selected.publishIdentity?.slug || selected.articleSlug || '').trim();
  const evidenceStats = computePublishableEvidenceStats(sourcePack);

  if (!selected.brief) errors.push('Missing brief payload');
  if (!draft.title || !String(draft.title).trim()) errors.push('Missing draft title');
  if (!draft.content || !String(draft.content).trim()) errors.push('Missing draft content');
  if (draft.safeForPublishing === false) errors.push('Draft is marked unsafe for publishing');
  if (!sourcePack.passesGate) errors.push('Source pack did not pass gate');
  if (!expectedSlug) errors.push('Missing expected slug from final draft title');
  if (!actualSlug) errors.push('Missing selected article slug');
  if (expectedSlug && actualSlug && expectedSlug !== actualSlug) {
    errors.push(`Slug mismatch: expected ${expectedSlug}, got ${actualSlug}`);
  }
  if (!placement.section_id) errors.push('Missing canonical section_id');
  if (!placement.topic_id) errors.push('Missing canonical topic_id');
  if (placement.section_id && !registry.sectionById?.[placement.section_id]) errors.push(`Unknown section_id: ${placement.section_id}`);
  if (placement.topic_id && !registry.topicById?.[placement.topic_id]) errors.push(`Unknown topic_id: ${placement.topic_id}`);
  if (placement.section_id && placement.topic_id && registry.sectionByTopic?.[placement.topic_id] !== placement.section_id) {
    errors.push(`Topic ${placement.topic_id} does not belong to section ${placement.section_id}`);
  }
  if (!image.imagePath) warnings.push('Image package missing imagePath; publisher will rely on fallback behavior');
  if ((sourcePack.metrics?.sourceConsistencyScore || 0) < 4) warnings.push('Source consistency score is weak');
  if ((draft.wordCount || 0) < 500) warnings.push('Draft is shorter than preferred publish target');
  const publishableSources = Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : [];
  const invalidPublishableKinds = publishableSources
    .map((source) => String(source?.page_kind || '').toLowerCase())
    .filter((kind) => INVALID_PUBLISHABLE_KINDS.has(kind));
  if (invalidPublishableKinds.length > 0) {
    errors.push(`Invalid publishable source kinds: ${Array.from(new Set(invalidPublishableKinds)).join(', ')}`);
  }
  if (placement.article_type === 'report') {
    if (evidenceStats.directEventSourceCount < 2) {
      errors.push(`Report requires at least 2 direct-event sources, found ${evidenceStats.directEventSourceCount}`);
    }
    if (evidenceStats.independentEventDomains < 2 && evidenceStats.directEventSourceCount >= 2) {
      errors.push(`Report requires at least 2 independent direct-event domains, found ${evidenceStats.independentEventDomains}`);
    }
  }
  const effectiveTagging = buildEffectiveTagging({ draft, brief: selected.brief || {}, sourcePack, placement });
  const tagValidation = validateTagSelection(effectiveTagging);
  if (!tagValidation.valid) errors.push(`Canonical tags invalid: ${tagValidation.errors.join('; ')}`);
  warnings.push(...tagValidation.warnings.map((item) => `Canonical tags: ${item}`));

  const semantic_report = evaluateSemanticIntegrity(selected, placement);
  errors.push(...semantic_report.blocking_errors);
  warnings.push(...semantic_report.warnings);

  return {
    valid: errors.length === 0,
    technical_valid: errors.length === semantic_report.blocking_errors.length,
    editorial_valid: semantic_report.editorial_valid,
    errors,
    warnings,
    placement,
    effective_tagging: effectiveTagging,
    semantic_report,
    canonical_publish_payload: buildCanonicalPublishPayload(selected, { placement, effective_tagging: effectiveTagging }),
  };
}

export function buildPublishManifest(selected = {}, publishResult = null) {
  const draft = selected.draft || {};
  const brief = selected.brief || {};
  const image = selected.image || {};
  const sourcePack = selected.sourcePack || {};
  const canonicalPayload = selected.canonicalPublishPayload || buildCanonicalPublishPayload(selected);
  const placement = canonicalPayload.placement;
  const canonicalSlug = publishResult?.canonicalSlug || null;
  const slug = String(selected.publishIdentity?.slug || selected.articleSlug || publishResult?.slug || canonicalSlug || '').trim();
  const semanticValidation = evaluateSemanticIntegrity(selected, {
    ...placement,
    section_label: placement.section_label,
    topic_label: placement.topic_label,
  });

  return {
    version: 3,
    generated_at: new Date().toISOString(),
    event_id: firstNonEmpty(brief.id, draft.eventId, null),
    cluster_id: firstNonEmpty(brief.cluster_id, null),
    article_type: placement.article_type,
    title: String(canonicalPayload.title || draft.title || brief.title || 'Untitled').trim(),
    slug,
    canonical_slug: canonicalSlug,
    expected_url: publishResult?.expectedUrl || `/article/${canonicalSlug || slug}`,
    file_path: publishResult?.filePath || null,
    published_at: publishResult?.publishedAt || null,
    section_id: placement.section_id,
    section_label: placement.section_label,
    topic_id: placement.topic_id,
    topic_label: placement.topic_label,
    subsection: placement.subsection,
    topics: Array.isArray(placement.topics) ? placement.topics : [],
    writer: {
      writer_id: draft.metadata?.writerPackage?.writerId || draft.metadata?.writerId || null,
      author_id: draft.metadata?.writerPackage?.authorId || draft.metadata?.authorId || null,
      author_name: draft.metadata?.writerPackage?.authorName || draft.authorName || null,
      author_title: draft.metadata?.writerPackage?.authorTitle || draft.authorTitle || null,
    },
    image: {
      provider: image.provider || null,
      image_path: image.imagePath || null,
      file_relative_path: image.imagePath ? String(image.imagePath).replace(/^~\//, 'src/') : null,
      source_url: image.sourceUrl || null,
      asset_key: image.metadata?.assetKey || null,
      alt_text: image.altText || image.imageAlt || null,
      selection_mode: image.metadata?.selectionMode || null,
      query_used: image.metadata?.queryUsed || null,
      relevance_tier: image.metadata?.relevanceTier || null,
      article_relevance_score: image.metadata?.articleRelevanceScore ?? null,
      asset_quality_score: image.metadata?.assetQualityScore ?? null,
      editorial_fit_score: image.metadata?.editorialFitScore ?? null,
      is_fallback: image.provider === 'fallback',
    },
    tags: Array.isArray(canonicalPayload.tagging?.tags) ? canonicalPayload.tagging.tags : [],
    source_pack: {
      passes_gate: Boolean(sourcePack.passesGate),
      unique_domains: sourcePack.uniqueDomains || 0,
      total_sources: Array.isArray(sourcePack.sources) ? sourcePack.sources.length : 0,
      direct_event_source_count: Number(sourcePack.metrics?.directEventSourceCount || 0),
      independent_event_domains: Number(sourcePack.metrics?.independentEventDomains || 0),
      publish_ready_sources: (Array.isArray(canonicalPayload.sources) ? canonicalPayload.sources : []).map((source) => ({
          title: source?.title || null,
          url: source?.url || null,
          domain: source?.domain || null,
        })),
    },
    semantic_validation: {
      editorial_valid: semanticValidation.editorial_valid,
      blocking_errors: semanticValidation.blocking_errors,
      warnings: semanticValidation.warnings,
      source_checks: semanticValidation.source_checks,
      tag_checks: semanticValidation.tag_checks,
      image_checks: semanticValidation.image_checks,
    },
  };
}

export function writePublishManifest(manifest) {
  if (!manifest?.slug) return null;
  if (!fs.existsSync(MANIFEST_DIR)) fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const filePath = path.join(MANIFEST_DIR, `${manifest.slug}.json`);
  const payload = JSON.stringify(manifest, null, 2);
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === payload) return filePath;
  }
  fs.writeFileSync(filePath, payload, 'utf-8');
  return filePath;
}

export function validatePublishedArtifact(filePath, manifest) {
  const errors = [];
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, errors: ['Published file not found'] };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { valid: false, errors: ['Published file frontmatter missing'] };
  const frontmatter = parseSimpleFrontmatter(match[1]);
  if (String(frontmatter.title || '').trim() !== String(manifest.title || '').trim()) errors.push('Published frontmatter title mismatch');
  if (String(frontmatter.section_id || '') !== String(manifest.section_id || '')) errors.push('Published frontmatter section_id mismatch');
  if (String(frontmatter.topic_id || '') !== String(manifest.topic_id || '')) errors.push('Published frontmatter topic_id mismatch');
  if (normalizeArticleType(frontmatter.article_type) !== normalizeArticleType(manifest.article_type)) errors.push('Published frontmatter article_type mismatch');
  if (manifest.image?.image_path && String(frontmatter.image || '') !== String(manifest.image.image_path)) errors.push('Published frontmatter image mismatch');
  return { valid: errors.length === 0, errors, frontmatter };
}

function evaluatePublishableSourceIntegrity({ draft = {}, brief = {}, sourcePack = {}, publishableSources = [] } = {}) {
  const errors = [];
  const warnings = [];
  const mismatchedSources = [];
  const genericSources = [];
  const overlapIssues = [];
  const articleTitle = String(draft.title || brief.title || '').trim();
  const titleTokens = getSignificantTokens(articleTitle);

  for (const source of publishableSources) {
    const mismatch = analyzeTitleUrlAlignment(source);
    if (mismatch.mismatch) {
      mismatchedSources.push({
        title: source?.title || null,
        url: source?.canonical_url || source?.url || null,
        overlap_ratio: mismatch.overlapRatio,
      });
      errors.push(`Publish-ready source title/url mismatch: ${source?.title || source?.canonical_url || source?.url || 'unknown source'}`);
    }
    if (isGenericPublishableSource(source)) {
      genericSources.push({
        title: source?.title || null,
        url: source?.canonical_url || source?.url || null,
        page_kind: source?.page_kind || null,
      });
      errors.push(`Publish-ready source is generic or index-like: ${source?.title || source?.canonical_url || source?.url || 'unknown source'}`);
    }
    const titleOverlap = scoreArticleTitleOverlap(articleTitle, source?.title || '');
    if (titleTokens.length >= 4 && titleOverlap.sharedTokenCount < 2 && titleOverlap.overlapRatio < 0.24) {
      overlapIssues.push({
        title: source?.title || null,
        url: source?.canonical_url || source?.url || null,
        overlap_ratio: titleOverlap.overlapRatio,
        shared_tokens: titleOverlap.sharedTokens,
      });
    }
  }

  const strongMatches = overlapIssues.length < publishableSources.length
    ? publishableSources.filter((source) => {
        const overlap = scoreArticleTitleOverlap(articleTitle, source?.title || '');
        return overlap.sharedTokenCount >= 2 || overlap.overlapRatio >= 0.35;
      }).length
    : 0;
  if (strongMatches >= 1 && overlapIssues.length >= 2) {
    errors.push(`Publish-ready source pack mixes unrelated event titles (${overlapIssues.length} weak-title sources)`);
  } else if (overlapIssues.length === 1 && publishableSources.length >= 4) {
    warnings.push('One publish-ready source has weak title overlap with the article title');
  }

  return {
    errors,
    warnings,
    details: {
      publish_ready_count: publishableSources.length,
      mismatched_sources: mismatchedSources,
      generic_sources: genericSources,
      weak_title_overlap_sources: overlapIssues,
    },
  };
}

function evaluateTagIntegrity({ draft = {}, brief = {}, sourcePack = {}, placement = {} } = {}) {
  const errors = [];
  const warnings = [];
  const registry = loadTagRegistry();
  const tagging = buildEffectiveTagging({ draft, brief, sourcePack, placement });
  const selections = buildSelectedTagRecords(tagging, registry);
  const evidenceText = [
    draft.title,
    draft.excerpt,
    brief.title,
    brief.summary,
    brief.whatHappened,
    brief.whyItMatters,
    (Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : []).map((source) => source?.title || '').join(' '),
    String(draft.content || '').slice(0, 5000),
  ].filter(Boolean).join(' ');

  const unsupportedTags = [];
  for (const entry of selections) {
    const support = computeAliasSupport(evidenceText, entry.aliases);
    const isPrimary = entry.slug && entry.slug === tagging.primary_topic_slug;
    const supportedByFormat = entry.type === 'format' && normalizeArticleType(draft.article_type || draft.articleType) === entry.slug;
    if (!support.supported && !supportedByFormat) {
      unsupportedTags.push({ slug: entry.slug, label: entry.label, support });
      errors.push(`${isPrimary ? 'Primary topic tag unsupported by article evidence' : 'Canonical tag unsupported by article evidence'}: ${entry.label}`);
    }
  }

  const topicRecord = placement.topic_id ? getTopicRecord(placement.topic_id) : null;
  const topicAliases = expandTopicAliases(topicRecord, placement.topic_label);
  const topicSupport = computeAliasSupport(evidenceText, topicAliases);
  if (topicSupport.supported && placement.topic_id) {
    const primarySlug = String(placement.topic_id).trim().toLowerCase();
    for (let index = unsupportedTags.length - 1; index >= 0; index -= 1) {
      if (String(unsupportedTags[index]?.slug || '').trim().toLowerCase() === primarySlug) {
        unsupportedTags.splice(index, 1);
      }
    }
    const primaryLabel = topicRecord?.label || placement.topic_label || placement.topic_id;
    for (let index = errors.length - 1; index >= 0; index -= 1) {
      if (String(errors[index]).includes(`Primary topic tag unsupported by article evidence: ${primaryLabel}`)) {
        errors.splice(index, 1);
      }
    }
  }
  if (placement.topic_id && topicAliases.length > 0 && !topicSupport.supported) {
    errors.push(`Primary topic_id unsupported by article evidence: ${placement.topic_id}`);
  }

  if ((Array.isArray(tagging.tags) ? tagging.tags.length : 0) < 3) {
    warnings.push('Canonical tag set is thinner than expected for publish review');
  }

  return {
    errors,
    warnings,
    details: {
      selected_tags: selections.map((entry) => ({ slug: entry.slug, label: entry.label, type: entry.type || null })),
      unsupported_tags: unsupportedTags,
      primary_topic: {
        topic_id: placement.topic_id || null,
        topic_label: placement.topic_label || null,
        supported: topicSupport.supported,
        matched_aliases: topicSupport.matchedAliases,
      },
    },
  };
}


function buildEvidenceText({ draft = {}, brief = {}, sourcePack = {} } = {}) {
  return [
    draft.title,
    draft.excerpt,
    draft.content ? String(draft.content).slice(0, 5000) : '',
    brief.title,
    brief.summary,
    brief.whatHappened,
    brief.whyItMatters,
    (Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : []).map((source) => source?.title || '').join(' '),
  ].filter(Boolean).join(' ');
}

function buildEffectiveTagging({ draft = {}, brief = {}, sourcePack = {}, placement = {} } = {}) {
  const picked = resolveCanonicalTagFrame({ draft, brief, sourcePack, placement });
  if (picked && Array.isArray(picked.tags) && picked.tags.length > 0 && picked.primary_topic_slug) {
    return picked;
  }

  const registry = loadTagRegistry();
  const primary = placement?.topic_id ? registry.bySlug?.[placement.topic_id] : null;
  if (primary) {
    return {
      tags: [primary.label],
      tag_slugs: [primary.slug],
      primary_topic_tag: primary.label,
      primary_topic_slug: primary.slug,
      selected: [{ slug: primary.slug, label: primary.label, score: 100, reason: 'Synthesized primary topic tag from repaired placement' }],
      warnings: ['Synthesized canonical primary topic tag from repaired placement'],
      diagnostics: {
        section_id: placement?.section_id || null,
        topic_id: placement?.topic_id || null,
        article_type: placement?.article_type || draft.article_type || draft.articleType || null,
        source_entity_count: 0,
        source_title_count: Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources.length : 0,
        direct_source_title_count: 0,
        background_source_title_count: 0,
      },
    };
  }

  return {
    tags: [],
    tag_slugs: [],
    primary_topic_tag: null,
    primary_topic_slug: null,
    selected: [],
    warnings: ['Unable to synthesize canonical topic tag'],
    diagnostics: {
      section_id: placement?.section_id || null,
      topic_id: placement?.topic_id || null,
      article_type: placement?.article_type || draft.article_type || draft.articleType || null,
      source_entity_count: 0,
      source_title_count: Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources.length : 0,
      direct_source_title_count: 0,
      background_source_title_count: 0,
    },
  };
}

function normalizeSupportToken(token) {
  const clean = String(token || '').trim().toLowerCase();
  if (!clean) return null;
  if (clean.length > 4 && clean.endsWith('ies')) return `${clean.slice(0, -3)}y`;
  if (clean.length > 4 && clean.endsWith('s')) return clean.slice(0, -1);
  return clean;
}

function expandTopicAliases(topicRecord = null, extraLabel = null) {
  const topicId = topicRecord?.id || null;
  return dedupeStrings([
    topicRecord?.label,
    ...(Array.isArray(topicRecord?.aliases) ? topicRecord.aliases : []),
    topicRecord?.slug,
    extraLabel,
    ...(topicId ? (TOPIC_EXTRA_ALIASES[topicId] || []) : []),
  ]);
}

function repairPlacementAgainstEvidence(basePlacement = {}, evidenceText = '') {
  const registry = loadTaxonomyRegistry();
  const rawTopicId = resolveTopicId(basePlacement.topic_id || null);
  const rawSectionId = resolveSectionId(basePlacement.section_id || null);
  const currentTopic = rawTopicId ? getTopicRecord(rawTopicId) : null;
  const currentAliases = expandTopicAliases(currentTopic, basePlacement.topic_label);
  const currentSupport = computeAliasSupport(evidenceText, currentAliases);

  if (rawTopicId && currentSupport.supported) {
    return {
      topic_id: rawTopicId,
      section_id: registry.sectionByTopic?.[rawTopicId] || rawSectionId || null,
      topic_label: currentTopic?.label || basePlacement.topic_label || null,
    };
  }

  const hintMatch = matchTaxonomyHints(evidenceText || '', '');
  let candidateTopicIds = [];
  if (rawSectionId) {
    candidateTopicIds.push(...getTopicIdsBySection(rawSectionId));
  }
  if (hintMatch.detectedSectionId && hintMatch.detectedSectionId !== rawSectionId) {
    candidateTopicIds.push(...getTopicIdsBySection(hintMatch.detectedSectionId));
  }
  candidateTopicIds.push(...(hintMatch.topicCandidates || []));
  candidateTopicIds.push(...Object.keys(registry.topicById || {}));
  candidateTopicIds = dedupeStrings(candidateTopicIds.map((value) => resolveTopicId(value)));

  let best = null;
  for (const topicId of candidateTopicIds) {
    const record = getTopicRecord(topicId);
    if (!record) continue;
    const aliases = expandTopicAliases(record, null);
    const support = computeAliasSupport(evidenceText, aliases);
    let score = support.matchedAliases.length * 10;
    if (topicId === 'companies-deals' && support.matchedAliases.every((alias) => /^companies?$/i.test(alias))) score -= 4;
    if (topicId === 'world-geopolitics' && support.matchedAliases.every((alias) => /^(world news|world|geopolitics)$/i.test(alias))) score -= 4;
    const aliasTokens = dedupeStrings(aliases.flatMap((alias) => getSignificantTokens(alias).map((token) => normalizeSupportToken(token)).filter(Boolean)));
    const evidenceTokens = dedupeStrings(getSignificantTokens(evidenceText).map((token) => normalizeSupportToken(token)).filter(Boolean));
    const tokenOverlap = intersectTokens(aliasTokens, evidenceTokens);
    score += tokenOverlap.length * 2;
    if (hintMatch.detectedTopicId && resolveTopicId(hintMatch.detectedTopicId) === topicId) score += 6;
    if (rawSectionId && record.section_id === rawSectionId) score += 2;
    if (rawTopicId && topicId === rawTopicId) score += 1;
    if (!best || score > best.score) {
      best = {
        topic_id: topicId,
        section_id: record.section_id || registry.sectionByTopic?.[topicId] || rawSectionId || hintMatch.detectedSectionId || null,
        topic_label: record.label,
        score,
        supported: support.supported,
        matched_aliases: support.matchedAliases,
        token_overlap: tokenOverlap,
      };
    }
  }

  if (best && (best.supported || best.score >= 6)) {
    return {
      topic_id: best.topic_id,
      section_id: best.section_id,
      topic_label: best.topic_label,
      repaired_from_topic_id: rawTopicId && rawTopicId !== best.topic_id ? rawTopicId : null,
      repaired_from_section_id: rawSectionId && rawSectionId !== best.section_id ? rawSectionId : null,
    };
  }

  return {
    topic_id: rawTopicId || resolveTopicId(hintMatch.detectedTopicId || null) || null,
    section_id: rawSectionId || resolveSectionId(hintMatch.detectedSectionId || null) || null,
    topic_label: currentTopic?.label || basePlacement.topic_label || null,
  };
}

function evaluatePlacementEvidenceIntegrity({ brief = {}, sourcePack = {}, placement = {} } = {}) {
  const errors = [];
  const warnings = [];
  const topicRecord = placement.topic_id ? getTopicRecord(placement.topic_id) : null;
  const topicAliases = expandTopicAliases(topicRecord, placement.topic_label);
  const evidenceText = [
    brief.title,
    brief.summary,
    brief.whatHappened,
    brief.whyItMatters,
    (Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : []).map((source) => source?.title || '').join(' '),
  ].filter(Boolean).join(' ');
  const topicSupport = computeAliasSupport(evidenceText, topicAliases);

  if (placement.topic_id && topicAliases.length > 0 && !topicSupport.supported) {
    errors.push(`Primary topic_id unsupported by source-pack evidence: ${placement.topic_id}`);
  }

  return {
    errors,
    warnings,
    details: {
      topic_id: placement.topic_id || null,
      topic_label: placement.topic_label || null,
      supported: topicSupport.supported,
      matched_aliases: topicSupport.matchedAliases,
    },
  };
}

function resolveStage3Placement(brief = {}, sourcePack = {}) {
  const rawTopicId = firstNonEmpty(sourcePack.topic_id, brief.topic_id, null);
  const rawSectionId = firstNonEmpty(sourcePack.section_id, brief.section_id, null);
  const repairedPlacement = repairPlacementAgainstEvidence({
    topic_id: rawTopicId,
    section_id: rawTopicId ? (loadTaxonomyRegistry().sectionByTopic?.[rawTopicId] || rawSectionId) : rawSectionId,
    topic_label: null,
  }, buildEvidenceText({ brief, sourcePack }));
  const topic_id = repairedPlacement.topic_id || rawTopicId || null;
  const section_id = repairedPlacement.section_id || rawSectionId || null;
  const topic = topic_id ? getTopicRecord(topic_id) : null;
  const section = section_id ? getSectionRecord(section_id) : null;
  return {
    section_id,
    section_label: section?.label || firstNonEmpty(brief.section, null),
    topic_id,
    topic_label: topic?.label || repairedPlacement.topic_label || firstNonEmpty(brief.title, null),
    subsection: null,
    article_type: normalizeArticleType(firstNonEmpty(sourcePack.articleType, brief.articleType, 'report')),
    repaired_from_topic_id: repairedPlacement.repaired_from_topic_id || null,
    repaired_from_section_id: repairedPlacement.repaired_from_section_id || null,
  };
}

function evaluateImageIntegrity({ draft = {}, brief = {}, sourcePack = {}, image = {}, placement = {} } = {}) {
  const errors = [];
  const warnings = [];
  const metadata = image?.metadata || {};
  const queryUsed = String(metadata?.queryUsed || '').trim();
  const evidenceText = [
    draft.title,
    draft.excerpt,
    brief.title,
    brief.summary,
    brief.whatHappened,
    (Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : []).map((source) => source?.title || '').join(' '),
  ].filter(Boolean).join(' ');

  const queryTokens = getSignificantTokens(queryUsed);
  const evidenceTokens = getSignificantTokens(evidenceText);
  const overlap = intersectTokens(queryTokens, evidenceTokens);
  const overlapRatio = queryTokens.length > 0 ? Number((overlap.length / queryTokens.length).toFixed(2)) : 1;
  const articleRelevanceScore = Number(metadata?.articleRelevanceScore || 0);
  const relevanceTier = String(metadata?.relevanceTier || '').trim().toLowerCase();
  const placeholderQuery = /(^|\W)unspecified(\W|$)/i.test(queryUsed);

  if (queryUsed && placeholderQuery) {
    errors.push('Image query contains placeholder entity text');
  }
  if (queryTokens.length >= 3 && overlapRatio < 0.34 && articleRelevanceScore >= 95) {
    errors.push(`Image relevance score is overstated for weak semantic match (${overlapRatio})`);
  } else if (queryTokens.length >= 3 && overlapRatio < 0.34 && relevanceTier === 'strong') {
    warnings.push(`Strong image tier assigned despite weak query/article overlap (${overlapRatio})`);
  }

  const topicRecord = placement.topic_id ? getTopicRecord(placement.topic_id) : null;
  const topicAliases = expandTopicAliases(topicRecord, placement.topic_label);
  const queryTopicSupport = computeAliasSupport(queryUsed, topicAliases);
  const articleTopicSupport = computeAliasSupport(evidenceText, topicAliases);
  if (topicAliases.length > 0 && queryUsed && queryTopicSupport.supported && !articleTopicSupport.supported) {
    errors.push(`Image query reinforces unsupported topic context: ${placement.topic_label || placement.topic_id}`);
  }

  return {
    errors,
    warnings,
    details: {
      provider: image?.provider || null,
      query_used: queryUsed || null,
      article_relevance_score: Number.isFinite(articleRelevanceScore) ? articleRelevanceScore : null,
      relevance_tier: metadata?.relevanceTier || null,
      overlap_ratio: overlapRatio,
      shared_tokens: overlap,
      placeholder_query: placeholderQuery,
    },
  };
}

function buildSelectedTagRecords(tagging = {}, registry = {}) {
  const bySlug = registry?.bySlug || {};
  const tagList = Array.isArray(registry?.tags) ? registry.tags : [];
  const labels = Array.isArray(tagging.tags) ? tagging.tags : [];
  const slugs = Array.isArray(tagging.tag_slugs) ? tagging.tag_slugs : [];
  const seen = new Set();
  const records = [];

  for (const slug of slugs) {
    const record = bySlug[slug];
    if (!record) continue;
    if (seen.has(record.slug)) continue;
    seen.add(record.slug);
    records.push({
      slug: record.slug,
      label: record.label,
      type: record.type,
      aliases: expandTopicAliases(record, record.label),
    });
  }

  for (const label of labels) {
    const record = tagList.find((item) => String(item?.label || '').trim().toLowerCase() == String(label || '').trim().toLowerCase());
    const slug = record?.slug || normalizeKey(label);
    if (seen.has(slug)) continue;
    seen.add(slug);
    records.push({
      slug,
      label: record?.label || label,
      type: record?.type || null,
      aliases: record ? expandTopicAliases(record, label) : dedupeStrings([label]),
    });
  }

  return records;
}

function analyzeTitleUrlAlignment(source = {}) {
  const titleTokens = getSignificantTokens(source?.title || '');
  const urlTokens = getUrlTokens(source?.canonical_url || source?.url || '');
  const overlap = intersectTokens(titleTokens, urlTokens);
  const overlapRatio = titleTokens.length > 0 ? Number((overlap.length / titleTokens.length).toFixed(2)) : 1;
  const mismatch = titleTokens.length >= 4 && urlTokens.length >= 3 && overlap.length === 0;
  return {
    mismatch,
    overlapRatio,
    overlap,
    titleTokens,
    urlTokens,
  };
}

function scoreArticleTitleOverlap(articleTitle, sourceTitle) {
  const articleTokens = getSignificantTokens(articleTitle);
  const sourceTokens = getSignificantTokens(sourceTitle);
  const sharedTokens = intersectTokens(articleTokens, sourceTokens);
  const denom = Math.max(articleTokens.length, 1);
  return {
    sharedTokens,
    sharedTokenCount: sharedTokens.length,
    overlapRatio: Number((sharedTokens.length / denom).toFixed(2)),
  };
}

function isGenericPublishableSource(source = {}) {
  const title = String(source?.title || '').trim();
  const url = String(source?.canonical_url || source?.url || '').trim();
  const pageKind = String(source?.page_kind || '').trim().toLowerCase();
  if (INVALID_PUBLISHABLE_KINDS.has(pageKind)) return true;
  if (GENERIC_SOURCE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  if (GENERIC_URL_PATTERNS.some((pattern) => pattern.test(url))) return true;
  return false;
}

function computeAliasSupport(text, aliases = []) {
  const raw = String(text || '');
  const matchedAliases = dedupeStrings((aliases || []).filter((alias) => exactPhraseHit(raw, alias)));
  return {
    supported: matchedAliases.length > 0,
    matchedAliases,
  };
}

function exactPhraseHit(text, alias) {
  const cleanText = String(text || '').trim();
  const cleanAlias = String(alias || '').trim();
  if (!cleanText || !cleanAlias) return false;
  const pattern = escapeRegex(cleanAlias).replace(/\s+/g, '\\s+');
  const regex = new RegExp(`(^|[^A-Za-z0-9])${pattern}([^A-Za-z0-9]|$)`, 'i');
  return regex.test(cleanText);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSignificantTokens(text) {
  return Array.from(new Set(
    String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/[^\s]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token))
  ));
}

function getUrlTokens(urlValue) {
  try {
    const parsed = new URL(String(urlValue || ''));
    return getSignificantTokens(decodeURIComponent(`${parsed.hostname} ${parsed.pathname}`));
  } catch {
    return getSignificantTokens(String(urlValue || ''));
  }
}

function intersectTokens(left = [], right = []) {
  const rightSet = new Set(right);
  return Array.from(new Set((left || []).filter((token) => rightSet.has(token))));
}

function dedupeStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function parseSimpleFrontmatter(raw) {
  const data = {};
  let currentKey = null;
  let currentSource = null;
  for (const line of String(raw || '').split(/\n+/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      let value = keyMatch[2].trim();
      currentKey = key;
      currentSource = null;
      if (value === '[]') {
        data[key] = [];
        continue;
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      data[key] = value;
      continue;
    }
    const listMatch = line.match(/^\s+-\s*(.*)$/);
    if (listMatch && currentKey) {
      const rawValue = listMatch[1].trim();
      if (currentKey === 'sources') {
        const titleMatch = rawValue.match(/^title:\s*(.*)$/);
        let title = titleMatch ? titleMatch[1].trim() : rawValue;
        if ((title.startsWith('"') && title.endsWith('"')) || (title.startsWith("'") && title.endsWith("'"))) title = title.slice(1, -1);
        const item = { title };
        data.sources = Array.isArray(data.sources) ? data.sources : [];
        data.sources.push(item);
        currentSource = item;
      } else {
        let value = rawValue;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        data[currentKey] = Array.isArray(data[currentKey]) ? data[currentKey] : [];
        data[currentKey].push(value);
      }
      continue;
    }
    const nestedMatch = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (nestedMatch && currentKey == 'sources' && currentSource) {
      let value = nestedMatch[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      currentSource[nestedMatch[1]] = value;
    }
  }
  return data;
}

function sanitizeCanonicalSources(rawSources = []) {
  const seen = new Set();
  const sources = [];
  for (const source of Array.isArray(rawSources) ? rawSources : []) {
    const title = String(source?.title || '').trim();
    const url = String(source?.canonical_url || source?.url || '').trim();
    const domain = String(source?.canonical_domain || source?.domain || '').trim();
    if (!title || !url) continue;
    const key = `${title.toLowerCase()}|${url.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title, url, domain: domain || null });
  }
  return sources;
}

function sameStringList(left = [], right = []) {
  const normalize = (values) => (Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean);
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSources(left = [], right = []) {
  const normalize = (items) => (Array.isArray(items) ? items : []).map((item) => ({
    title: String(item?.title || '').trim(),
    url: String(item?.url || '').trim(),
    domain: String(item?.domain || '').trim(),
  })).filter((item) => item.title || item.url);
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((item, index) => item.title === b[index].title && item.url === b[index].url && item.domain === b[index].domain);
}

function computePublishableEvidenceStats(sourcePack = {}) {
  const publishableSources = Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : [];
  const publishableUrlSet = new Set(publishableSources.map((source) => source?.canonical_url || source?.url).filter(Boolean));
  const publishableRoleResults = (Array.isArray(sourcePack.sourceRoleResults) ? sourcePack.sourceRoleResults : [])
    .filter((result) => publishableUrlSet.has(result?.source?.canonical_url || result?.source?.url));
  const directEventRoleResults = publishableRoleResults.filter((result) => {
    if (!result || !['core', 'supporting'].includes(result.role)) return false;
    return Number(result.same_event_score || 0) >= 3;
  });
  return {
    directEventSourceCount: Number(sourcePack.metrics?.directEventSourceCount || directEventRoleResults.length || 0),
    independentEventDomains: Number(
      sourcePack.metrics?.independentEventDomains
      || new Set(directEventRoleResults.map((result) => result?.source?.canonical_domain || result?.source?.domain).filter(Boolean)).size
      || 0
    ),
  };
}

function buildExpectedSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 60);
}

function normalizeArticleType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['report', 'analysis', 'explainer'].includes(normalized)) return normalized;
  if (normalized === 'breaking' || normalized === 'feature') return 'report';
  if (normalized === 'deep-dive') return 'analysis';
  return 'report';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const clean = String(value).trim();
    if (clean) return clean;
  }
  return null;
}
