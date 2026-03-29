// File: qwen-project-governance/publisher/publisher.ts
// Purpose: Minimal publisher that writes approved articles to src/data/post/
// Input: editorial_decision.md + article_draft.md
// Output: Published article in src/data/post/

import type { SectionId, TopicId, CanonicalArticleType } from '../shared/taxonomy-contract.js';

export interface EditorialDecision {
  article_id: string;
  decision: 'approve' | 'approve_with_changes' | 'revise' | 'reject';
  next_action: 'publish' | 'return_to_author' | 'archive';
}

export interface ArticleDraft {
  topic_id: string;
  article_id: string;
  draft_version: number;
  author: string;
  created: string;
  status: string;
  content: string; // Full markdown content after frontmatter
  tags?: string[];
}

export interface PublishedArticle {
  publishDate: string;
  title: string;
  excerpt: string;
  image?: string;
  category?: string;
  tags?: string[];
  author?: string;
  draft?: boolean;
  content: string;
}

export interface PublishSourceLink {
  title: string;
  url: string;
}

export interface PublishFormattingOptions {
  category?: string;
  tags?: string[];
  author?: string;
  sources?: PublishSourceLink[];
  // Canonical taxonomy fields (new)
  article_type?: CanonicalArticleType;
  section_id?: SectionId;
  topic_id?: TopicId;
}

export interface InventoryEntryMetadata {
  section?: string;
  article_type?: string;
  primary_topic?: string;
  key_entities?: string[];
  search_keywords?: string[];
  canonical_url?: string;
  status?: string;
}

/**
 * Check if article is approved for publication.
 */
export function isApproved(decision: EditorialDecision): boolean {
  return decision.decision === 'approve' && decision.next_action === 'publish';
}

/**
 * Convert article draft to published format for src/data/post/.
 * Formats filename as YYYY-MM-DD-slug.mdx
 *
 * Canonical taxonomy contract:
 * - article_type: how the article is written (explainer | analysis | report)
 * - section_id: which top-level section the article belongs to
 * - topic_id: which taxonomy topic the article covers
 *
 * Legacy fields (category, tags) are kept for backward compatibility.
 */
export function formatPublishedArticle(
  draft: ArticleDraft,
  title: string,
  excerpt: string,
  options: PublishFormattingOptions = {}
): { filename: string; content: string } {
  const date = new Date().toISOString().split('T')[0];
  
  // D. Normalize unicode before slug generation to prevent mojibake/garbage
  const normalizedTitle = normalizeUnicodeForSlug(title);
  const slug = normalizedTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 50)
    .replace(/-+$/g, '');
  const filename = `${date}-${slug}.mdx`;

  const resolvedAuthor = (options.author || draft.author || 'Foseer Editorial').trim();
  const resolvedCategory = sanitizeCategory(options.category || 'News');
  const resolvedTags = sanitizeTags(options.tags && options.tags.length > 0 ? options.tags : draft.tags || []);
  const resolvedSources = sanitizeSources(options.sources || []);

  let frontmatter = `---
publishDate: ${new Date().toISOString()}
title: "${title.replace(/"/g, '\"')}"
excerpt: "${excerpt.replace(/"/g, '\"')}"
author: "${resolvedAuthor.replace(/"/g, '\"')}"
category: "${resolvedCategory.replace(/"/g, '\"')}"
tags:
${resolvedTags.length > 0 ? resolvedTags.map((tag) => `  - "${tag.replace(/"/g, '\"')}"`).join('\n') : '  []'}
`;

  if (resolvedSources.length > 0) {
    frontmatter += `sources:
${resolvedSources
      .map((source) => `  - title: "${source.title.replace(/"/g, '\"')}"\n    url: "${source.url.replace(/"/g, '\"')}"`)
      .join('\n')}
`;
  }

  frontmatter += `draft: false
`;

  // Add canonical taxonomy fields if provided
  if (options.article_type) {
    frontmatter += `article_type: "${options.article_type}"
`;
  }
  if (options.section_id) {
    frontmatter += `section_id: "${options.section_id}"
`;
  }
  if (options.topic_id) {
    frontmatter += `topic_id: "${options.topic_id}"
