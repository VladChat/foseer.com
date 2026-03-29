// File: qwen-scripts/utils/source-normalization.js
// Purpose: Normalize discovered materials into a canonical structure before clustering and source-role classification.

import { detectPageKind, scoreGenericity, scoreArticleLikelihood, getCanonicalDomain, getUrlPath } from './page-kind.js';

const TITLE_URL_STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'after', 'over', 'under', 'about', 'amid',
  'news', 'latest', 'breaking', 'report', 'reports', 'reporting', 'live', 'updates', 'today', 'story', 'stories',
  'watch', 'video', 'videos', 'audio', 'podcast', 'podcasts', 'article', 'articles', 'analysis', 'opinion',
  'world', 'business', 'tech', 'technology', 'health', 'sports', 'culture', 'politics', 'general',
  'www', 'com', 'net', 'org', 'html', 'htm', 'amp'
]);

export function normalizeSourceMaterial(input = {}, options = {}) {
  const url = firstUrl(input);
  if (!isValidHttpUrl(url)) return null;

  const canonicalUrl = getCanonicalUrl(url);
  const title = cleanTitle(input.title || input.canonicalTitle || 'Source');
  const snippet = String(input.snippet || input.summary || input.description || '').trim();
  const pageKind = detectPageKind({ url: canonicalUrl, title, snippet });
  const genericityScore = scoreGenericity(pageKind, { url: canonicalUrl, title, snippet });
  const articleLikelihood = scoreArticleLikelihood(pageKind, { url: canonicalUrl, title, snippet });
  const normalizedTitle = normalizeTitle(title);
  const titleSignalTokens = extractTitleSignalTokens(title);
  const urlSignalTokens = extractUrlSignalTokens(canonicalUrl);
  const titleUrlOverlap = computeTitleUrlSignalOverlap(titleSignalTokens, urlSignalTokens);
  const titleUrlMismatch = hasTitleUrlMismatch({ pageKind, titleSignalTokens, urlSignalTokens, titleUrlOverlap });

  return {
    source_id: options.sourceId || buildSourceId(canonicalUrl, normalizedTitle),
    url,
    canonical_url: canonicalUrl,
    domain: getCanonicalDomain(url),
    canonical_domain: getCanonicalDomain(canonicalUrl),
    title,
    normalized_title: normalizedTitle,
    snippet,
    page_kind: pageKind,
    published_at: input.publishedAt || input.published_at || input.when || input.discoveredAt || null,
    provider: input.provider || null,
    section_id: input.section_id || input.detectedSectionId || null,
    topic_id: input.topic_id || input.detectedTopicId || null,
    section_candidates: uniq([...(input.sectionCandidates || []), input.sectionHint]).slice(0, 3),
    topic_candidates: uniq([...(input.topicCandidates || []), input.topicHint]).slice(0, 3),
    cluster_id: input.cluster_id || input.clusterId || null,
    event_key: input.eventKey || null,
    entities: uniq([...(input.entities || []), ...(input.involvedParties || [])].map((v) => normalizeEntity(v))).filter(Boolean).slice(0, 12),
    keywords: uniq([...(input.keywords || []), ...extractKeywords(title, snippet)]).slice(0, 12),
    title_signal_tokens: titleSignalTokens,
    url_signal_tokens: urlSignalTokens,
    title_url_overlap: titleUrlOverlap,
    title_url_mismatch: titleUrlMismatch,
    region: input.region || 'global',
    angle: input.angle || 'general',
    genericity_score: genericityScore,
    article_likelihood: articleLikelihood,
    source_quality_score: Number(input.sourceQualityScore || input.source_quality_score || 0),
  };
}

export function buildSourceId(canonicalUrl, normalizedTitle = '') {
  const seed = `${canonicalUrl}|${normalizedTitle}`.toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return `src-${Math.abs(hash)}`;
}

export function getCanonicalUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    const keepParams = [];
    const params = new URLSearchParams(parsed.search);
    for (const [key, value] of params.entries()) {
      if (/^(id|article|story|output|utm_source)$/i.test(key)) keepParams.push([key, value]);
    }
    parsed.search = keepParams.length ? new URLSearchParams(keepParams).toString() : '';
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

export function normalizeTitle(value = '') {
  return cleanTitle(value)
    .toLowerCase()
    .replace(/\b(latest|live updates?|breaking|exclusive|analysis|opinion)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitleSignalTokens(value = '') {
  return uniq(
    normalizeTitle(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !TITLE_URL_STOP_TOKENS.has(token))
  ).slice(0, 12);
}

export function extractUrlSignalTokens(url = '') {
  const path = getUrlPath(String(url || '').toLowerCase());
  const rawTokens = path
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return uniq(
    rawTokens
      .filter((token) => token.length >= 4)
      .filter((token) => !/^\d+$/.test(token))
      .filter((token) => !/^\d{4}$/.test(token))
      .filter((token) => !TITLE_URL_STOP_TOKENS.has(token))
  ).slice(0, 12);
}

export function computeTitleUrlSignalOverlap(titleTokens = [], urlTokens = []) {
  if (!Array.isArray(titleTokens) || !Array.isArray(urlTokens) || titleTokens.length === 0 || urlTokens.length === 0) {
    return 0;
  }
  const urlTokenSet = new Set(urlTokens);
  const overlap = titleTokens.filter((token) => urlTokenSet.has(token)).length;
  return overlap / Math.max(1, Math.min(titleTokens.length, urlTokens.length));
}

export function hasTitleUrlMismatch({ pageKind = '', titleSignalTokens = [], urlSignalTokens = [], titleUrlOverlap = 0 } = {}) {
  const kind = String(pageKind || '').toLowerCase();
  if (['homepage', 'section', 'topic', 'live', 'roundup', 'video', 'audio'].includes(kind)) return false;
  if (titleSignalTokens.length < 3 || urlSignalTokens.length < 3) return false;
  if (titleUrlOverlap >= 0.22) return false;
  return titleUrlOverlap === 0 || (titleSignalTokens.length >= 4 && urlSignalTokens.length >= 4 && titleUrlOverlap < 0.12);
}

function firstUrl(input) {
  return input.canonical_url || input.canonicalUrl || input.url || input.link || input.sourceUrls?.[0] || '';
}

function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s*[|–-]\s*[^|–-]{1,30}$/g, '').trim().slice(0, 180);
}

function normalizeEntity(value) {
  return String(value || '').trim().toLowerCase();
}

function extractKeywords(title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  return uniq(text.split(/[^a-z0-9]+/).filter((token) => token.length >= 4)).slice(0, 12);
}

function uniq(values) {
  return Array.from(new Set((values || []).map((v) => String(v || '').trim()).filter(Boolean)));
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
