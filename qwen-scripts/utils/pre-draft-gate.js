// File: qwen-scripts/utils/pre-draft-gate.js
// Purpose: Shared pre-draft gate checks — duplicate source-overlap, event-level similarity,
// and direct-event source count. Used by both pipeline.js and qna-pipeline.js to skip
// doomed candidates before expensive stages. Conservative: advisory-first, high-confidence only.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';
import { isRelaxedPipelineMode } from './pipeline-mode.js';

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
 * Extract headline/title from frontmatter.
 */
function extractPublishedTitle(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const titleMatch = raw.match(/^title:\s*"?([^"\n]+)"?$/m);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extract section_id/topic_id from frontmatter.
 */
function extractPublishedTaxonomy(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const sectionMatch = raw.match(/^section_id:\s*"?([^"\n]+)"?$/m);
    const topicMatch = raw.match(/^topic_id:\s*"?([^"\n]+)"?$/m);
    return {
      section_id: sectionMatch ? sectionMatch[1].trim() : null,
      topic_id: topicMatch ? topicMatch[1].trim() : null,
    };
  } catch {
    return { section_id: null, topic_id: null };
  }
}

/**
 * Extract entities from frontmatter (sources domain + title keywords).
 */
function extractPublishedEntities(filePath, title) {
  try {
    const entities = new Set();
    if (title) {
      const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
      for (const word of words) {
        if (word.length > 3) entities.add(word);
      }
    }
    if (filePath && fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const urlMatches = fm.match(/url:\s*"?https?:\/\/([^/\s"]+)/g);
        if (urlMatches) {
          for (const match of urlMatches) {
            const domain = match.replace(/url:\s*"?https?:\/\//, '').replace(/"/g, '').trim();
            if (domain) entities.add(domain);
          }
        }
      }
    }
    return entities;
  } catch {
    return new Set();
  }
}

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/**
 * Get publishable sources from a candidate.
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

/**
 * Check if a candidate would be blocked by the publisher's duplicate guard.
 * Reuses the same source_overlap>=2_recent threshold as publisher.js.
 * @param {Object} candidate - Candidate with sourcePack or sources
 * @param {Object} options - Options (recentDuplicateWindowHours)
 * @returns {Object} { isDuplicate, reason } or { isDuplicate: false }
 */
export function checkPreDraftDuplicate(candidate, options = {}) {
  const relaxedMode = isRelaxedPipelineMode(options);
  const RECENT_HOURS = Number(options.recentDuplicateWindowHours || process.env.QWEN_RECENT_DUPLICATE_WINDOW_DAYS || 3) * 24;

  try {
    if (!fs.existsSync(POSTS_DIR)) return { isDuplicate: false };

    const incomingSourceUrls = getPublishableSources(candidate)
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
        if (relaxedMode) {
          return { isDuplicate: false };
        }
        return { isDuplicate: true, reason: `source_overlap>=2_recent(${overlap})` };
      }
    }
  } catch {
    // Non-blocking: if the scan fails, proceed to drafting; publisher will catch it later
  }

  return { isDuplicate: false };
}

/**
 * Check event-level duplicate similarity.
 * Goes beyond URL overlap to detect same-event articles with different source sets.
 * Conservative: only blocks when combined confidence is HIGH (≥0.55).
 * For borderline cases (0.40-0.55), logs a warning but does NOT block.
 * @param {Object} candidate - Candidate with brief, sourcePack
 * @param {Object} options - Options (eventSimilarityThreshold, recentHours)
 * @returns {Object} { isEventDuplicate, reason, similarityScore, matchedFile, isWarning } or { isEventDuplicate: false }
 */
