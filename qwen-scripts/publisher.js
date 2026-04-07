// File: qwen-scripts/publisher.js
// Purpose: Publish article draft to src/data/post/ with proper validation, atomic writes, and complete metadata
// Writes article with frontmatter to the correct location for Astro to pick up

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

import { resolvePlacementMetadata } from '../qwen-project-governance/shared/article-placement.js';
import { resolveCanonicalTagFrame } from './tag-picker.js';
import { validateTagSelection } from './validate-tags.js';

const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src/data/post');
const INVENTORY_PATH = path.resolve(PROJECT_ROOT, 'qwen-project-governance/article_inventory.md');
const FALLBACK_IMAGE_PATH = '~/assets/images/posts/fallback/foseer-default-cover.svg';
const FALLBACK_IMAGE_FILE = path.resolve(PROJECT_ROOT, 'src/assets/images/posts/fallback/foseer-default-cover.svg');
const INVENTORY_HEADER = '| Article ID | Topic ID | Title | Created | Last Updated | Status | Section | Article Type | Primary Topic | Key Entities | Search Keywords | Canonical URL |';
const INVENTORY_SEPARATOR = '|------------|----------|-------|---------|--------------|--------|---------|--------------|---------------|--------------|-----------------|---------------|';
const RELATED_LINK_MIN_SCORE = 3.5;
const MAX_RELATED_LINKS = 3;

/**
 * Required fields for publishing
 */
const REQUIRED_FIELDS = ['title', 'slug', 'article_type', 'excerpt', 'image', 'section_id', 'topic_id'];

/**
 * Publish article to src/data/post/
 * @param {Object} article - Complete article with draft, image, slug, and placement data
 * @param {Object} article.draft - Article draft with title, content, excerpt, article_type, authorName
 * @param {string} article.articleSlug - URL-safe slug for the article
 * @param {Object} article.image - Image data with imagePath and altText
 * @param {Object} [article.placement] - Optional placement data (section, subsection, tags, topics)
 * @returns {Object} Publish result with metadata
 */
export function publishArticle(article) {
  console.log('[publisher] Publishing article...');

  // Ensure every published article has a valid image package.
  article = ensurePublishImage(article);

  // Validate required fields before any write operation
  const validation = validateRequiredFields(article);
  if (!validation.valid) {
    console.error('[publisher] Validation failed:', validation.missingFields.join(', '));
    return {
      success: false,
      error: `Missing required fields: ${validation.missingFields.join(', ')}`,
      missingFields: validation.missingFields,
    };
  }

  // Generate filename with date prefix and prevent silent overwrite of an existing article file
  const publishMeta = resolvePublishTarget(article);
  const { today, slug, filename, filePath, canonicalSlug, expectedUrl, collisionResolved } = publishMeta;
  const publishableSources = resolvePublishableSources(article);

  // Duplicate check was moved to pre-draft gate (pre-draft-gate.js).
  // Publisher is a near-dumb writer/finalizer — it only logs duplicate warnings, never blocks.
  const duplicateAssessment = assessDuplicatePublication(article, publishMeta, publishableSources);
  if (duplicateAssessment?.isDuplicate) {
    console.warn(`[publisher] DUPLICATE WARNING: ${duplicateAssessment.reason} — publishing anyway (pre-draft gate should have caught this)`);
  }

  const relatedLinks = buildRelatedCoverageLinks(article, expectedUrl);

  // Build frontmatter with full placement data
  const frontmatter = buildFrontmatter(article, expectedUrl, publishableSources);

  // Build full content
  const contentBody = appendRelatedCoverageSection(article.draft.content, relatedLinks);
  const content = `${frontmatter}

${contentBody}`;

  // Ensure directory exists
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const existingContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  if (existingContent === content) {
    const existingStats = fs.statSync(filePath);
    console.log(`[publisher] Idempotent publish reuse: ${filename}`);
    const publishedAt = existingStats.mtime.toISOString();
    const inventoryUpdate = updateInventoryBestEffort(article, {
      filename,
      expectedUrl,
      canonicalSlug,
      publishedAt,
    });
    if (inventoryUpdate.updated) {
      console.log(`[publisher] Inventory updated: ${inventoryUpdate.action}`);
    }
    return {
      success: true,
      filename,
      filePath,
      canonicalSlug,
      expectedUrl,
      slug: article.articleSlug,
      publishedAt,
      relatedLinksCount: relatedLinks.length,
      collisionResolved,
      idempotentReuse: true,
      placement: {
        section: getResolvedPlacement(article).section,
        section_id: getResolvedPlacement(article).section_id,
        topic_id: getResolvedPlacement(article).topic_id,
        subsection: getResolvedPlacement(article).subsection,
        article_type: getResolvedPlacement(article).article_type,
      },
    };
  }

  // Atomic write: write to temp file first, then rename
  const tempFilePath = `${filePath}.tmp.${process.pid}`;

  try {
    // Write to temporary file
    fs.writeFileSync(tempFilePath, content, 'utf-8');

    // Verify the temp file was written correctly
    const writtenContent = fs.readFileSync(tempFilePath, 'utf-8');
    if (writtenContent !== content) {
      throw new Error('File content verification failed');
    }

    // Atomic rename (on most filesystems this is atomic)
    fs.renameSync(tempFilePath, filePath);

    console.log(`[publisher] Published: ${filename}`);
    if (collisionResolved) {
      console.log(`[publisher] Slug collision resolved, canonical slug: ${canonicalSlug}`);
    }
    console.log(`[publisher] Path: ${filePath}`);
    if (relatedLinks.length > 0) {
      console.log(`[publisher] Related coverage links: ${relatedLinks.length}`);
    }

    const publishedAt = new Date().toISOString();
    const inventoryUpdate = updateInventoryBestEffort(article, {
      filename,
      expectedUrl,
      canonicalSlug,
      publishedAt,
    });
    if (inventoryUpdate.updated) {
      console.log(`[publisher] Inventory updated: ${inventoryUpdate.action}`);
    } else if (inventoryUpdate.reason) {
      console.log(`[publisher] Inventory skipped: ${inventoryUpdate.reason}`);
    }

    return {
      success: true,
      filename,
      filePath,
      canonicalSlug,
      expectedUrl,
      slug: article.articleSlug,
      publishedAt,
      relatedLinksCount: relatedLinks.length,
      collisionResolved,
      placement: {
        section: getResolvedPlacement(article).section,
        section_id: getResolvedPlacement(article).section_id,
        topic_id: getResolvedPlacement(article).topic_id,
        subsection: getResolvedPlacement(article).subsection,
        article_type: getResolvedPlacement(article).article_type,
      },
    };
  } catch (error) {
    console.error('[publisher] Atomic write failed:', error.message);

    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (cleanupError) {
      console.error('[publisher] Cleanup failed:', cleanupError.message);
    }

    return {
      success: false,
      error: `Atomic write failed: ${error.message}`,
    };
  }
}