`;
  }

  frontmatter += `---

`;

  // Remove claim references section for published version
  const contentBody = draft.content.replace(/\n---\n## Claim References[\s\S]*$/, '');

  return {
    filename,
    content: frontmatter + contentBody,
  };
}

function sanitizeCategory(value: string): string {
  const clean = String(value || '')
    .replace(/['"]/g, '')
    .trim();
  if (!clean) return 'News';
  if (/^analysis$/i.test(clean)) return 'Analysis';
  if (/^explainer$/i.test(clean)) return 'Explainer';
  if (/^news$/i.test(clean)) return 'News';
  return clean;
}

/**
 * Normalize mojibake and malformed unicode in text.
 * Used before slug generation to prevent garbage characters.
 */
function normalizeUnicodeForSlug(text: string): string {
  let normalized = String(text || '');

  const mojibakeMap: Array<[RegExp, string]> = [
    [/ΓÇÖ/g, "'"],
    [/â€™/g, "'"],
    [/â€˜/g, "'"],
    [/â€œ/g, '"'],
    [/â€/g, '"'],
    [/â€“/g, '-'],
    [/â€”/g, '-'],
    [/Â/g, ' '],
  ];

  for (const [pattern, replacement] of mojibakeMap) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized.replace(/\uFFFD/g, '');
  normalized = normalized.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '');
  normalized = normalized.replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

  try {
    normalized = normalized.normalize('NFKD');
  } catch {
    // Ignore normalization errors
  }

  normalized = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized.trim();
}

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  const blocked = new Set([
    'news', 'foseer', 'editorial', 'report', 'analysis', 'explainer', 'article',
    'mother', 'daughter', 'father', 'son', 'family', 'story', 'reporters', 'says', 'said',
    'theguardian', 'guardian', 'theglobeandmail', 'globeandmail', 'reuters', 'ap', 'bbc', 'cnn',
  ]);

  for (const raw of tags || []) {
    const normalized = String(raw || '')
      .replace(/['"]/g, ' ')
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!normalized || normalized.length < 4 || normalized.length > 32) continue;
    if (blocked.has(normalized)) continue;
    if (/^(www|http|https)\b/.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    cleaned.push(normalized.split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '));
    if (cleaned.length >= 3) break;
  }

  return cleaned;
}

function sanitizeSources(sources: PublishSourceLink[]): PublishSourceLink[] {
  const seen = new Set<string>();
  const cleaned: PublishSourceLink[] = [];

  for (const source of sources || []) {
    const url = String(source?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = String(source?.title || '').replace(/\s+/g, ' ').trim();
    const safeTitle = title || new URL(url).hostname.replace(/^www\./i, '');
    cleaned.push({ title: safeTitle, url });
    if (cleaned.length >= 4) break;
  }

  return cleaned;
}

function sanitizeInventoryCell(value: string): string {
  return String(value || '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeInventoryList(values: string[] | undefined): string {
  return (values || [])
    .map((value) => sanitizeInventoryCell(value))
    .filter(Boolean)
    .join(', ');
}

export function canonicalUrlFromFilename(filename: string): string {
  const slug = String(filename || '')
    .replace(/\.mdx?$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .trim();
  return slug ? `/article/${slug}` : '';
}

/**
 * Generate inventory update line for published article.
 * Appends new metadata columns while keeping the legacy leading columns intact.
 */
export function formatInventoryEntry(
  articleId: string,
  topicId: string,
  title: string,
  filename: string,
  metadata: InventoryEntryMetadata = {}
): string {
  const date = new Date().toISOString().split('T')[0];
  const cells = [
    articleId,
    topicId,
    title,
    date,
    date,
    metadata.status || 'published',
    metadata.section || '',
    metadata.article_type || '',
    metadata.primary_topic || title,
    sanitizeInventoryList(metadata.key_entities),
    sanitizeInventoryList(metadata.search_keywords),
    metadata.canonical_url || canonicalUrlFromFilename(filename),
  ].map((value) => sanitizeInventoryCell(value));

  return `| ${cells.join(' | ')} |`;
}
