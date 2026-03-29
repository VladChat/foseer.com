// File: qwen-scripts/article-drafter.js
// Purpose: Draft editorial article using layered writer system with honest quality reporting
// Stage 5: Produce readable editorial article with claim-backed content
// Quality discipline: strong/degraded/failed states explicitly reported

import { openAIComplete } from './utils/api-clients.js';
import { assembleFinalPrompt, getPromptAssemblySummary } from './writers/prompt-assembler.js';
import { classifyStory, selectWriter } from './writers/writer-selector.js';
import { resolvePlacementMetadata } from '../qwen-project-governance/shared/article-placement.js';
import { pickArticleTags } from './tag-picker.js';

/**
 * Draft quality states
 */
const DRAFT_QUALITY = {
  STRONG: 'strong',       // Ready for publication flow
  DEGRADED: 'degraded',   // Can use with caution, manual review recommended
  FAILED: 'failed',       // Not safe for publication
};

/**
 * Article draft schema with quality metadata
 * @typedef {Object} ArticleDraft
 * @property {string} eventId - Associated event ID
 * @property {string} title - Article title
 * @property {string} excerpt - Article excerpt (1-2 sentences)
 * @property {string} content - Full article markdown content
 * @property {number} wordCount - Word count
 * @property {string[]} sources - Source URLs cited
 * @property {string} authorName - Author name
 * @property {string|null} authorTitle - Author title or department label
 * @property {string} articleType - report | analysis | explainer
 * @property {string} quality - strong | degraded | failed
 * @property {boolean} safeForPublishing - Whether safe for publication flow
 * @property {string[]} qualityIssues - List of quality issues
 * @property {boolean} isFallback - Whether this is a fallback draft
 * @property {string|null} fallbackReason - Why fallback was used
 * @property {boolean} forecastIncluded - Whether forecast block was included
 * @property {Object} metadata - Draft metadata
 */

/**
 * Draft quality thresholds
 */
const DRAFT_THRESHOLDS = {
  strong: {
    minWordCount: 600,
    minSources: 2,
    maxFallbackDepth: 0,  // No fallback characteristics
  },
  degraded: {
    minWordCount: 300,
    minSources: 1,
    maxFallbackDepth: 1,  // Some fallback characteristics acceptable
  },
};


function toDeskLabel(label) {
  const value = String(label || '').trim();
  if (!value) {
    return null;
  }

  const deskMap = {
    'Staff Reporter': 'News Desk',
    'Explainer Editor': 'Explainers Desk',
    'Senior Analyst': 'Analysis Desk',
    'Features Writer': 'Features Desk',
  };

  return deskMap[value] || value;
}

/**
 * Draft article from claim map and source pack using layered writer system
 * @param {Object} eventBrief - Event brief
 * @param {Object} sourcePack - Source pack
 * @param {Object} claimMap - Claim map
 * @param {string} openAiApiKey - OpenAI API key
 * @returns {Promise<ArticleDraft>} Article draft with quality metadata
 */
