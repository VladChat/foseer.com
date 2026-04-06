// File: qwen-scripts/youtube-enrichment.js
// Purpose: Server-side YouTube enrichment — search, rank, filter, and normalize one best video per article.
// Uses YouTube Data API v3 (search.list + videos.list). Never exposes the API key to client code.

import {
  resolveConfig,
  buildSearchQueries,
  extractEntities,
  tokenize,
  parseIsoDuration,
  formatDuration,
  TRUSTED_CHANNELS,
} from './youtube-enrichment-config.js';

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_NOCOOKIE_BASE = 'https://www.youtube-nocookie.com';

/**
 * Main entry point: enrich one article candidate with a YouTube video if a strong match exists.
 * @param {Object} article - Article object with draft, brief, sourcePack, placement
 * @param {Object} options - Optional overrides
 * @returns {Promise<Object|null>} Normalized video metadata or null if no strong match
 */
async function enrichArticleWithVideo(article, options = {}) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.log('[youtube] No API key configured; skipping YouTube enrichment');
    return null;
  }

  const articleSlug = article?.articleSlug || 'unknown';
  const articleTitle = article?.draft?.title || article?.brief?.title || 'Untitled';
  console.log(`[youtube] Article: slug=${articleSlug}, title="${articleTitle}"`);

  const config = resolveConfig(options);
  const queries = buildSearchQueries(article);
  if (queries.length === 0) {
    console.log('[youtube] No search queries derived; skipping');
    return null;
  }

  console.log(`[youtube] Generated ${queries.length} queries: ${queries.map((q) => `"${q}"`).join(', ')}`);

  const titleTokens = tokenize(articleTitle);
  const entities = extractEntities(article);
  const articleProfile = { titleTokens, entities };
  console.log(`[youtube] Profile: ${titleTokens.length} title tokens, ${entities.length} entities`);

  // Phase 1: Search for candidates across queries
  const allSearchCandidates = await searchCandidates(queries, config, apiKey, article);
  if (allSearchCandidates.length === 0) {
    console.log('[youtube] No search results for any query');
    return null;
  }

  console.log(`[youtube] Phase 1: ${allSearchCandidates.length} candidates`);

  // Phase 2: Fetch detailed metadata for top candidates
  const videoIds = allSearchCandidates.slice(0, config.maxVideoDetails).map((c) => c.videoId);
  console.log(`[youtube] Fetching details for ${videoIds.length} videos`);
  const videoDetails = await fetchVideoDetails(videoIds, apiKey, config);

  // Phase 3: Enrich search results with detailed metadata
  const enriched = allSearchCandidates.map((candidate) => {
    const detail = videoDetails.get(candidate.videoId);
    return { ...candidate, detail };
  });

  // Phase 4: Filter by hard constraints
  const filtered = applyHardFilters(enriched, config, articleProfile);
  if (filtered.length === 0) {
    console.log('[youtube] No candidates passed hard filters');
    return null;
  }

  console.log(`[youtube] Phase 4: ${filtered.length} after filters`);

  // Phase 5: Score and rank
  const scored = filtered.map((candidate) => {
    const scoreResult = computeRelevanceScore(candidate, config, articleProfile);
    return { ...candidate, score: scoreResult.score, matchReason: scoreResult.matchReason, scoreReasons: scoreResult.reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  // Phase 6: Threshold gate
  const best = scored[0];
  if (best.score < config.minAttachScore) {
    console.log(`[youtube] Best score ${best.score.toFixed(1)} < threshold ${config.minAttachScore}; no attach`);
    return null;
  }

  const videoId = best.detail?.id || best.videoId || 'unknown';
  console.log(`[youtube] ATTACH: video="${best.detail?.title}" channel="${best.detail?.channelTitle}" score=${best.score.toFixed(1)} videoId=${videoId}`);

  return normalizeVideoObject(best, article);
}

function resolveApiKey() {
  const key = (process.env.YOUTUBE_API_KEY || '').trim();
  return key || null;
}

async function searchCandidates(queries, config, apiKey, article) {
  const allCandidates = [];
  const seenIds = new Set();

  for (const query of queries) {
    console.log(`[youtube] Searching for: "${query}"`);
    const searchUrl = buildSearchUrl(query, config, apiKey);
    // Log sanitized URL (without key for security)
    const sanitizedUrl = searchUrl.replace(/key=[^&]*/, 'key=REDACTED');
    console.log(`[youtube] Request URL (sanitized): ${sanitizedUrl.substring(0, 200)}...`);

    try {
      const response = await fetch(searchUrl);
      console.log(`[youtube] Response status: ${response.status}`);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.warn(`[youtube] HTTP ${response.status} for "${query}": ${errorBody.substring(0, 200)}`);
        continue;
      }

      const data = await response.json();
      if (data.error) {
        console.warn(`[youtube] API error for "${query}": code=${data.error.code} message=${data.error.message}`);
        continue;
      }

      const resultCount = (data.items || []).length;
      console.log(`[youtube] Query "${query}": ${resultCount} results`);

      for (const item of (data.items || [])) {
        if (item.id?.kind !== 'youtube#video') continue;
        const videoId = item.id.videoId;
        if (seenIds.has(videoId)) continue;
        seenIds.add(videoId);
        allCandidates.push({
          videoId,
          snippet: item.snippet || {},
          sourceQuery: query,
        });
      }
    } catch (error) {
      console.error(`[youtube] Network error for "${query}": ${error.message}`);
    }
  }

  console.log(`[youtube] searchCandidates: ${allCandidates.length} total candidates`);
  return allCandidates;
}

function buildSearchUrl(query, config, apiKey) {
  // Add publishedAfter for recent news (past 72 hours for reports/analysis)
  const now = new Date();
  const pastTime = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const publishedAfter = pastTime.toISOString();

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(config.maxSearchResults),
    relevanceLanguage: 'en',
    videoEmbeddable: true, // Boolean parameter
    order: 'relevance',
    publishedAfter, // Freshness control
    key: apiKey,
  });
  return `${YOUTUBE_SEARCH_URL}?${params.toString()}`;
}

