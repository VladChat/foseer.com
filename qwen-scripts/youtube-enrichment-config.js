// File: qwen-scripts/youtube-enrichment-config.js
// Purpose: Configuration for YouTube enrichment — thresholds, channel trust, search params.
// All values are tunable via environment variables with sensible defaults.

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'about', 'that', 'this', 'from', 'after', 'over',
  'under', 'between', 'through', 'during', 'before', 'above', 'below',
  'news', 'article', 'report', 'story', 'explainer', 'analysis', 'update',
  'breaking', 'latest', 'today', 'coverage', 'what', 'why', 'how',
]);

const TRUSTED_CHANNELS = new Set([
  'reuters', 'bbc', 'cnn', 'ap', 'associated press', 'sky news',
  'pbs', 'pbs newshour', 'npr', 'al jazeera', 'guardian',
  'espn', 'nfl', 'nba', 'mlb', 'ncaa', 'fifa',
  'white house', 'c-span', 'bloomberg', 'cnbc', 'financial times',
  'techcrunch', 'the verge', 'wired',
]);

const TRUSTED_CHANNEL_BOOST = 12;
const EXACT_TITLE_MATCH_BOOST = 15;
const ENTITY_OVERLAP_BOOST_PER_HIT = 5;
const FRESHNESS_BOOST_HOURS = 72;
const FRESHNESS_BOOST_VALUE = 6;
const STALE_PENALTY_DAYS = 30;
const STALE_PENALTY_VALUE = 8;
const LONG_VIDEO_PENALTY_MINUTES = 20;
const LONG_VIDEO_PENALTY_VALUE = 4;
const MIN_ATTACH_SCORE = 30;
const MAX_SEARCH_RESULTS = 10;
const MAX_VIDEO_DETAILS = 5;
const MAX_DURATION_SECONDS = 3600;
const MIN_DURATION_SECONDS = 30;

function resolveConfig(overrides = {}) {
  return {
    trustedChannels: TRUSTED_CHANNELS,
    trustedChannelBoost: Number(process.env.QWEN_YT_TRUSTED_CHANNEL_BOOST ?? TRUSTED_CHANNEL_BOOST),
    exactTitleMatchBoost: Number(process.env.QWEN_YT_EXACT_TITLE_BOOST ?? EXACT_TITLE_MATCH_BOOST),
    entityOverlapBoostPerHit: Number(process.env.QWEN_YT_ENTITY_BOOST ?? ENTITY_OVERLAP_BOOST_PER_HIT),
    freshnessBoostHours: Number(process.env.QWEN_YT_FRESHNESS_HOURS ?? FRESHNESS_BOOST_HOURS),
    freshnessBoostValue: Number(process.env.QWEN_YT_FRESHNESS_BOOST ?? FRESHNESS_BOOST_VALUE),
    stalePenaltyDays: Number(process.env.QWEN_YT_STALE_DAYS ?? STALE_PENALTY_DAYS),
    stalePenaltyValue: Number(process.env.QWEN_YT_STALE_PENALTY ?? STALE_PENALTY_VALUE),
    longVideoPenaltyMinutes: Number(process.env.QWEN_YT_LONG_VIDEO_MINUTES ?? LONG_VIDEO_PENALTY_MINUTES),
    longVideoPenaltyValue: Number(process.env.QWEN_YT_LONG_VIDEO_PENALTY ?? LONG_VIDEO_PENALTY_VALUE),
    minAttachScore: Number(process.env.QWEN_YT_MIN_SCORE ?? MIN_ATTACH_SCORE),
    maxSearchResults: Number(process.env.QWEN_YT_MAX_SEARCH_RESULTS ?? MAX_SEARCH_RESULTS),
    maxVideoDetails: Number(process.env.QWEN_YT_MAX_DETAILS ?? MAX_VIDEO_DETAILS),
    maxDurationSeconds: Number(process.env.QWEN_YT_MAX_DURATION ?? MAX_DURATION_SECONDS),
    minDurationSeconds: Number(process.env.QWEN_YT_MIN_DURATION ?? MIN_DURATION_SECONDS),
    tokenStopwords: TOKEN_STOPWORDS,
    ...overrides,
  };
}

function buildSearchQueries(article) {
  const title = String(article?.draft?.title || article?.brief?.title || '').trim();
  const excerpt = String(article?.draft?.excerpt || article?.brief?.summary || '').trim();
  const entities = extractEntities(article);
  const topicId = article?.brief?.topic_id || article?.placement?.topic_id || '';
  const queries = [];
  const seen = new Set();

  const addQuery = (q) => {
    const normalized = String(q || '').trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    queries.push(normalized);
  };

  // Primary: title-derived query (most specific)
  if (title) {
    const titleTokens = tokenize(title);
    if (titleTokens.length >= 2) {
      addQuery(`${titleTokens.slice(0, 4).join(' ')} news`);
    }
    if (titleTokens.length >= 3) {
      addQuery(titleTokens.slice(0, 5).join(' '));
    }
    // Add entity-aware variant
    if (entities.length > 0 && titleTokens.length >= 2) {
      addQuery(`${entities[0]} ${titleTokens.slice(0, 3).join(' ')}`);
    }
  }

  // Secondary: entity-focused query
  if (entities.length > 0) {
    addQuery(`${entities.slice(0, 2).join(' ')} news`);
  }

  // Tertiary: section/topic fallback
  if (topicId) {
    addQuery(topicId.replace(/-/g, ' '));
  }

  return queries.slice(0, 3);
}

function extractEntities(article) {
  const sources = article?.sourcePack?.sources || [];
  const entities = new Set();
  for (const source of sources) {
    if (Array.isArray(source?.entities)) {
      for (const entity of source.entities) {
        if (entity && String(entity).trim()) {
          entities.add(String(entity).trim().toLowerCase());
        }
      }
    }
  }
  return Array.from(entities).slice(0, 5);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !TOKEN_STOPWORDS.has(t));
}

function parseIsoDuration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export {
  resolveConfig,
  buildSearchQueries,
  extractEntities,
  tokenize,
  parseIsoDuration,
  formatDuration,
  TRUSTED_CHANNELS,
};