export async function draftArticle(eventBrief, sourcePack, claimMap, openAiApiKey) {
  console.log(`[drafter] Drafting article: ${eventBrief.title}`);

  // Step 1: Classify the story (taxonomy-aware)
  const rawClassification = classifyStory(eventBrief, claimMap, sourcePack);
  const resolvedPlacement = resolvePlacementMetadata({
    title: eventBrief.title,
    excerpt: eventBrief.summary || eventBrief.whyItMatters,
    content: `${eventBrief.whatHappened || ''} ${eventBrief.whyItMatters || ''}`,
    section: rawClassification.section,
    subsection: rawClassification.subsection,
    section_id: rawClassification.section_id || sourcePack.section_id || eventBrief.section_id,
    topic_id: rawClassification.topic_id || sourcePack.topic_id || eventBrief.topic_id,
    article_type: rawClassification.articleType,
    tags: rawClassification.tags || [],
    topics: [rawClassification.topicLabel, rawClassification.topic_id].filter(Boolean),
    sources: sourcePack.publishReadySources || sourcePack.sources || [],
    classification: rawClassification,
  });
  const classification = {
    ...rawClassification,
    section: resolvedPlacement.section || rawClassification.section,
    section_id: resolvedPlacement.section_id || rawClassification.section_id || null,
    subsection: resolvedPlacement.subsection || rawClassification.subsection || null,
    topic_id: resolvedPlacement.topic_id || rawClassification.topic_id || null,
    topicLabel: resolvedPlacement.primaryTopic || rawClassification.topicLabel || null,
    classificationWarnings: rawClassification.classificationWarnings || [],
    classificationReasons: rawClassification.classificationReasons || [],
  };
  const tagSelection = pickArticleTags({
    brief: eventBrief,
    sourcePack,
    draft: {
      title: eventBrief.title,
      excerpt: eventBrief.summary || eventBrief.whyItMatters || '',
      content: `${eventBrief.whatHappened || ''} ${eventBrief.whyItMatters || ''}`.trim(),
      section_id: classification.section_id,
      topic_id: classification.topic_id,
      article_type: classification.articleType,
      articleType: classification.articleType,
    },
    placement: resolvedPlacement,
  });
  classification.tags = tagSelection.tags;
  console.log(`[drafter] Story classification: ${classification.articleType} / ${classification.section} / ${classification.primaryBeat}`);
  console.log(`[drafter] Canonical tags: ${tagSelection.tags.join(', ')}`);

  // Step 2: Select best writer based on fit + rotation
  const writerSelection = selectWriter(classification, {
    considerRotation: true,
    allowCrossBeat: true,
  });
  console.log(`[drafter] Selected department: ${writerSelection.selectedWriter?.name || 'Unassigned'} / author: ${writerSelection.selectedAuthor?.name || 'none'} (fit: ${writerSelection.fitScore}/10)`);

  // Step 3: Determine forecast inclusion (stable rule: include except on failed claim maps)
  const includeForecast = shouldIncludeForecastForArticle(claimMap, sourcePack);
  const forecastVariant = resolveForecastVariant(classification);
  console.log(`[drafter] Forecast inclusion: ${includeForecast ? 'Yes' : 'No'} (variant: ${forecastVariant})`);

  // Step 4: Assemble final prompt from layers (no giant dump)
  const finalPrompt = assembleFinalPrompt({
    eventBrief,
    claimMap,
    sourcePack,
    articleType: classification.articleType,
    writerId: writerSelection.selectedWriter?.id,
    authorProfile: writerSelection.selectedAuthor,
    includeForecast,
    forecastVariant,
    forecastConfidence: claimMap?.avgConfidence >= 7 ? 'high' : claimMap?.avgConfidence >= 5 ? 'medium' : 'low',
  });

  // Log assembly summary only (no giant prompt dump)
  const assemblySummary = getPromptAssemblySummary({
    articleType: classification.articleType,
    writerId: writerSelection.selectedWriter?.id,
    authorProfile: writerSelection.selectedAuthor,
    includeForecast,
    forecastVariant,
  });
  console.log(`[drafter] Prompt assembled: ${assemblySummary.layers_count} layers`);
  console.log(`[drafter] Prompt size: ${finalPrompt.length} chars`);

  try {
    const writerModel = process.env.OPENAI_WRITER_MODEL || 'gpt-5.1';
    const response = await openAIComplete(finalPrompt, openAiApiKey, {
      model: writerModel,
      maxTokens: 4500,
      temperature: 0.6,
      systemPrompt: 'You are an experienced journalist. Write concrete, specific, evidence-based articles with clean JSON output only. Avoid vague filler and keep one coherent story spine.',
      logLabel: 'article_drafting',
    });

    // Check for API errors
    if (response.status !== 'called_success' || !response.data) {
      console.log(`[drafter] OpenAI API call failed: ${response.error}`);
      return createFailedDraft(eventBrief, sourcePack, classification, writerSelection, `OpenAI API error: ${response.error}`);
    }

    const content = response.data.choices[0].message.content;
    const parsed = extractJsonFromResponseRobust(content);

    if (!parsed) {
      console.log('[drafter] Failed to extract JSON from response');
      return createFailedDraft(eventBrief, sourcePack, classification, writerSelection, 'Failed to parse article JSON');
    }

    // Clean the content
    let articleContent = cleanArticleContent(parsed.content || '');

    // Calculate word count
    const wordCount = articleContent.split(/\s+/).filter(w => w.length > 0).length;

    // Extract cited sources from claim map
    const citedSources = extractCitedSources(claimMap);

    // Assess draft quality
    const qualityResult = assessDraftQuality(
      articleContent,
      wordCount,
      citedSources,
      classification.articleType,
      claimMap
    );

    const draft = {
      eventId: eventBrief.id,
      title: parsed.title || eventBrief.title,
      excerpt: parsed.excerpt || buildExcerpt(articleContent),
      content: articleContent,
      wordCount,
      sources: citedSources,
      authorName: writerSelection.selectedAuthor?.name || writerSelection.selectedWriter?.name || 'Unassigned',
      authorTitle: toDeskLabel(writerSelection.selectedAuthor?.bio || writerSelection.selectedWriter?.department || writerSelection.selectedWriter?.name || null),
      articleType: normalizeArticleType(parsed.articleType) || classification.articleType,
      article_type: normalizeArticleType(parsed.articleType) || classification.articleType,
      section: classification.section,
      section_id: classification.section_id || eventBrief.section_id || null,
      subsection: classification.subsection || null,
      topic_id: classification.topic_id || eventBrief.topic_id || null,
      tags: tagSelection.tags,
      tag_slugs: tagSelection.tag_slugs,
      quality: qualityResult.quality,
      safeForPublishing: qualityResult.safeForPublishing,
      qualityIssues: qualityResult.issues,
      isFallback: false,
      fallbackReason: null,
      forecastIncluded: includeForecast,
      draftedAt: new Date().toISOString(),
      metadata: {
        writerId: writerSelection.selectedWriter?.id,
        writerDepartment: writerSelection.selectedWriter?.name || null,
        authorId: writerSelection.selectedAuthor?.id || null,
        authorName: writerSelection.selectedAuthor?.name || null,
        authorTitle: toDeskLabel(writerSelection.selectedAuthor?.bio || writerSelection.selectedWriter?.department || writerSelection.selectedWriter?.name || null),
        classification,
        tagging: tagSelection,
        writerPackage: {
          writerId: writerSelection.selectedWriter?.id || null,
          authorId: writerSelection.selectedAuthor?.id || null,
          authorName: writerSelection.selectedAuthor?.name || null,
          authorTitle: toDeskLabel(writerSelection.selectedAuthor?.bio || writerSelection.selectedWriter?.department || writerSelection.selectedWriter?.name || null),
          fitScore: writerSelection.fitScore,
          finalScore: writerSelection.finalScore,
          reasoning: writerSelection.reasoning,
        },
        assemblySummary,
        claimMapQuality: claimMap?.quality || 'unknown',
        evidenceStrength: claimMap?.claimsByStrength || {},
        forecastVariant,
        writerModel: process.env.OPENAI_WRITER_MODEL || 'gpt-5.1',
      },
    };

    logDraftSummary(draft);
    return draft;

  } catch (error) {
    console.error(`[drafter] Drafting failed: ${error.message}`);
    
    // Create DEGRADED fallback (not fake success)
    return createDegradedFallbackDraft(eventBrief, sourcePack, classification, writerSelection, error.message);
  }
}

