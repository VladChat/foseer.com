// File: qwen-scripts/utils/pre-draft-gate.js
// Purpose: Shared pre-draft gate checks — duplicate source-overlap and direct-event source count.
// Used by both pipeline.js and qna-pipeline.js to skip doomed candidates before expensive stages.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';
import { getSingleSourceEvidenceDecision, inferPublishableSources } from './evidence-policy.js';

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
 * Check if a candidate with only one publishable source still has strong enough evidence.
 * Mirrors the relaxed single-source policy used by source-pack, pre-write, and publish validation.
 * @param {Object} candidate - Candidate with sourcePack and brief
 * @returns {Object} { isBlocked, reason } or { isBlocked: false }
 */
export function checkPreDraftSingleSourceEvidence(candidate) {
  const sources = inferPublishableSources(candidate?.sourcePack);
  if (sources.length !== 1) return { isBlocked: false };

  const decision = getSingleSourceEvidenceDecision({
    brief: candidate?.brief || {},
    articleType: candidate?.brief?.articleType || candidate?.brief?.article_type || candidate?.sourcePack?.articleType || 'report',
    sources,
    coherenceScore: null,
    sourceConsistencyScore: candidate?.sourcePack?.metrics?.sourceConsistencyScore,
    directEventSourceCount: candidate?.sourcePack?.metrics?.directEventSourceCount || 0,
    crossTopicMismatchCount: 0,
  });

  if (!decision.pass) {
    return { isBlocked: true, reason: `Single-source evidence not strong enough (${decision.reason})` };
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

/**
 * Extract publishable sources from a candidate.
 */
function getPublishableSources(candidate) {
  return inferPublishableSources(candidate?.sourcePack);
}