function ensurePublishImage(article) {
  const currentImagePath = String(article?.image?.imagePath || '').trim();
  const hasUsableImage = hasUsableImagePath(currentImagePath);
  if (hasUsableImage) return article;

  if (!fs.existsSync(FALLBACK_IMAGE_FILE)) {
    console.warn('[publisher] Fallback image is missing on disk; article publish may fail');
    return article;
  }

  const fallbackAlt = `Illustration for ${String(article?.draft?.title || article?.brief?.title || 'this article').replace(/["']/g, '').trim()}`;
  console.warn(`[publisher] Image package missing or invalid; applying fallback image ${FALLBACK_IMAGE_PATH}`);

  return {
    ...article,
    image: {
      ...(article?.image || {}),
      provider: article?.image?.provider || 'fallback',
      imagePath: FALLBACK_IMAGE_PATH,
      altText: article?.image?.altText || article?.image?.imageAlt || fallbackAlt,
      imageAlt: article?.image?.imageAlt || article?.image?.altText || fallbackAlt,
      sourceUrl: article?.image?.sourceUrl || null,
      metadata: {
        ...(article?.image?.metadata || {}),
        fallbackAppliedByPublisher: true,
      },
    },
  };
}

function hasUsableImagePath(imagePath) {
  const normalized = String(imagePath || '').trim();
  if (!normalized) return false;
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('/')) return true;
  if (normalized.startsWith('~/')) {
    const relativePath = normalized.replace(/^~\//, '');
    const localPaths = [
      path.resolve(PROJECT_ROOT, relativePath),
      path.resolve(PROJECT_ROOT, 'src', relativePath),
    ];
    return localPaths.some((localPath) => fs.existsSync(localPath));
  }
  if (
    normalized.startsWith('src/')
    || normalized.startsWith('assets/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
  ) {
    return fs.existsSync(path.resolve(PROJECT_ROOT, normalized));
  }
  return true;
}

/**
 * Validate required publish fields
 * @param {Object} article - Article object
 * @returns {Object} Validation result
 */
function validateRequiredFields(article) {
  const missingFields = [];

  // Check draft exists
  if (!article.draft) {
    return { valid: false, missingFields: ['draft'] };
  }

  // Check title
  if (!article.draft.title || String(article.draft.title).trim() === '') {
    missingFields.push('title');
  }

  // Check slug
  if (!article.articleSlug || String(article.articleSlug).trim() === '') {
    missingFields.push('slug');
  }

  // Check article_type (support both camelCase and snake_case)
  const articleType = article.draft.article_type || article.draft.articleType;
  if (!articleType || String(articleType).trim() === '') {
    missingFields.push('article_type');
  }

  // Check excerpt
  if (!article.draft.excerpt || String(article.draft.excerpt).trim() === '') {
    missingFields.push('excerpt');
  }

  // Check image
  if (!article.image || !article.image.imagePath) {
    missingFields.push('image');
  }

  const placement = getResolvedPlacement(article);
  if (!placement.section_id) {
    missingFields.push('section_id');
  }
  if (!placement.topic_id) {
    missingFields.push('topic_id');
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Sanitize slug for filename use
 */
function sanitizeSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'untitled';
}

function resolvePublishTarget(article) {
  const today = new Date().toISOString().split('T')[0];
  const baseSlug = sanitizeSlug(article.articleSlug);
  let candidateSlug = baseSlug;
  let canonicalSlug = `${today}-${candidateSlug}`;
  let filename = `${canonicalSlug}.mdx`;
  let filePath = path.join(POSTS_DIR, filename);
  let collisionResolved = false;

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  const incomingSignature = buildPublishSignature(article);
  if (existing && buildContentSignature(existing) !== incomingSignature) {
    collisionResolved = true;
    const suffixSeeds = [article?.brief?.id, article?.brief?.cluster_id, article?.brief?.topic_id, Date.now().toString(36)];
    for (const seed of suffixSeeds) {
      const suffix = sanitizeSlug(String(seed || '').replace(/^tc-|^evt-|^brief-/i, '')).slice(0, 12);
      if (!suffix) continue;
      candidateSlug = `${baseSlug}-${suffix}`.slice(0, 72);
      canonicalSlug = `${today}-${candidateSlug}`;
      filename = `${canonicalSlug}.mdx`;
      filePath = path.join(POSTS_DIR, filename);
      if (!fs.existsSync(filePath)) break;
    }
  }

  return {
    today,
    slug: candidateSlug,
    filename,
    filePath,
    canonicalSlug,
    expectedUrl: `/article/${canonicalSlug}`,
    collisionResolved,
  };
}

function buildPublishSignature(article) {
  return JSON.stringify({
    title: String(article?.draft?.title || '').trim(),
    excerpt: String(article?.draft?.excerpt || '').trim(),
    section_id: String(getResolvedPlacement(article).section_id || '').trim(),
    topic_id: String(getResolvedPlacement(article).topic_id || '').trim(),
  });
}

function parseSimpleFrontmatter(raw) {
  const data = {};
  for (const rawLine of String(raw || '').split(/\n+/)) {
    const line = String(rawLine || '').replace(/\r$/, '');
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

function buildContentSignature(raw) {
  const frontmatterMatch = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return String(raw || '').trim();
  const frontmatter = parseSimpleFrontmatter(frontmatterMatch[1]);
  return JSON.stringify({
    title: String(frontmatter.title || '').trim(),
    excerpt: String(frontmatter.excerpt || '').trim(),
    section_id: String(frontmatter.section_id || '').trim(),
    topic_id: String(frontmatter.topic_id || '').trim(),
  });
}


function getResolvedPlacement(article) {
  const canonicalPlacement = article?.canonicalPublishPayload?.placement;
  if (canonicalPlacement) {
    return {
      section: canonicalPlacement.section || canonicalPlacement.section_label || 'News',
      subsection: canonicalPlacement.subsection || null,
      section_id: canonicalPlacement.section_id || null,
      topic_id: canonicalPlacement.topic_id || null,
      article_type: canonicalPlacement.article_type || 'report',
      topics: Array.isArray(canonicalPlacement.topics) ? canonicalPlacement.topics : [],
      tags: Array.isArray(article?.canonicalPublishPayload?.tagging?.tags) ? article.canonicalPublishPayload.tagging.tags : [],
    };
  }

  const draft = article?.draft || {};
  const placement = article?.placement || {};
  const classification = draft?.metadata?.classification || {};

  return resolvePlacementMetadata({
    title: draft.title || article?.brief?.title,
    excerpt: draft.excerpt || article?.brief?.summary,
    content: draft.content,
    section: placement.section || draft.section,
    subsection: placement.subsection || draft.subsection,
    section_id: placement.section_id || draft.section_id || article?.brief?.section_id,
    topic_id: placement.topic_id || draft.topic_id || article?.brief?.topic_id,
    article_type: draft.articleType || draft.article_type,
    tags: placement.tags || draft.tags || draft.metadata?.tagging?.tags,
    topics: placement.topics || draft.topics,
    classification,
    sources: article?.sourcePack?.sources || [],
  });
}

/**
 * Build frontmatter from article with full placement data
 */
function buildFrontmatter(article, expectedUrl = "", precomputedPublishableSources = null) {
  const draft = article.draft;
  const image = article.image;
  const placement = getResolvedPlacement(article);

  const section = placement.section || getCategory(draft.articleType);
  const subsection = placement.subsection || null;
  const canonicalPayload = article.canonicalPublishPayload || null;
  const tagSelection = canonicalPayload?.tagging || resolveCanonicalTagFrame({
    draft,
    brief: article.brief || {},
    sourcePack: article.sourcePack || {},
    placement,
  });
  const tagValidation = validateTagSelection(tagSelection);
  if (!tagValidation.valid) {
    console.log(`[publisher] Canonical tag validation issues: ${tagValidation.errors.join('; ')}`);
  }
  const tags = Array.isArray(tagSelection.tags) ? tagSelection.tags : [];
  const topics = Array.isArray(canonicalPayload?.placement?.topics) ? canonicalPayload.placement.topics : (Array.isArray(placement.topics) ? placement.topics : []);

  // Get sources from canonical publish payload if available, otherwise from sourcePack
  const sources = Array.isArray(precomputedPublishableSources)
    ? precomputedPublishableSources
    : resolvePublishableSources(article);
  const publishIdentityKey = resolvePublishIdentityKey(article);

  let fm = `---
publishDate: ${new Date().toISOString()}
title: "${escapeQuotes(draft.title)}"
excerpt: "${escapeQuotes(draft.excerpt)}"
author: "${draft.authorName || 'Qwen Editorial'}"
`;

  const authorTitle = draft.authorTitle || draft.metadata?.writerDepartment || '';
  if (authorTitle) {
    fm += `authorTitle: "${escapeQuotes(authorTitle)}"
`;
  }

  fm += `section: "${escapeQuotes(section)}"
article_type: "${mapToValidArticleType(placement.article_type || draft.articleType)}"
draft: false
`;

  if (placement.section_id) {
    fm += `section_id: "${escapeQuotes(placement.section_id)}"
`;
  }

  if (placement.topic_id) {
    fm += `topic_id: "${escapeQuotes(placement.topic_id)}"
`;
  }
  if (publishIdentityKey) {
    fm += `publish_identity_key: "${escapeQuotes(publishIdentityKey)}"
`;
  }

  // Add subsection if present (preserves granular taxonomy)
  if (subsection) {
    fm += `subsection: "${escapeQuotes(subsection)}"\n`;
  }

  // Add tags (preserves all tag data)
  fm += `tags:\n`;
  if (tags.length > 0) {
    for (const tag of tags) {
      fm += `  - "${escapeQuotes(tag)}"\n`;
    }
  } else {
    fm += `  []\n`;
  }

  // Add topics if present (preserves topic classification)
  if (placement.topics && placement.topics.length > 0) {
    fm += `topics:\n`;
    for (const topic of placement.topics) {
      fm += `  - "${escapeQuotes(topic)}"\n`;
    }
  }

  // Add sources (preserves source attribution)
  if (sources.length > 0) {
    fm += `sources:\n`;
    for (const source of sources) {
      fm += `  - title: "${escapeQuotes(source.title)}"\n`;
      fm += `    url: "${source.url}"\n`;
      if (source.domain) {
        fm += `    domain: "${source.domain}"\n`;
      }
    }
  }

  // Add image with alt text (preserves accessibility data)
  if (image && image.imagePath) {
    fm += `image: ${image.imagePath}\n`;
    if (image.altText) {
      fm += `imageAlt: "${escapeQuotes(image.altText)}"\n`;
    }
    const imageProvider = String(image.provider || image?.metadata?.provider || '').trim().toLowerCase();
    const imageAuthorName = String(image.authorName || image?.metadata?.authorName || '').trim();
    const imageAuthorUrl = String(image.authorUrl || image?.metadata?.authorUrl || '').trim();
    const imageSourceUrl = String(image.sourcePageUrl || image.sourceUrl || image?.metadata?.sourcePageUrl || image?.metadata?.sourceDownloadUrl || '').trim();
    if (imageProvider) {
      fm += `imageProvider: "${escapeQuotes(imageProvider)}"\n`;
    }
    if (imageAuthorName) {
      fm += `imageAuthorName: "${escapeQuotes(imageAuthorName)}"\n`;
    }
    if (imageAuthorUrl) {
      fm += `imageAuthorUrl: "${escapeQuotes(imageAuthorUrl)}"\n`;
    }
    if (imageSourceUrl) {
      fm += `imageSourceUrl: "${escapeQuotes(imageSourceUrl)}"\n`;
    }
    if (imageProvider === 'unsplash' && imageAuthorName) {
      fm += `imageCaption: "${escapeQuotes(`Photo by ${imageAuthorName} on Unsplash`)}"\n`;
    }
  }

  // Add YouTube video metadata if available (supplementary, never replaces hero image)
  const youtubeVideo = article?.youtubeVideo || null;
  if (youtubeVideo && youtubeVideo.videoId) {
    fm += `youtube_video_id: "${escapeQuotes(youtubeVideo.videoId)}"\n`;
    fm += `youtube_video_title: "${escapeQuotes(youtubeVideo.title)}"\n`;
    fm += `youtube_video_channel: "${escapeQuotes(youtubeVideo.channelTitle)}"\n`;
    fm += `youtube_video_published: "${escapeQuotes(youtubeVideo.publishedAt)}"\n`;
    if (youtubeVideo.duration) {
      fm += `youtube_video_duration: "${escapeQuotes(youtubeVideo.duration)}"\n`;
    }
    if (youtubeVideo.thumbnail) {
      fm += `youtube_video_thumbnail: "${escapeQuotes(youtubeVideo.thumbnail)}"\n`;
    }
    fm += `youtube_video_score: ${youtubeVideo.score}\n`;
    fm += `youtube_video_match_reason: "${escapeQuotes(youtubeVideo.matchReason)}"\n`;
  }

  // Add canonical URL hint if available
  const canonicalUrl = article.canonicalUrl || expectedUrl;
  if (canonicalUrl) {
    fm += `canonicalUrl: "${canonicalUrl}"\n`;
  }

  fm += `---`;

  return fm;
}

function resolvePublishableSources(article) {
  const canonicalPayload = article?.canonicalPublishPayload || null;
  const rawSources = canonicalPayload?.sources
    || article?.sourcePack?.canonicalPublicSources
    || article?.sourcePack?.publicSources
    || article?.sourcePack?.publishReadySources
    || article?.sourcePack?.sources;
  return sanitizeSources(rawSources, article?.sourcePack || null);
}

function resolvePublishIdentityKey(article = {}) {
  const candidates = [
    article?.brief?.poolIdentityKey,
    article?.brief?.identityKey,
    article?.publishIdentity?.identityKey,
    article?.canonicalPublishPayload?.identity_key,
    article?.canonicalPublishPayload?.identityKey,
  ];
  for (const candidate of candidates) {
    const key = String(candidate || '').trim();
    if (!key) continue;
    return key.toLowerCase();
  }
  return '';
}

function assessDuplicatePublication(article, publishMeta, publishableSources) {
  try {
    if (!fs.existsSync(POSTS_DIR)) return null;

    const incomingTitle = String(article?.draft?.title || article?.brief?.title || '').trim();
    const incomingTopicId = String(getResolvedPlacement(article).topic_id || '').trim().toLowerCase();
    const incomingSectionId = String(getResolvedPlacement(article).section_id || '').trim().toLowerCase();
    const incomingIdentityKeys = buildIncomingIdentityKeySet(article);
    const incomingSourceUrls = new Set(
      dedupeStrings((publishableSources || [])
        .map((source) => normalizeUrlForDedupe(source?.url))
        .filter(Boolean))
    );

    const entries = fs.readdirSync(POSTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mdx'))
      .map((entry) => path.join(POSTS_DIR, entry.name));

    for (const file of entries) {
      if (path.resolve(file) === path.resolve(publishMeta.filePath)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = extractPublishedEntry(raw, file);
      if (!parsed) continue;

      if (incomingIdentityKeys.size > 0 && parsed.publishIdentityKey && incomingIdentityKeys.has(parsed.publishIdentityKey)) {
        return {
          isDuplicate: true,
          reason: `identity_key_match(${parsed.publishIdentityKey})`,
          matchedFile: path.basename(file),
          matchedTitle: parsed.title,
          matchedUrl: parsed.canonicalUrl,
          titleSimilarity: computeTitleSimilarity(incomingTitle, parsed.title),
          sourceOverlap: 0,
        };
      }

      const sourceOverlap = countOverlap([...incomingSourceUrls], parsed.sourceUrls);
      const titleSimilarity = computeTitleSimilarity(incomingTitle, parsed.title);
      const titleTokenOverlap = countOverlap(tokenizeForMatching(incomingTitle), tokenizeForMatching(parsed.title));
      const sameTopic = incomingTopicId !== '' && incomingTopicId === parsed.topicId;
      const sameSection = incomingSectionId !== '' && incomingSectionId === parsed.sectionId;
      const recentHours = parsed.publishedAt ? (Date.now() - parsed.publishedAt.getTime()) / 3600000 : Infinity;

      if (sourceOverlap >= 2 && recentHours <= 336) {
        return {
          isDuplicate: true,
          reason: `source_overlap>=2_recent(${sourceOverlap})`,
          matchedFile: path.basename(file),
          matchedTitle: parsed.title,
          matchedUrl: parsed.canonicalUrl,
          titleSimilarity,
          sourceOverlap,
        };
      }

      if (sourceOverlap >= 1 && titleSimilarity >= 0.62 && recentHours <= 168) {
        return {
          isDuplicate: true,
          reason: `source+title_overlap_recent(source=${sourceOverlap},sim=${titleSimilarity.toFixed(2)})`,
          matchedFile: path.basename(file),
          matchedTitle: parsed.title,
          matchedUrl: parsed.canonicalUrl,
          titleSimilarity,
          sourceOverlap,
        };
      }

      if ((sameTopic || sameSection) && titleSimilarity >= 0.88 && recentHours <= 336) {
        return {
          isDuplicate: true,
          reason: `high_title_similarity_same_desk(sim=${titleSimilarity.toFixed(2)})`,
          matchedFile: path.basename(file),
          matchedTitle: parsed.title,
          matchedUrl: parsed.canonicalUrl,
          titleSimilarity,
          sourceOverlap,
        };
      }

      if (sameTopic && titleTokenOverlap >= 5 && recentHours <= 168) {
        return {
          isDuplicate: true,
          reason: `topic_title_token_overlap(${titleTokenOverlap})`,
          matchedFile: path.basename(file),
          matchedTitle: parsed.title,
          matchedUrl: parsed.canonicalUrl,
          titleSimilarity,
          sourceOverlap,
        };
      }
    }

    return { isDuplicate: false };
  } catch (error) {
    console.log(`[publisher] Duplicate guard scan skipped: ${error.message}`);
    return null;
  }
}

function buildIncomingIdentityKeySet(article = {}) {
  const keys = new Set();
  const candidates = [
    article?.brief?.poolIdentityKey,
    article?.brief?.identityKey,
    article?.publishIdentity?.identityKey,
    article?.canonicalPublishPayload?.identity_key,
    article?.canonicalPublishPayload?.identityKey,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim().toLowerCase();
    if (!value) continue;
    keys.add(value);
  }
  return keys;
}

function extractPublishedEntry(raw, filePath) {
  const frontmatterMatch = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return null;
  const frontmatterRaw = frontmatterMatch[1];
  const parsed = parseSimpleFrontmatter(frontmatterRaw);
  const sourceUrls = extractSourceUrlsFromFrontmatter(frontmatterRaw)
    .map((url) => normalizeUrlForDedupe(url))
    .filter(Boolean);
  const publishDate = parsePublishedDate(parsed.publishDate);

  return {
    filePath,
    title: String(parsed.title || '').trim(),
    topicId: String(parsed.topic_id || '').trim().toLowerCase(),
    sectionId: String(parsed.section_id || '').trim().toLowerCase(),
    canonicalUrl: String(parsed.canonicalUrl || '').trim(),
    publishIdentityKey: String(parsed.publish_identity_key || '').trim().toLowerCase(),
    sourceUrls,
    publishedAt: publishDate,
  };
}

function extractSourceUrlsFromFrontmatter(frontmatterRaw) {
  const urls = [];
  const patterns = [
    /^\s*url:\s*"([^"]+)"/gm,
    /^\s*url:\s*'([^']+)'/gm,
    /^\s*url:\s*([^\s#]+)\s*$/gm,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(frontmatterRaw);
    while (match) {
      urls.push(String(match[1] || '').trim());
      match = pattern.exec(frontmatterRaw);
    }
  }
  return dedupeStrings(urls);
}

function parsePublishedDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function normalizeUrlForDedupe(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Merge tags from multiple sources while avoiding duplicates
 */
function mergeTags(placementTags, topics, subsection, title, content) {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const normalized = normalizeTag(value);
    const key = normalized.toLowerCase();
    if (!normalized) return;
    if (!isValidPublishedTag(normalized)) return;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };

  for (const tag of placementTags || []) {
    pushCandidate(tag);
  }

  for (const topic of topics || []) {
    pushCandidate(topic);
  }

  if (candidates.length < 2 && subsection) {
    pushCandidate(subsection);
  }

  if (candidates.length < 3) {
    const extractedTags = extractTags(title, content);
    for (const tag of extractedTags) {
      if (candidates.length >= 3) break;
      pushCandidate(tag);
    }
  }

  const specific = candidates.filter((tag) => !isBroadCategoryTag(tag));
  const broad = candidates.filter((tag) => isBroadCategoryTag(tag));
  const finalTags = specific.length > 0 ? [...specific, ...broad] : candidates;

  return finalTags.slice(0, 3);
}

/**
 * Normalize tag for consistency
 */
function normalizeTag(tag) {
  return String(tag || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (['ai', 'us', 'uk', 'eu', 'npr', 'nyt', 'fda'].includes(lower)) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Extract tags from title and content (fallback when no placement data)
 */
function extractTags(title, content) {
  const sourceText = String(title || '');
  const tags = [];
  const seen = new Set();
  const blocked = new Set([
    'breaking', 'news', 'update', 'developing', 'analysis', 'report', 'explainer', 'feature',
    'politics', 'business', 'technology', 'tech', 'health', 'sports', 'science', 'culture',
    'latest', 'today', 'what', 'why', 'how', 'when', 'where', 'this', 'that', 'these', 'those',
    'with', 'from', 'into', 'onto', 'over', 'under', 'amid', 'after', 'before', 'during', 'against',
    'are', 'was', 'were', 'been', 'being', 'more', 'most', 'less', 'down', 'up', 'new', 'says', 'said',
    'investor', 'investors', 'official', 'officials', 'company', 'companies', 'market', 'markets'
  ]);
  const words = sourceText
    .replace(/[—–:;,!?()\[\]"']/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  const push = (value) => {
    const normalized = normalizeTag(value);
    const key = normalized.toLowerCase();
    if (!normalized) return;
    if (blocked.has(key)) return;
    if (normalized.length < 4 || normalized.length > 40) return;
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(normalized);
  };

  for (let size = 3; size >= 2; size -= 1) {
    for (let i = 0; i <= words.length - size; i += 1) {
      const slice = words.slice(i, i + size);
      const cleaned = slice
        .map((word) => word.toLowerCase())
        .filter((word) => word.length >= 3)
        .filter((word) => !blocked.has(word));
      if (cleaned.length !== size) continue;
      push(cleaned.join(' '));
      if (tags.length >= 3) return tags;
    }
  }

  return tags;
}

function isValidPublishedTag(tag) {
  const normalized = String(tag || '').trim();
  if (!normalized || normalized.length < 3 || normalized.length > 40) return false;
  if (/^(https?:|www\.)/i.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (new Set([
    'breaking', 'news', 'update', 'developing', 'analysis', 'report', 'explainer', 'feature',
    'deep', 'standard', 'article', 'story', 'coverage'
  ]).has(lower)) return false;
  return true;
}

function isBroadCategoryTag(tag) {
  return new Set(['politics', 'business', 'technology', 'tech', 'health', 'sports', 'science', 'culture', 'news'])
    .has(String(tag || '').trim().toLowerCase());
}

/**
 * Get category from article type (fallback for section)
 */
function getCategory(articleType) {
  const typeMap = {
    'report': 'News',
    'analysis': 'Analysis',
    'explainer': 'Explainer',
    'feature': 'Features',
    'breaking': 'News',
    'deep-dive': 'Analysis',
  };
  return typeMap[articleType] || 'News';
}

/**
 * Lightweight related coverage + inventory maintenance.
 * Optional only: never blocks publish when inventory is missing or no match is found.
 */
function buildRelatedCoverageLinks(article, expectedUrl) {
  try {
    if (!fs.existsSync(INVENTORY_PATH)) {
      return [];
    }

    const inventory = parseArticleInventory(fs.readFileSync(INVENTORY_PATH, 'utf-8'));
    if (inventory.length === 0) {
      return [];
    }

    const context = deriveInventoryContext(article, expectedUrl);
    const candidates = inventory
      .map((entry) => ({ entry, score: scoreRelatedInventoryEntry(context, entry) }))
      .filter((item) => Number.isFinite(item.score) && item.score >= RELATED_LINK_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELATED_LINKS)
      .map(({ entry }) => ({
        title: entry.title,
        url: entry.canonical_url,
      }));

    return dedupeRelatedLinks(candidates);
  } catch (error) {
    console.log(`[publisher] Related coverage skipped: ${error.message}`);
    return [];
  }
}

function appendRelatedCoverageSection(content, links) {
  const body = String(content || '').trimEnd();
  if (!body || !Array.isArray(links) || links.length === 0) {
    return String(content || '');
  }
  if (/^##\s+Related Coverage\b/im.test(body)) {
    return body;
  }

  const section = [
    '## Related Coverage',
    ...links.map((link) => `- [${link.title}](${link.url})`),
  ].join('\n');

  return `${body}\n\n${section}`;
}

function parseArticleInventory(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    if (/^\|[-\s|]+\|$/.test(line.trim())) continue;
    if (/^\|\s*Article ID\s*\|/i.test(line.trim())) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 12) continue;
    rows.push({
      article_id: cells[0],
      topic_id: cells[1],
      title: cells[2],
      created: cells[3],
      last_updated: cells[4],
      status: cells[5],
      section: cells[6],
      article_type: cells[7],
      primary_topic: cells[8],
      key_entities: splitInventoryList(cells[9]),
      search_keywords: splitInventoryList(cells[10]),
      canonical_url: cells[11],
    });
  }
  return rows;
}

function splitInventoryList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveInventoryContext(article, expectedUrl) {
  const draft = article?.draft || {};
  const placement = getResolvedPlacement(article);
  const section = String(placement.section || getCategory(draft.articleType || draft.article_type)).trim();
  const articleType = mapToValidArticleType(placement.article_type || draft.articleType || draft.article_type);
  const primaryTopic = String((placement.topics && placement.topics[0]) || placement.subsection || article?.brief?.title || draft.title || '').trim();
  const keyEntities = deriveKeyEntities(article);
  const searchKeywords = deriveSearchKeywords(article, primaryTopic);

  return {
    expectedUrl,
    title: String(draft.title || '').trim(),
    section,
    articleType,
    primaryTopic,
    keyEntities,
    searchKeywords,
  };
}

function deriveKeyEntities(article) {
  const placement = getResolvedPlacement(article);
  const candidates = [];
  for (const item of placement.topics || []) candidates.push(item);
  for (const item of placement.tags || []) candidates.push(item);
  for (const item of extractEntityPhrases(article?.draft?.title || article?.brief?.title || '')) candidates.push(item);
  return dedupeStrings(candidates).slice(0, 5);
}

function deriveSearchKeywords(article, primaryTopic = '') {
  const placement = getResolvedPlacement(article);
  const draft = article?.draft || {};
  const pool = [primaryTopic, ...(placement.tags || []), ...(placement.topics || []), draft.title || '', article?.brief?.title || ''];
  const keywords = [];
  for (const value of pool) {
    for (const token of tokenizeForMatching(value)) {
      if (keywords.includes(token)) continue;
      keywords.push(token);
      if (keywords.length >= 8) return keywords;
    }
  }
  return keywords;
}

function computeTitleSimilarity(left, right) {
  const a = tokenizeForMatching(left);
  const b = tokenizeForMatching(right);
  const overlap = countOverlap(a, b);
  const denom = Math.max(new Set(a).size, new Set(b).size, 1);
  return overlap / denom;
}

function scoreRelatedInventoryEntry(context, entry) {
  if (!entry || !entry.canonical_url || entry.canonical_url === context.expectedUrl) return -Infinity;
  if (String(entry.status || '').toLowerCase() !== 'published') return -Infinity;

  const titleSimilarity = computeTitleSimilarity(entry.title, context.title);
  const samePrimaryTopic = sameNormalized(entry.primary_topic, context.primaryTopic);
  const titleOverlap = countOverlap(tokenizeForMatching(entry.title), tokenizeForMatching(context.title));
  const recentHours = entry.created ? Math.max(0, (Date.now() - new Date(`${entry.created}T00:00:00Z`).getTime()) / 3600000) : Infinity;
  if (titleSimilarity >= 0.75 && samePrimaryTopic) return -Infinity;
  if (titleOverlap >= 3 && recentHours <= 96) return -Infinity;

  let score = 0;

  if (sameNormalized(entry.section, context.section)) score += 2;
  if (sameNormalized(entry.article_type, context.articleType)) score += 1;

  const topicOverlap = countOverlap(tokenizeForMatching(entry.primary_topic), tokenizeForMatching(context.primaryTopic));
  score += Math.min(topicOverlap, 3) * 1.2;

  const entityOverlap = countOverlap(
    entry.key_entities.map(normalizePhraseForMatching),
    context.keyEntities.map(normalizePhraseForMatching),
  );
  score += Math.min(entityOverlap, 2) * 2.4;

  const keywordOverlap = countOverlap(
    entry.search_keywords.map((value) => normalizeToken(value)).filter(Boolean),
    context.searchKeywords.map((value) => normalizeToken(value)).filter(Boolean),
  );
  score += Math.min(keywordOverlap, 4) * 0.7;

  score += Math.min(titleOverlap, 3) * 0.5;

  if (titleSimilarity >= 0.65 && entityOverlap >= 2) return -Infinity;
  if (samePrimaryTopic && keywordOverlap >= 3 && recentHours <= 96) return -Infinity;
  if (score < 2.5) return -Infinity;
  return score;
}

function dedupeRelatedLinks(links) {
  const seen = new Set();
  const seenTitles = [];
  const deduped = [];
  for (const link of links || []) {
    const url = String(link?.url || '').trim();
    const title = String(link?.title || '').trim();
    if (!url || !title) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    if (seenTitles.some((existing) => computeTitleSimilarity(existing, title) >= 0.8)) continue;
    seen.add(key);
    seenTitles.push(title);
    deduped.push({ title, url });
  }
  return deduped;
}

function updateInventoryBestEffort(article, meta) {
  try {
    if (!fs.existsSync(INVENTORY_PATH)) {
      return { updated: false, reason: 'inventory_missing' };
    }

    const markdown = fs.readFileSync(INVENTORY_PATH, 'utf-8');
    const usageIndex = markdown.indexOf('## Usage');
    const suffix = usageIndex >= 0 ? `\n\n${markdown.slice(usageIndex).trimStart()}` : '';
    const entries = parseArticleInventory(markdown);
    const derived = deriveInventoryRow(article, meta);

    if (!derived.article_id || !derived.canonical_url) {
      return { updated: false, reason: 'derived_metadata_incomplete' };
    }

    let action = 'inserted';
    const existingIndex = entries.findIndex((entry) => entry.canonical_url === derived.canonical_url || entry.article_id === derived.article_id);
    if (existingIndex >= 0) {
      entries[existingIndex] = { ...entries[existingIndex], ...derived };
      action = 'updated';
    } else {
      entries.push(derived);
    }

    const lines = [
      '# Article Inventory',
      '',
      INVENTORY_HEADER,
      INVENTORY_SEPARATOR,
      ...entries.map(formatInventoryRow),
    ];

    const nextMarkdown = `${lines.join('\n')}${suffix}`.trimEnd() + '\n';
    fs.writeFileSync(INVENTORY_PATH, nextMarkdown, 'utf-8');
    return { updated: true, action };
  } catch (error) {
    return { updated: false, reason: error.message };
  }
}

function deriveInventoryRow(article, meta) {
  const draft = article?.draft || {};
  const placement = getResolvedPlacement(article);
  const articleId = String(article?.brief?.id || article?.brief?.topic_id || meta.canonicalSlug || '').trim() || `ART-${meta.canonicalSlug}`;
  const topicId = String(placement.topic_id || article?.brief?.topicId || article?.brief?.topic_id || '').trim() || articleId;
  const primaryTopic = String((placement.topics && placement.topics[0]) || placement.subsection || article?.brief?.title || draft.title || '').trim();
  const keyEntities = deriveKeyEntities(article);
  const searchKeywords = deriveSearchKeywords(article, primaryTopic);

  return {
    article_id: articleId,
    topic_id: topicId,
    title: String(draft.title || article?.brief?.title || 'Untitled').trim(),
    created: String(meta.publishedAt || '').slice(0, 10),
    last_updated: String(meta.publishedAt || '').slice(0, 10),
    status: 'published',
    section: String(placement.section || getCategory(draft.articleType || draft.article_type)).trim() || 'News',
    article_type: mapToValidArticleType(placement.article_type || draft.articleType || draft.article_type),
    primary_topic: primaryTopic,
    key_entities: keyEntities,
    search_keywords: searchKeywords,
    canonical_url: meta.expectedUrl,
  };
}

function formatInventoryRow(entry) {
  return `| ${escapeInventoryCell(entry.article_id)} | ${escapeInventoryCell(entry.topic_id)} | ${escapeInventoryCell(entry.title)} | ${escapeInventoryCell(entry.created)} | ${escapeInventoryCell(entry.last_updated)} | ${escapeInventoryCell(entry.status)} | ${escapeInventoryCell(entry.section)} | ${escapeInventoryCell(entry.article_type)} | ${escapeInventoryCell(entry.primary_topic)} | ${escapeInventoryCell((entry.key_entities || []).join(', '))} | ${escapeInventoryCell((entry.search_keywords || []).join(', '))} | ${escapeInventoryCell(entry.canonical_url)} |`;
}

function escapeInventoryCell(value) {
  return String(value || '').replace(/\|/g, '/').trim();
}

function extractEntityPhrases(text) {
  const matches = String(text || '').match(/(?:[A-Z]{2,}|[A-Z][a-z]+)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+)){0,2}/g) || [];
  return dedupeStrings(matches.map((value) => value.trim()).filter((value) => value.length >= 3)).slice(0, 5);
}

function tokenizeForMatching(value) {
  return String(value || '')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
}

function normalizeToken(token) {
  const value = String(token || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!value || value.length < 3) return '';
  if (MATCH_STOPWORDS.has(value)) return '';
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ing') && value.length > 5) return value.slice(0, -3);
  if (value.endsWith('ed') && value.length > 4) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 4) return value.slice(0, -1);
  return value;
}

function normalizePhraseForMatching(value) {
  return tokenizeForMatching(value).join(' ');
}

function sameNormalized(a, b) {
  return normalizePhraseForMatching(a) !== '' && normalizePhraseForMatching(a) === normalizePhraseForMatching(b);
}

function countOverlap(left, right) {
  const setLeft = new Set((left || []).filter(Boolean));
  const setRight = new Set((right || []).filter(Boolean));
  let count = 0;
  for (const item of setLeft) {
    if (setRight.has(item)) count += 1;
  }
  return count;
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const clean = String(value || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

const MATCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'amid', 'after', 'before', 'under', 'over', 'about',
  'latest', 'breaking', 'news', 'report', 'analysis', 'explainer', 'feature', 'story', 'coverage', 'update', 'updates',
  'what', 'why', 'how', 'when', 'where', 'their', 'there', 'have', 'has', 'had', 'will', 'would', 'could', 'should',
  'today', 'says', 'said', 'more', 'most', 'less', 'than', 'into', 'onto', 'across', 'state', 'states'
]);

/**
 * Map article type to valid schema value
 * Schema only allows: 'explainer', 'analysis', 'report'
 */
function sanitizeSources(rawSources, sourcePack = null) {
  if (!Array.isArray(rawSources)) return [];

  const seen = new Set();
  const domainCounts = new Map();
  const sanitized = [];
  const articleType = String(sourcePack?.articleType || sourcePack?.article_type || 'report').toLowerCase();
  const roleByUrl = new Map((sourcePack?.sourceRoleResults || []).map((result) => [String(result?.source?.canonical_url || result?.source?.url || '').toLowerCase(), result]));

  const ranked = [...rawSources]
    .map((source) => {
      const url = normalizeUrl(source?.url);
      const role = roleByUrl.get(String(source?.canonical_url || url || '').toLowerCase());
      const score = (role?.role === 'core' ? 6 : role?.role === 'supporting' ? 4 : 0)
        + Number(role?.same_event_score || 0) * 1.4
        + Number(source?.sourceQualityScore || source?.source_quality_score || 0) * 0.12
        + Number(source?.article_likelihood || 0) * 0.5
        - Number(source?.genericity_score || 0) * 0.5
        + (String(source?.page_kind || '').toLowerCase() === 'official_release' ? 1 : 0);
      return { source, url, role, score };
    })
    .filter((item) => item.url)
    .sort((a, b) => b.score - a.score);

  const strict = ranked.filter((item) => {
    const pageKind = String(item.source?.page_kind || '').toLowerCase();
    if (['homepage', 'section', 'topic', 'video', 'audio', 'live', 'roundup'].includes(pageKind)) return false;
    if (articleType !== 'report') return true;
    return ['core', 'supporting'].includes(item.role?.role) && Number(item.role?.same_event_score || 0) >= 3;
  });
  const candidates = strict.length >= 2 ? strict : ranked;

  for (const item of candidates) {
    const source = item.source || {};
    const url = item.url;
    const pageKind = String(source?.page_kind || '').toLowerCase();
    if (['homepage', 'section', 'topic', 'video', 'audio', 'live', 'roundup'].includes(pageKind)) continue;
    const dedupeKey = url.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    const domain = source?.domain || getDomainFromUrl(url);
    const domainKey = String(domain || '').toLowerCase();
    const perDomainLimit = articleType === 'report' ? 1 : 2;
    if ((domainCounts.get(domainKey) || 0) >= perDomainLimit) continue;

    seen.add(dedupeKey);
    domainCounts.set(domainKey, (domainCounts.get(domainKey) || 0) + 1);

    const title = String(source?.title || '').trim() || domain || 'Source';

    sanitized.push({
      title,
      url,
      domain,
    });

    if (sanitized.length >= 4) break;
  }

  return sanitized;
}

function normalizeUrl(url) {
  if (!url) return null;
  const normalized = String(url).trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function mapToValidArticleType(type) {
  const validTypes = ['explainer', 'analysis', 'report'];
  const typeLower = (type || '').toLowerCase();

  if (validTypes.includes(typeLower)) {
    return typeLower;
  }

  // Map invalid types to closest valid type
  if (typeLower === 'breaking' || typeLower === 'feature' || typeLower === 'deep-dive') {
    return 'report';
  }

  // Default fallback
  return 'report';
}

/**
 * Escape quotes for frontmatter
 */
function escapeQuotes(text) {
  return String(text || '').replace(/"/g, '\\"');
}