/**
 * Determine if forecast should be included based on evidence safety only.
 * Stable rule: include the ending block for all publishable stories except failed claim maps.
 */
function shouldIncludeForecastForArticle(claimMap, sourcePack) {
  const avgConfidence = Number(claimMap?.avgConfidence || 0);
  const totalClaims = Number(claimMap?.totalClaims || 0);
  const supportedClaims = Number(claimMap?.supportedClaims || 0);
  const uniqueDomains = Number(sourcePack?.uniqueDomains || 0);

  if (claimMap?.quality === 'failed') return false;
  if (avgConfidence < 6) return false;
  if (totalClaims < 3) return false;
  if (supportedClaims < 2) return false;
  if (uniqueDomains < 2) return false;

  return true;
}

/**
 * Resolve forecast variant from stable classification metadata.
 */
function resolveForecastVariant(classification) {
  if (classification?.isBreaking) {
    return 'breaking-watch';
  }

  if (classification?.articleType === 'analysis') {
    return classification?.depthMode === 'deep' ? 'analysis-deep' : 'analysis';
  }

  if (classification?.articleType === 'explainer') {
    return 'explainer-watch';
  }

  return 'report-watch';
}

function normalizeArticleType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['report', 'analysis', 'explainer'].includes(normalized)) return normalized;
  if (normalized === 'breaking' || normalized === 'feature') return 'report';
  if (normalized === 'deep-dive') return 'analysis';
  return null;
}