async function fetchVideoDetails(videoIds, apiKey, config = {}) {
  const detailsMap = new Map();
  if (videoIds.length === 0) return detailsMap;

  const idString = videoIds.join(',');
  console.log(`[youtube] Fetching details for: ${idString.substring(0, 100)}${idString.length > 100 ? '...' : ''}`);

  const detailsUrl = `${YOUTUBE_VIDEOS_URL}?part=snippet,contentDetails,status,statistics&id=${idString}&key=${apiKey}`;
  const sanitizedUrl = detailsUrl.replace(/key=[^&]*/, 'key=REDACTED');
  console.log(`[youtube] Details URL (sanitized): ${sanitizedUrl.substring(0, 200)}...`);

  try {
    const response = await fetch(detailsUrl);
    console.log(`[youtube] Details response status: ${response.status}`);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(no body)');
      console.warn(`[youtube] Details HTTP ${response.status}: ${errorBody.substring(0, 200)}`);
      return detailsMap;
    }
    const data = await response.json();
    if (data.error) {
      console.warn(`[youtube] Details API error: code=${data.error.code} message=${data.error.message}`);
      return detailsMap;
    }
    const itemsCount = (data.items || []).length;
    console.log(`[youtube] Got ${itemsCount} details`);
    for (const item of (data.items || [])) {
      detailsMap.set(item.id, {
        title: item.snippet?.title || '',
        channelTitle: item.snippet?.channelTitle || '',
        channelId: item.snippet?.channelId || '',
        publishedAt: item.snippet?.publishedAt || '',
        description: item.snippet?.description || '',
        thumbnails: item.snippet?.thumbnails || {},
        duration: item.contentDetails?.duration || '',
        embeddable: item.status?.embeddable ?? true,
        viewCount: Number(item.statistics?.viewCount || 0),
      });
    }
  } catch (error) {
    console.error(`[youtube] Details fetch exception: ${error.message}`);
  }

  return detailsMap;
}

function applyHardFilters(candidates, config, articleProfile) {
  return candidates.filter((candidate) => {
    const detail = candidate.detail;
    if (!detail) return false;

    // Must be embeddable
    if (detail.embeddable === false) return false;

    // Duration constraints
    const durationSeconds = parseIsoDuration(detail.duration);
    if (durationSeconds < config.minDurationSeconds) return false;
    if (durationSeconds > config.maxDurationSeconds) return false;

    // Published date must exist
    if (!detail.publishedAt) return false;

    return true;
  });
}