export function checkEventLevelDuplicate(candidate, options = {}) {
  const HIGH_THRESHOLD = Number(options.eventHighThreshold || process.env.QWEN_EVENT_DUPLICATE_HIGH_THRESHOLD || 0.45);
  const WARNING_THRESHOLD = Number(options.eventWarningThreshold || process.env.QWEN_EVENT_DUPLICATE_WARNING_THRESHOLD || 0.30);
  const RECENT_HOURS = Number(options.recentDuplicateWindowHours || process.env.QWEN_RECENT_DUPLICATE_WINDOW_DAYS || 3) * 24;
  const relaxedMode = isRelaxedPipelineMode(options);

  try {
    if (!fs.existsSync(POSTS_DIR)) return { isEventDuplicate: false };

    const candidateTitle = candidate?.brief?.title || '';
    const candidateSection = candidate?.sourcePack?.section_id || candidate?.brief?.section_id || '';
    const candidateTopic = candidate?.sourcePack?.topic_id || candidate?.brief?.topic_id || '';

    if (!candidateTitle) return { isEventDuplicate: false };

    const candidateEntities = extractPublishedEntities(null, candidateTitle);
    // Add source domains
    for (const src of (candidate?.sourcePack?.sources || [])) {
      if (src?.domain) candidateEntities.add(src.domain.toLowerCase());
    }

    const entries = fs.readdirSync(POSTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mdx'));

    let bestMatch = null;

    for (const entry of entries) {
      const file = path.join(POSTS_DIR, entry.name);

      const publishedAt = extractPublishedDate(file);
      const recentHours = publishedAt && Number.isFinite(publishedAt.getTime())
        ? (Date.now() - publishedAt.getTime()) / 3600000
        : Infinity;

      // Only check recent articles (within window)
      if (recentHours > RECENT_HOURS) continue;

      const publishedTitle = extractPublishedTitle(file);
      if (!publishedTitle) continue;

      // Skip if same title (exact duplicate already caught by URL check)
      if (publishedTitle.toLowerCase() === candidateTitle.toLowerCase()) continue;

      const publishedEntities = extractPublishedEntities(file, publishedTitle);
      const publishedTaxonomy = extractPublishedTaxonomy(file);

      // Compute entity similarity (Jaccard)
      const entitySim = jaccardSimilarity(candidateEntities, publishedEntities);

      // Topic coherence bonus (same section/topic)
      let topicBonus = 0;
      if (candidateSection && publishedTaxonomy.section_id === candidateSection) topicBonus += 0.1;
      if (candidateTopic && publishedTaxonomy.topic_id === candidateTopic) topicBonus += 0.1;

      // Headline word overlap (additional signal)
      const candidateWords = new Set(candidateTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
      const publishedWords = new Set(publishedTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 3));
      const headlineSim = jaccardSimilarity(candidateWords, publishedWords);

      // Combined score: entity similarity (60%) + headline similarity (30%) + topic bonus (10%)
      const combinedScore = (entitySim * 0.6) + (headlineSim * 0.3) + topicBonus;

      if (combinedScore > (bestMatch?.score || 0)) {
        bestMatch = {
          score: combinedScore,
          entitySim,
          headlineSim,
          topicBonus,
          file: entry.name,
          title: publishedTitle,
        };
      }
    }

    if (!bestMatch) return { isEventDuplicate: false };

    if (bestMatch.score >= HIGH_THRESHOLD) {
      if (relaxedMode) {
        return { isEventDuplicate: false, note: 'relaxed mode — event duplicate suppressed' };
      }
      return {
        isEventDuplicate: true,
        isWarning: false,
        reason: `event_duplicate: score=${bestMatch.score.toFixed(2)} (entity=${bestMatch.entitySim.toFixed(2)}, headline=${bestMatch.headlineSim.toFixed(2)}, topic=${bestMatch.topicBonus.toFixed(2)}) vs "${bestMatch.title}"`,
        similarityScore: bestMatch.score,
        matchedFile: bestMatch.file,
        matchedTitle: bestMatch.title,
      };
    }

    if (bestMatch.score >= WARNING_THRESHOLD) {
      return {
        isEventDuplicate: true,
        isWarning: true,
        reason: `event_similarity_warning: score=${bestMatch.score.toFixed(2)} (entity=${bestMatch.entitySim.toFixed(2)}, headline=${bestMatch.headlineSim.toFixed(2)}) vs "${bestMatch.title}"`,
        similarityScore: bestMatch.score,
        matchedFile: bestMatch.file,
        matchedTitle: bestMatch.title,
      };
    }

    return { isEventDuplicate: false };
  } catch {
    return { isEventDuplicate: false, note: 'scan failed, proceeding' };
  }
}

/**
 * Check if a report-type candidate has enough direct-event sources.
 * Mirrors the validate-publish-graph.js rule: reports need >= 2 direct-event sources.
 * @param {Object} candidate - Candidate with sourcePack and brief
 * @returns {Object} { isBlocked, reason } or { isBlocked: false }
 */
export function checkPreDraftDirectEventSources(candidate, options = {}) {
  const relaxedMode = isRelaxedPipelineMode(options);
  const directEventCount = candidate?.sourcePack?.metrics?.directEventSourceCount || 0;
  const articleType = String(candidate?.brief?.articleType || candidate?.brief?.article_type || 'report').toLowerCase();

  if (articleType === 'report' && directEventCount < 2) {
    if (relaxedMode) {
      return { isBlocked: false };
    }
    return { isBlocked: true, reason: `Report requires at least 2 direct-event sources, found ${directEventCount}` };
  }

  return { isBlocked: false };
}

/**
 * Run all pre-draft gates. Returns combined result.
 * Order: URL duplicate → event duplicate → direct-event sources.
 * Event duplicate is advisory (warning) unless high confidence.
 */
export function runPreDraftGates(candidate, options = {}) {
  // 1. URL-based duplicate check (hard block)
  const duplicate = checkPreDraftDuplicate(candidate, options);
  if (duplicate.isDuplicate) {
    return { blocked: true, reason: duplicate.reason, stage: 'pre_draft_duplicate', isWarning: false };
  }

  // 2. Event-level duplicate check (hard block only if high confidence, warning otherwise)
  const eventDup = checkEventLevelDuplicate(candidate, options);
  if (eventDup.isEventDuplicate && !eventDup.isWarning) {
    return { blocked: true, reason: eventDup.reason, stage: 'pre_draft_event_duplicate', isWarning: false, matchedFile: eventDup.matchedFile, matchedTitle: eventDup.matchedTitle };
  }

  // 3. Direct-event source check
  const directEvent = checkPreDraftDirectEventSources(candidate, options);
  if (directEvent.isBlocked) {
    return { blocked: true, reason: directEvent.reason, stage: 'pre_draft_direct_event_source', isWarning: false };
  }

  // 4. Event similarity warning (non-blocking)
  if (eventDup.isEventDuplicate && eventDup.isWarning) {
    return { blocked: false, warning: eventDup.reason, stage: 'pre_draft_event_similarity_warning', isWarning: true, matchedFile: eventDup.matchedFile, matchedTitle: eventDup.matchedTitle };
  }

  return { blocked: false };
}