/**
 * Extract cited sources from claim map
 */
function extractCitedSources(claimMap) {
  if (!claimMap || !claimMap.claims) {
    return [];
  }
  
  return [...new Set(
    claimMap.claims
      .flatMap(c => c.supportingSources || [])
      .filter(Boolean)
  )];
}

/**
 * Assess draft quality based on content, word count, sources, and evidence
 */
function assessDraftQuality(content, wordCount, sources, articleType, claimMap) {
  const issues = [];
  const fatalIssues = [];

  // Check word count
  if (wordCount < DRAFT_THRESHOLDS.strong.minWordCount) {
    if (wordCount < DRAFT_THRESHOLDS.degraded.minWordCount) {
      const issue = `Word count too low: ${wordCount} < ${DRAFT_THRESHOLDS.degraded.minWordCount}`;
      issues.push(issue);
      fatalIssues.push(issue);
    } else {
      issues.push(`Word count below target: ${wordCount} < ${DRAFT_THRESHOLDS.strong.minWordCount}`);
    }
  }

  // Check source citations
  if (sources.length < DRAFT_THRESHOLDS.strong.minSources) {
    if (sources.length < DRAFT_THRESHOLDS.degraded.minSources) {
      const issue = `Too few sources cited: ${sources.length} < ${DRAFT_THRESHOLDS.degraded.minSources}`;
      issues.push(issue);
      fatalIssues.push(issue);
    } else {
      issues.push(`Limited source citations: ${sources.length} < ${DRAFT_THRESHOLDS.strong.minSources}`);
    }
  }

  // Check content quality markers (advisory only unless the draft is truly too thin)
  const hasSubstance = content.length > 500 && content.includes('\n\n');
  if (!hasSubstance) {
    issues.push('Content lacks substance or structure');
  }

  // Check for AI-sounding phrases (advisory only after normalization)
  const aiPhrases = ['in summary', 'in conclusion', 'it is important to note', 'according to available reporting'];
  const hasAiPhrases = aiPhrases.some(phrase => content.toLowerCase().includes(phrase));
  if (hasAiPhrases) {
    issues.push('Contains AI-sounding phrases');
  }

  // Check claim map alignment if available
  if (claimMap && claimMap.quality === 'degraded') {
    issues.push('Based on degraded claim map - evidence limitations apply');
  }
  if (claimMap && claimMap.quality === 'failed') {
    fatalIssues.push('Claim map failed');
  }

  // Determine quality state
  const isStrong = 
    wordCount >= DRAFT_THRESHOLDS.strong.minWordCount &&
    sources.length >= DRAFT_THRESHOLDS.strong.minSources &&
    hasSubstance &&
    !hasAiPhrases &&
    claimMap?.quality !== 'failed';

  const isDegraded =
    wordCount >= DRAFT_THRESHOLDS.degraded.minWordCount &&
    sources.length >= DRAFT_THRESHOLDS.degraded.minSources &&
    claimMap?.quality !== 'failed';

  const quality = isStrong ? DRAFT_QUALITY.STRONG : isDegraded ? DRAFT_QUALITY.DEGRADED : DRAFT_QUALITY.FAILED;

  return {
    quality,
    issues,
    fatalIssues,
    safeForPublishing: fatalIssues.length === 0 && quality !== DRAFT_QUALITY.FAILED,
  };
}

