// File: qwen-scripts/utils/pre-draft-gate.js
// Purpose: Shared pre-draft gate checks — duplicate source-overlap and final evidence sanity.
// Used by both pipeline.js and qna-pipeline.js to skip doomed candidates before expensive stages.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';
import { isOfficialPrimaryDomain, isTrustedReportingDomain, normalizeDomain } from '../config/trusted-publishers.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src/data/post');

/**
 * Normalize a URL to hostname+pathname for duplicate comparison.
 */
function normalizeSourceUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

/**
 * Extract source URLs from frontmatter of an MDX file.
 */
function extractPublishedSourceUrls(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const frontmatterMatch = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) return [];

    const fm = frontmatterMatch[1];
    const urls = [];
    const urlPattern = /^\s*url:\s*"?([^"\n]+)"?$/gm;
    let m;
    while ((m = urlPattern.exec(fm)) !== null) {
      const rawUrl = m[1].trim();
      if (rawUrl && rawUrl.startsWith('http')) urls.push(normalizeSourceUrl(rawUrl));
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Extract publish date from frontmatter.
 */
function extractPublishedDate(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const pubMatch = raw.match(/^publishDate:\s*"?(.+?)"?$/m);
    return pubMatch ? new Date(pubMatch[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Check if a candidate would be blocked by the publisher's duplicate guard.
 * Reuses the same source_overlap>=2_recent threshold as publisher.js.
 * @param {Object} candidate - Candidate with sourcePack or sources
 * @param {Object} options - Options (recentDuplicateWindowHours)
 * @returns {Object} { isDuplicate, reason } or { isDuplicate: false }
 */
export function checkPreDraftDuplicate(candidate, options = {}) {
  const RECENT_HOURS = Number(options.recentDuplicateWindowHours || process.env.QWEN_RECENT_DUPLICATE_WINDOW_DAYS || 3) * 24;

  try {
    if (!fs.existsSync(POSTS_DIR)) return { isDuplicate: false };

    const publishableSources = getPublishableSources(candidate);
    const incomingSourceUrls = publishableSources
      .map((s) => normalizeSourceUrl(s?.url || s?.canonicalUrl || s?.canonical_url || ''))
      .filter(Boolean);
    if (incomingSourceUrls.length === 0) return { isDuplicate: false };

    const entries = fs.readdirSync(POSTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mdx'));

    for (const entry of entries) {
      const file = path.join(POSTS_DIR, entry.name);
      const publishedUrls = extractPublishedSourceUrls(file);
      if (publishedUrls.length === 0) continue;

      const publishedAt = extractPublishedDate(file);
      const recentHours = publishedAt && Number.isFinite(publishedAt.getTime())
        ? (Date.now() - publishedAt.getTime()) / 3600000
        : Infinity;

      const overlap = incomingSourceUrls.filter((url) => publishedUrls.includes(url)).length;
      if (overlap >= 2 && recentHours <= RECENT_HOURS) {
        return { isDuplicate: true, reason: `source_overlap>=2_recent(${overlap})` };
      }
    }
  } catch {
    // Non-blocking: if the scan fails, proceed to drafting; publisher will catch it later
  }

  return { isDuplicate: false };
}

/**
 * Final single-source sanity check.
 * Keeps duplicate blocking strict, but lets non-high-risk single-source stories proceed when
 * the source is trusted/official and the title alignment is good enough.
 */
export function checkPreDraftSingleSourceEvidence(candidate) {
  const sourcePack = candidate?.sourcePack || {};
  const brief = candidate?.brief || {};
  const sources = getPublishableSources(candidate);
  const sourceCount = sources.length;
  const directEventCount = Number(sourcePack?.metrics?.directEventSourceCount || 0);
  const articleType = String(brief?.articleType || brief?.article_type || 'report').toLowerCase();
  const highRisk = isHighRiskBrief(brief);

  if (sourceCount === 0) {
    return { isBlocked: true, reason: 'No publishable sources available for drafting' };
  }
  if (sourceCount >= 2) {
    if (highRisk && directEventCount < 2) {
      return { isBlocked: true, reason: `High-risk report still needs 2 direct-event sources, found ${directEventCount}` };
    }
    return { isBlocked: false };
  }

  const source = sources[0] || {};
  const domain = normalizeDomain(source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || '');
  const pageKind = String(source?.page_kind || '').toLowerCase();
  const briefTitle = String(brief?.title || '').trim();
  const sourceTitle = String(source?.title || '').trim();
  const titleOverlap = computeTitleOverlap(briefTitle, sourceTitle);
  const hasTrustedOrOfficial = isTrustedReportingDomain(domain) || isOfficialPrimaryDomain(domain);

  if (highRisk) {
    return { isBlocked: true, reason: 'High-risk topic still requires multi-source corroboration' };
  }
  if (!hasTrustedOrOfficial) {
    return { isBlocked: true, reason: 'Single-source evidence not strong enough (missing trusted or official source)' };
  }
  if (['homepage', 'section', 'topic', 'live', 'roundup'].includes(pageKind)) {
    return { isBlocked: true, reason: `Single-source evidence not strong enough (non_publishable_page_kind:${pageKind})` };
  }
  if (isGenericBriefTitle(briefTitle)) {
    return { isBlocked: true, reason: 'Single-source evidence not strong enough (title_too_generic)' };
  }
  if (articleType === 'report' && directEventCount < 1) {
    return { isBlocked: true, reason: 'Single-source evidence not strong enough (direct_event_signal_missing)' };
  }
  if (titleOverlap < 0.18 && !isOfficialPrimaryDomain(domain)) {
    return { isBlocked: true, reason: `Single-source evidence not strong enough (title_overlap_too_low:${titleOverlap.toFixed(2)})` };
  }

  return { isBlocked: false };
}

/**
 * Run both pre-draft gates. Returns combined result.
 */
export function runPreDraftGates(candidate, options = {}) {
  const duplicate = checkPreDraftDuplicate(candidate, options);
  if (duplicate.isDuplicate) {
    return { blocked: true, reason: duplicate.reason, stage: 'pre_draft_duplicate' };
  }

  const singleSource = checkPreDraftSingleSourceEvidence(candidate);
  if (singleSource.isBlocked) {
    return { blocked: true, reason: singleSource.reason, stage: 'pre_draft_single_source' };
  }

  return { blocked: false };
}

function isHighRiskBrief(brief = {}) {
  const highRiskTopicIds = new Set(['world-geopolitics', 'us-politics', 'law-crime', 'climate-extreme-weather']);
  if (highRiskTopicIds.has(String(brief?.topic_id || '').toLowerCase())) return true;
  const text = `${brief?.title || ''} ${brief?.whatHappened || ''} ${brief?.whyItMatters || ''}`.toLowerCase();
  return /(killed|dead|deaths|war|attack|airstrike|hostage|terror|indicted|charged|sanction|lawsuit|verdict|court)/.test(text);
}

function isGenericBriefTitle(title = '') {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return true;
  if (/^(transcript|live|update|updates|coverage|briefing)$/.test(normalized)) return true;
  const tokens = normalized.split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3);
  return tokens.length < 2;
}

function computeTitleOverlap(left = '', right = '') {
  const leftTokens = new Set(String(left || '').toLowerCase().split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3));
  const rightTokens = new Set(String(right || '').toLowerCase().split(/[^a-z0-9]+/).map((token) => token.trim()).filter((token) => token.length >= 3));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, 1);
}

/**
 * Extract publishable sources from a candidate.
 */
function getPublishableSources(candidate) {
  const sourcePack = candidate?.sourcePack;
  if (Array.isArray(sourcePack?.publishReadySources) && sourcePack.publishReadySources.length > 0) {
    return sourcePack.publishReadySources;
  }
  if (Array.isArray(sourcePack?.sources) && sourcePack.sources.length > 0) {
    return sourcePack.sources;
  }
  return [];
}