function computeRelevanceScore(candidate, config, articleProfile) {
  const detail = candidate.detail || {};
  const snippet = candidate.snippet || {};
  let score = 0;
  const reasons = [];

  // 1. Title match scoring
  const videoTitleTokens = tokenize(detail.title);
  const titleOverlap = overlapCount(articleProfile.titleTokens, videoTitleTokens);
  if (titleOverlap >= 3) {
    score += 15;
    reasons.push(`title_overlap:${titleOverlap}`);
  } else if (titleOverlap >= 2) {
    score += 8;
    reasons.push(`title_overlap:${titleOverlap}`);
  } else if (titleOverlap >= 1) {
    score += 3;
    reasons.push(`title_overlap:${titleOverlap}`);
  }

  // Exact title match bonus
  const normalizedVideoTitle = normalizeTitle(detail.title);
  const normalizedArticleTitle = normalizeTitle(
    articleProfile.titleTokens.join(' ')
  );
  if (normalizedArticleTitle && normalizedVideoTitle.includes(normalizedArticleTitle)) {
    score += config.exactTitleMatchBoost;
    reasons.push('exact_title_match');
  }

  // 2. Entity overlap
  const videoDescTokens = tokenize(detail.description || '');
  const allVideoTokens = [...videoTitleTokens, ...videoDescTokens];
  const entityHits = articleProfile.entities.filter((e) =>
    allVideoTokens.some((t) => t.includes(e) || e.includes(t))
  ).length;
  if (entityHits > 0) {
    score += entityHits * config.entityOverlapBoostPerHit;
    reasons.push(`entity_hits:${entityHits}`);
  }

  // 3. Channel trust
  const channelLower = (detail.channelTitle || '').toLowerCase();
  if (config.trustedChannels.has(channelLower) ||
      config.trustedChannels.has(normalizeTitle(detail.channelTitle))) {
    score += config.trustedChannelBoost;
    reasons.push('trusted_channel');
  }

  // 4. Freshness
  const publishedDate = new Date(detail.publishedAt);
  const now = new Date();
  const hoursSincePublish = (now - publishedDate) / (1000 * 60 * 60);
  if (hoursSincePublish <= config.freshnessBoostHours) {
    score += config.freshnessBoostValue;
    reasons.push('fresh');
  }
  const daysSincePublish = hoursSincePublish / 24;
  if (daysSincePublish > config.stalePenaltyDays) {
    score -= config.stalePenaltyValue;
    reasons.push('stale');
  }

  // 5. Duration quality
  const durationSeconds = parseIsoDuration(detail.duration);
  const durationMinutes = durationSeconds / 60;
  if (durationMinutes > config.longVideoPenaltyMinutes) {
    // Only penalize if not justified by title match strength
    if (titleOverlap < 2) {
      score -= config.longVideoPenaltyValue;
      reasons.push('too_long');
    }
  }

  // 6. View count signal (light boost for popular videos)
  if (detail.viewCount >= 100000) {
    score += 2;
    reasons.push('popular');
  }

  // 7. Description relevance (light check for key tokens)
  const descOverlap = overlapCount(
    articleProfile.titleTokens.slice(0, 4),
    videoDescTokens
  );
  if (descOverlap >= 2) {
    score += 4;
    reasons.push(`desc_overlap:${descOverlap}`);
  }

  // Determine match reason
  let matchReason = 'general_relevance';
  if (reasons.includes('exact_title_match')) matchReason = 'exact_title_match';
  else if (reasons.includes('trusted_channel') && reasons.some((r) => r.startsWith('title_overlap'))) {
    matchReason = 'trusted_channel_title_match';
  } else if (reasons.some((r) => r.startsWith('entity_hits'))) {
    matchReason = 'entity_match';
  } else if (reasons.some((r) => r.startsWith('title_overlap'))) {
    matchReason = 'title_relevance';
  }

  return { score, matchReason, reasons };
}

function overlapCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVideoObject(candidate, article) {
  const detail = candidate.detail || {};
  const thumbnail = selectBestThumbnail(detail.thumbnails);
  const durationSeconds = parseIsoDuration(detail.duration);

  return {
    videoId: candidate.videoId,
    title: detail.title || candidate.snippet?.title || '',
    channelTitle: detail.channelTitle || '',
    publishedAt: detail.publishedAt || '',
    duration: formatDuration(durationSeconds),
    durationSeconds,
    thumbnail: thumbnail?.url || '',
    thumbnailWidth: thumbnail?.width || 0,
    thumbnailHeight: thumbnail?.height || 0,
    embedUrl: `${YOUTUBE_NOCOOKIE_BASE}/embed/${candidate.videoId}`,
    score: Math.round(candidate.score * 10) / 10,
    matchReason: candidate.matchReason || 'general_relevance',
    sourceQuery: candidate.sourceQuery || '',
  };
}

function selectBestThumbnail(thumbnails) {
  if (!thumbnails) return null;
  const priority = ['maxres', 'standard', 'high', 'medium', 'default'];
  for (const key of priority) {
    if (thumbnails[key]) return thumbnails[key];
  }
  return thumbnails.medium || thumbnails.default || null;
}

export {
  enrichArticleWithVideo,
  computeRelevanceScore,
  applyHardFilters,
  searchCandidates,
  fetchVideoDetails,
  buildSearchUrl,
  resolveApiKey,
  normalizeVideoObject,
};