/**
 * Create a FAILED draft (not safe for publishing)
 */
function createFailedDraft(eventBrief, sourcePack, classification, writerSelection, errorReason) {
  console.log(`[drafter] Creating FAILED draft: ${errorReason}`);
  
  return {
    eventId: eventBrief.id,
    title: eventBrief.title,
    excerpt: 'Draft generation failed',
    content: '',
    wordCount: 0,
    sources: [],
    authorName: writerSelection?.selectedAuthor?.name || writerSelection?.selectedWriter?.name || 'Unknown',
    authorTitle: toDeskLabel(writerSelection?.selectedAuthor?.bio || writerSelection?.selectedWriter?.department || writerSelection?.selectedWriter?.name || null),
    articleType: classification?.articleType || 'report',
    article_type: classification?.articleType || 'report',
    section: classification?.section || 'News',
    section_id: classification?.section_id || null,
    subsection: classification?.subsection || null,
    topic_id: classification?.topic_id || null,
    tags: classification?.tags || [],
    tag_slugs: [],
    quality: DRAFT_QUALITY.FAILED,
    safeForPublishing: false,
    qualityIssues: [errorReason],
    isFallback: true,
    fallbackReason: errorReason,
    forecastIncluded: false,
    draftedAt: new Date().toISOString(),
    metadata: {
      writerId: writerSelection?.selectedWriter?.id,
      writerDepartment: writerSelection?.selectedWriter?.name || null,
      authorId: writerSelection?.selectedAuthor?.id || null,
      authorName: writerSelection?.selectedAuthor?.name || null,
      authorTitle: toDeskLabel(writerSelection?.selectedAuthor?.bio || writerSelection?.selectedWriter?.department || writerSelection?.selectedWriter?.name || null),
      classification,
      tagging: { tags: classification?.tags || [], tag_slugs: [], primary_topic_tag: null, primary_topic_slug: null, selected: [], warnings: ['Failed draft'], diagnostics: { section_id: classification?.section_id || null, topic_id: classification?.topic_id || null, article_type: classification?.articleType || null, source_entity_count: 0, source_title_count: 0 } },
      error: errorReason,
    },
  };
}

/**
 * Create a DEGRADED fallback draft (clearly marked, not fake success)
 */
function createDegradedFallbackDraft(eventBrief, sourcePack, classification, writerSelection, errorReason) {
  console.log(`[drafter] Creating DEGRADED fallback draft: ${errorReason}`);

  const fallbackContent = buildFallbackContent(eventBrief, sourcePack);
  const wordCount = fallbackContent.split(/\s+/).filter(w => w.length > 0).length;
  const sources = sourcePack?.sources?.slice(0, 2).map(s => s.url) || [];

  return {
    eventId: eventBrief.id,
    title: eventBrief.title,
    excerpt: buildExcerpt(fallbackContent),
    content: fallbackContent,
    wordCount,
    sources,
    authorName: 'Qwen Editorial (Fallback)',
    authorTitle: null,
    articleType: classification?.articleType || 'report',
    article_type: classification?.articleType || 'report',
    section: classification?.section || 'News',
    section_id: classification?.section_id || null,
    subsection: classification?.subsection || null,
    topic_id: classification?.topic_id || null,
    tags: classification?.tags || [],
    tag_slugs: [],
    quality: DRAFT_QUALITY.DEGRADED,
    safeForPublishing: false,  // NOT safe for normal publishing
    qualityIssues: [
      `Draft generation failed: ${errorReason}`,
      'Fallback content generated from event brief',
      'Manual review required before publication',
      'Limited evidence basis',
    ],
    isFallback: true,
    fallbackReason: errorReason,
    forecastIncluded: false,
    draftedAt: new Date().toISOString(),
    metadata: {
      writerId: writerSelection?.selectedWriter?.id,
      writerDepartment: writerSelection?.selectedWriter?.name || null,
      authorId: writerSelection?.selectedAuthor?.id || null,
      authorName: writerSelection?.selectedAuthor?.name || null,
      authorTitle: toDeskLabel(writerSelection?.selectedAuthor?.bio || writerSelection?.selectedWriter?.department || writerSelection?.selectedWriter?.name || null),
      classification,
      tagging: { tags: classification?.tags || [], tag_slugs: [], primary_topic_tag: null, primary_topic_slug: null, selected: [], warnings: ['Fallback draft'], diagnostics: { section_id: classification?.section_id || null, topic_id: classification?.topic_id || null, article_type: classification?.articleType || null, source_entity_count: 0, source_title_count: 0 } },
      isFallback: true,
      fallbackReason: errorReason,
    },
  };
}

/**
 * Build fallback content from event brief
 */
function buildFallbackContent(eventBrief, sourcePack) {
  const paragraphs = [];
  
  if (eventBrief.whatHappened) {
    paragraphs.push(eventBrief.whatHappened);
  }
  
  if (eventBrief.whyItMatters) {
    paragraphs.push(`This development matters because ${eventBrief.whyItMatters}.`);
  }
  
  const involved = eventBrief.whoIsInvolved || eventBrief.involvedParties?.join(', ');
  if (involved) {
    paragraphs.push(`The parties involved include ${involved}.`);
  }
  
  if (sourcePack?.sources?.length > 0) {
    const sourceDomains = sourcePack.sources.slice(0, 3).map(s => s.domain).filter(Boolean).join(', ');
    if (sourceDomains) {
      paragraphs.push(`Reporting on this development comes from sources including ${sourceDomains}.`);
    }
  }
  
  paragraphs.push('More details will be added as the story develops and additional evidence becomes available.');
  
  return paragraphs.join('\n\n');
}

/**
 * Harden article draft - remove unsupported claims using claim-map evidence truth
 * @param {ArticleDraft} draft - Article draft
 * @param {Object} claimMap - Claim map for reference
 * @returns {ArticleDraft} Hardened draft with quality metadata preserved
 */
export function hardenDraft(draft, claimMap) {
  let content = draft.content;

  // Remove debug markers
  content = content.replace(/\[claim-\d+\]/g, '');
  content = content.replace(/\[\^\d+\]/g, '');
  content = content.replace(/^\[\^\d+\]:.*$/gm, '');

  // Remove internal notes
  content = content.replace(/\[TODO.*?\]/gi, '');
  content = content.replace(/\[NOTE.*?\]/gi, '');
  content = content.replace(/\[CHECK.*?\]/gi, '');

  // Remove duplicated leading byline in content body
  content = stripLeadingByline(content);

  // Normalize whitespace
  content = content.replace(/\n{3,}/g, '\n\n');
  content = content.trim();

  const trimResult = softlyTrimWeakParagraphs(content, claimMap, draft);
  content = trimResult.content;
  if (trimResult.removedParagraphs > 0) {
    draft.qualityIssues.push(`Soft-trimmed ${trimResult.removedParagraphs} weak paragraph${trimResult.removedParagraphs === 1 ? '' : 's'} to keep the story aligned with the claim map`);
  }

  // Evidence-based hardening: check for unsupported claims if claim map available
  if (claimMap && claimMap.claims) {
    const unsupportedClaims = claimMap.claims.filter(c => c.status === 'unsupported');
    
    // Log warning if draft may contain unsupported material
    if (unsupportedClaims.length > 0 && draft.quality === DRAFT_QUALITY.STRONG) {
      draft.quality = DRAFT_QUALITY.DEGRADED;
      draft.qualityIssues.push('Claim map contains unsupported claims - review draft for alignment');
    }
  }

  return {
    ...draft,
    content,
    wordCount: content.split(/\s+/).filter(w => w.length > 0).length,
    hardenedAt: new Date().toISOString(),
  };
}


function softlyTrimWeakParagraphs(content, claimMap, draft) {
  if (!content || !claimMap?.claims?.length) {
    return { content, removedParagraphs: 0 };
  }

  const anchorTerms = deriveClaimAnchorTerms(claimMap);
  if (anchorTerms.size === 0) {
    return { content, removedParagraphs: 0 };
  }

  const weakEvidence = (claimMap?.avgConfidence || 0) < 7 || (draft?.sources?.length || 0) <= 2 || claimMap?.claims?.length <= 2;
  const maxRemovals = weakEvidence ? 2 : 1;
  let removedParagraphs = 0;
  let bodyParagraphIndex = 0;

  const blocks = String(content)
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean);

  const kept = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const isHeading = /^#{1,6}\s+/.test(block);
    if (isHeading) {
      kept.push(block);
      continue;
    }

    const previousHeading = findNearestHeading(blocks, i);
    if (bodyParagraphIndex < 2) {
      kept.push(block);
      bodyParagraphIndex += 1;
      continue;
    }

    const shouldTrim = removedParagraphs < maxRemovals && isLikelyWeakParagraph(block, previousHeading, anchorTerms, weakEvidence);
    if (shouldTrim) {
      removedParagraphs += 1;
      continue;
    }

    kept.push(block);
    bodyParagraphIndex += 1;
  }

  return {
    content: kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    removedParagraphs,
  };
}

function deriveClaimAnchorTerms(claimMap) {
  const tokens = new Set();
  const raw = [];
  for (const claim of claimMap?.claims || []) {
    raw.push(claim.claimText || '');
    raw.push(claim.evidenceExcerpt || '');
    for (const source of claim.supportingSources || []) {
      raw.push(source || '');
    }
  }

  for (const value of raw) {
    for (const token of String(value || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 4 && !CLAIM_TRIM_STOPWORDS.has(token)) {
        tokens.add(token);
      }
    }
  }

  return tokens;
}

function findNearestHeading(blocks, currentIndex) {
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    if (/^#{1,6}\s+/.test(blocks[i])) {
      return blocks[i].replace(/^#{1,6}\s+/, '').trim();
    }
  }
  return '';
}

function isLikelyWeakParagraph(paragraph, heading, anchorTerms, weakEvidence) {
  const text = String(paragraph || '').trim();
  if (!text) return false;
  if (text.length < 180) return false;
  if (/^[-*]\s+/.test(text)) return false;
  if (/^>/.test(text)) return false;

  const lower = text.toLowerCase();
  const headingLower = String(heading || '').toLowerCase();
  if (/repeated use of words like|the language used in coverage|word choice suggests/.test(lower)) {
    return true;
  }
  const anchorOverlap = countAnchorOverlap(lower, anchorTerms);
  const driftSignal = DRIFT_PHRASES.some(phrase => lower.includes(phrase)) || DRIFT_HEADINGS.some(marker => headingLower.includes(marker));

  if (!driftSignal) {
    return false;
  }

  if (anchorOverlap >= (weakEvidence ? 2 : 1)) {
    return false;
  }

  return true;
}

function countAnchorOverlap(lowerText, anchorTerms) {
  let overlap = 0;
  for (const term of anchorTerms) {
    if (lowerText.includes(term)) {
      overlap += 1;
      if (overlap >= 3) {
        return overlap;
      }
    }
  }
  return overlap;
}

const CLAIM_TRIM_STOPWORDS = new Set([
  'about', 'across', 'after', 'amid', 'analysis', 'article', 'available', 'because', 'before', 'being', 'between',
  'could', 'coverage', 'development', 'during', 'first', 'group', 'include', 'including', 'latest', 'matter',
  'might', 'other', 'report', 'reported', 'reporting', 'reports', 'story', 'there', 'their', 'these', 'those',
  'under', 'using', 'while', 'would'
]);

const DRIFT_HEADINGS = [
  'what to watch',
  'the bigger picture',
  'broader',
  'where this could lead',
  'what it signals',
  'why this matters more broadly',
  'big picture',
];

const DRIFT_PHRASES = [
  'more broadly',
  'beyond this case',
  'in the bigger picture',
  'this also reflects',
  'raises broader questions',
  'signals a wider shift',
  'could reshape',
  'may reshape',
  'it is a reminder that',
  'taken together',
  'at a broader level',
  'more generally',
  'in a wider sense',
  'repeated use of words like',
  'the repeated use of',
  'the language used in coverage',
  'word choice suggests',
  'from a diplomatic standpoint',
  'from an economic standpoint',
  'held abroad',
  'host countries',
];

/**
 * Log draft summary
 */
function logDraftSummary(draft) {
  console.log(`[drafter] Drafted ${draft.wordCount} words, ${draft.sources.length} sources cited`);
  console.log(`[drafter] Type: ${draft.articleType}, Writer: ${draft.authorTitle ? `${draft.authorName}, ${draft.authorTitle}` : draft.authorName}`);
  console.log(`[drafter] Quality: ${draft.quality}, Safe for publishing: ${draft.safeForPublishing}`);
  
  if (draft.forecastIncluded) {
    console.log(`[drafter] Forecast: Included`);
  }
  
  if (draft.qualityIssues.length > 0) {
    console.log(`[drafter] Quality issues: ${draft.qualityIssues.join('; ')}`);
  }
  
  if (draft.isFallback) {
    console.log(`[drafter] FALLBACK: ${draft.fallbackReason}`);
  }
}

// Helpers

function cleanArticleContent(content) {
  let cleaned = content;

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');


  // Remove footnotes
  cleaned = cleaned.replace(/\[\^\d+\]/g, '');
  cleaned = cleaned.replace(/^\[\^\d+\]:.*$/gm, '');

  // Remove URL-only lines
  cleaned = cleaned.replace(/^\s*https?:\/\/.*$/gm, '');

  // Remove duplicated leading byline in content body
  cleaned = stripLeadingByline(cleaned);

  // Normalize whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}


function stripLeadingByline(content) {
  if (!content) return content;

  let stripped = content.trimStart();

  stripped = stripped.replace(
    /^(?:\*|_)?\s*By\s+[^\n]{3,140}?(?:\*|_)?\s*(?:\r?\n){1,2}/i,
    ''
  );

  stripped = stripped.replace(
    /^(?:\*|_)?\s*Author:\s*[^\n]{3,160}?(?:\*|_)?\s*(?:\r?\n){1,2}/i,
    ''
  );

  return stripped.trimStart();
}

function buildExcerpt(content) {
  const firstParagraph = content.split('\n\n')[0] || '';
  const plain = firstParagraph.replace(/[*_`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

  if (plain.length <= 160) {
    return plain;
  }

  const truncated = plain.substring(0, 157);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

/**
 * Robust JSON extraction from response
 * More resilient than basic substring approach
 */
function extractJsonFromResponseRobust(content) {
  if (!content) return null;
  
  let clean = content.replace(/```json/g, '').replace(/```/g, '').trim();
  
  // Try to find JSON object
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  
  if (start === -1 || end === -1 || start >= end) {
    console.log('[drafter] No JSON object found in response');
    return null;
  }
  
  const jsonStr = clean.substring(start, end + 1);
  
  try {
    return JSON.parse(jsonStr);
  } catch (parseError) {
    console.log(`[drafter] JSON parse failed: ${parseError.message}`);
    
    // Try to extract key fields even if JSON is malformed
    const extracted = {};
    
    const titleMatch = jsonStr.match(/"title"\s*:\s*"([^"]+)"/);
    if (titleMatch) extracted.title = titleMatch[1];
    
    const excerptMatch = jsonStr.match(/"excerpt"\s*:\s*"([^"]+)"/);
    if (excerptMatch) extracted.excerpt = excerptMatch[1];
    
    const contentMatch = jsonStr.match(/"content"\s*:\s*"([\s\S]*?)"/);
    if (contentMatch) {
      extracted.content = contentMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    
    const typeMatch = jsonStr.match(/"articleType"\s*:\s*"([^"]+)"/);
    if (typeMatch) extracted.articleType = typeMatch[1];
    
    // Return extracted fields if we got at least content
    if (extracted.content) {
      return extracted;
    }
    
    return null;
  }
}

// Export constants for external use
export { DRAFT_QUALITY };
