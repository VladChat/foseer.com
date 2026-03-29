// File: qwen-project-governance/shared/article-placement.js
// Purpose: Resolve stable section/topic placement metadata from the active taxonomy with safer matching.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TAXONOMY_PATH = path.resolve(__dirname, '../../src/data/taxonomy.json');

const SECTION_LABEL_BY_ID = {
  news: 'News',
  business: 'Business',
  tech: 'Tech',
  health: 'Health',
  sports: 'Sports',
  culture: 'Culture',
};

const SECTION_ID_BY_LABEL = {
  news: 'news',
  business: 'business',
  tech: 'tech',
  technology: 'tech',
  health: 'health',
  sports: 'sports',
  culture: 'culture',
  entertainment: 'culture',
  politics: 'news',
  world: 'news',
};

const LEGACY_TOPIC_REDIRECTS = {
  'global-conflicts': 'world-geopolitics',
  'culture-entertainment': 'film-tv',
  'social-media-trends': 'internet-culture',
  'tech-gadgets': 'consumer-tech',
  'transportation-evs': 'mobility-evs',
  'stock-market-economy': 'companies-deals',
  'consumer-money-personal-finance': 'consumer-money',
  'health-science': 'public-health',
  'sports-leagues-analysis': 'major-leagues',
  'sports-business-transfers': 'transfers-business',
  'big-issues-explained': 'society-social-trends',
  'editorial-perspectives': 'society-social-trends',
};

const TOPIC_DEFINITIONS = [
  { section_id: 'news', topic_id: 'us-politics', label: 'U.S. Politics & Policy', aliases: ['u.s. politics', 'us politics', 'white house', 'congress', 'senate', 'house', 'campaign', 'election', 'federal policy', 'supreme court', 'administration'] },
  { section_id: 'news', topic_id: 'world-geopolitics', label: 'World & Geopolitics', aliases: ['geopolitics', 'foreign policy', 'diplomacy', 'war', 'military', 'missile', 'ceasefire', 'ukraine', 'russia', 'israel', 'gaza', 'iran', 'china sea'] },
  { section_id: 'news', topic_id: 'law-crime', label: 'Law & Crime', aliases: ['law and crime', 'law', 'crime', 'police', 'arrest', 'arrests', 'charged', 'court', 'judge', 'lawsuit', 'trial', 'investigation', 'kidnap', 'murder'] },
  { section_id: 'news', topic_id: 'climate-extreme-weather', label: 'Climate & Extreme Weather', aliases: ['climate', 'extreme weather', 'storm', 'storms', 'wildfire', 'wildfires', 'flood', 'flooding', 'heatwave', 'hurricane', 'tornado'] },
  { section_id: 'news', topic_id: 'society-social-trends', label: 'Society & Social Trends', aliases: ['society', 'social trend', 'social trends', 'education', 'labor', 'workers', 'community', 'communities', 'demographics', 'public reaction'] },
  { section_id: 'business', topic_id: 'economy-markets', label: 'Economy & Markets', aliases: ['economy', 'economic', 'inflation', 'jobs report', 'interest rates', 'federal reserve', 'gdp', 'trade', 'tariff', 'market'] },
  { section_id: 'business', topic_id: 'companies-deals', label: 'Companies & Deals', aliases: ['company', 'companies', 'earnings', 'profit', 'profits', 'revenue', 'merger', 'acquisition', 'deal', 'ceo', 'corporate', 'shareholder'] },
  { section_id: 'business', topic_id: 'consumer-money', label: 'Consumer Money', aliases: ['consumer money', 'personal finance', 'credit card', 'loan', 'debt', 'savings', 'budget', 'refund', 'fee', 'fees', 'billing'] },
  { section_id: 'business', topic_id: 'housing-real-estate', label: 'Housing & Real Estate', aliases: ['housing', 'real estate', 'mortgage', 'rent', 'landlord', 'tenant', 'home prices', 'property'] },
  { section_id: 'business', topic_id: 'crypto-bitcoin', label: 'Crypto', aliases: ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'token', 'tokens', 'digital asset'] },
  { section_id: 'business', topic_id: 'travel-consumer-issues', label: 'Travel & Consumer Issues', aliases: ['travel', 'airport', 'airports', 'airline', 'airlines', 'tsa', 'flight', 'flights', 'hotel', 'rental car', 'travel disruption', 'travel delay', 'travel delays', 'airport delay', 'airport delays', 'security line', 'security lines', 'wait time', 'wait times', 'terminal', 'aviation security', 'airport security', 'passenger screening', 'government shutdown'] },
  { section_id: 'tech', topic_id: 'ai-big-tech', label: 'AI & Big Tech', aliases: ['ai', 'artificial intelligence', 'openai', 'chatgpt', 'google', 'meta', 'microsoft', 'nvidia', 'anthropic', 'big tech', 'chip'] },
  { section_id: 'tech', topic_id: 'consumer-tech', label: 'Consumer Tech', aliases: ['consumer tech', 'technology', 'device', 'devices', 'gadget', 'gadgets', 'software', 'hardware', 'smartphone', 'iphone', 'android', 'laptop', 'app store'] },
  { section_id: 'tech', topic_id: 'cybersecurity', label: 'Cybersecurity', aliases: ['cybersecurity', 'cyber', 'data breach', 'breach', 'breaches', 'hack', 'hacked', 'ransomware', 'malware', 'security flaw'] },
  { section_id: 'tech', topic_id: 'mobility-evs', label: 'Mobility & EVs', aliases: ['mobility', 'ev', 'evs', 'electric vehicle', 'electric vehicles', 'charging network', 'tesla', 'autonomous vehicle', 'robotaxi', 'transit system'] },
  { section_id: 'tech', topic_id: 'space-astronomy', label: 'Space & Astronomy', aliases: ['space', 'astronomy', 'nasa', 'rocket', 'satellite', 'moon', 'mars', 'launch'] },
  { section_id: 'tech', topic_id: 'enterprise-platforms', label: 'Enterprise & Platforms', aliases: ['enterprise software', 'cloud platform', 'cloud', 'developer platform', 'saas', 'infrastructure', 'workflow platform', 'operating system'] },
  { section_id: 'health', topic_id: 'public-health', label: 'Public Health', aliases: ['public health', 'outbreak', 'disease', 'virus', 'infection', 'hospital system', 'health agency', 'epidemic', 'patient safety'] },
  { section_id: 'health', topic_id: 'medical-research', label: 'Medical Research', aliases: ['medical research', 'study', 'studies', 'trial', 'trials', 'clinical', 'peer reviewed', 'researchers', 'treatment study'] },
  { section_id: 'health', topic_id: 'pharma-fda', label: 'Pharma & FDA', aliases: ['fda', 'drug approval', 'drug', 'drugs', 'pharma', 'pharmaceutical', 'biotech', 'recall', 'drugmaker'] },
  { section_id: 'health', topic_id: 'mental-health', label: 'Mental Health', aliases: ['mental health', 'anxiety', 'depression', 'therapy', 'therapist', 'stress', 'psychiatry'] },
  { section_id: 'health', topic_id: 'wellness-fitness', label: 'Wellness & Fitness', aliases: ['wellness', 'fitness', 'exercise', 'nutrition', 'sleep', 'workout', 'diet'] },
  { section_id: 'sports', topic_id: 'major-leagues', label: 'Major Leagues', aliases: ['nfl', 'nba', 'mlb', 'nhl', 'premier league', 'soccer league', 'football league', 'baseball', 'basketball', 'league standings'] },
  { section_id: 'sports', topic_id: 'events-tournaments', label: 'Events & Tournaments', aliases: ['tournament', 'tournaments', 'world cup', 'olympics', 'playoffs', 'championship', 'grand slam', 'final'] },
  { section_id: 'sports', topic_id: 'transfers-business', label: 'Transfers & Business', aliases: ['transfer', 'transfers', 'trade', 'trades', 'contract extension', 'media rights', 'ownership group', 'sports business'] },
  { section_id: 'sports', topic_id: 'athletes-culture', label: 'Athletes & Culture', aliases: ['athlete', 'athletes', 'locker room', 'fandom', 'sports culture', 'star player', 'fans'] },
  { section_id: 'culture', topic_id: 'film-tv', label: 'Film & TV', aliases: ['film', 'films', 'movie', 'movies', 'tv', 'television', 'streaming', 'series', 'box office'] },
  { section_id: 'culture', topic_id: 'music-celebrities', label: 'Music & Celebrities', aliases: ['music', 'musician', 'album', 'tour', 'celebrity', 'celebrities', 'artist', 'awards show'] },
  { section_id: 'culture', topic_id: 'internet-culture', label: 'Internet Culture', aliases: ['internet culture', 'viral', 'meme', 'online discourse', 'social media', 'tiktok trend', 'reddit'] },
  { section_id: 'culture', topic_id: 'creators-platforms', label: 'Creators & Platforms', aliases: ['creator economy', 'creator', 'creators', 'youtube', 'instagram', 'tiktok', 'twitch', 'platform moderation', 'influencer'] },
];

let cachedTaxonomy = null;

function loadTaxonomy() {
  if (cachedTaxonomy) return cachedTaxonomy;

  try {
    const raw = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf-8'));
    const topicsById = new Map((raw.topics || []).map((topic) => [topic.id, topic]));
    cachedTaxonomy = {
      sections: (raw.sections || []).map((section) => ({
        id: section.id,
        label: section.label,
        topics: (section.topics || []).map((topicId) => ({
          id: topicId,
          label: topicsById.get(topicId)?.label || topicId,
        })),
      })),
      topicsById,
    };
  } catch {
    cachedTaxonomy = { sections: [], topicsById: new Map() };
  }

  return cachedTaxonomy;
}

function normalizeLabel(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeLabel(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const label = normalizeLabel(value);
    const key = normalizeKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function buildSearchText(parts) {
  return parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .map((part) => normalizeLabel(part))
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

function normalizeTopicId(topicId) {
  const key = normalizeLabel(topicId);
  return LEGACY_TOPIC_REDIRECTS[key] || key || null;
}


function canonicalizePlacement(sectionId, topicId) {
  const normalizedTopicId = normalizeTopicId(topicId);
  if (normalizedTopicId) {
    const def = TOPIC_DEFINITIONS.find((item) => item.topic_id === normalizedTopicId);
    if (def?.section_id) {
      return {
        sectionId: def.section_id,
        topicId: normalizedTopicId,
      };
    }
  }

  return {
    sectionId: normalizeLabel(sectionId) || null,
    topicId: normalizedTopicId || null,
  };
}
function getSectionIdFromLabel(label) {
  const key = normalizeKey(label);
  return SECTION_ID_BY_LABEL[key] || null;
}

function getSectionLabel(sectionId) {
  const normalized = normalizeKey(sectionId);
  for (const [id, label] of Object.entries(SECTION_LABEL_BY_ID)) {
    if (normalizeKey(id) === normalized) return label;
  }
  return normalizeLabel(sectionId) || '';
}

function getTopicLabel(topicId) {
  const normalizedId = normalizeTopicId(topicId);
  const taxonomy = loadTaxonomy();
  const topic = taxonomy.topicsById.get(normalizedId);
  if (topic?.label) return topic.label;
  const fallback = TOPIC_DEFINITIONS.find((item) => item.topic_id === normalizedId);
  return fallback?.label || normalizeLabel(normalizedId);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function aliasInText(text, alias) {
  const aliasText = normalizeKey(alias);
  if (!aliasText) return false;
  const pattern = new RegExp(`(^|\\b)${escapeRegex(aliasText).replace(/ /g, '\\s+')}(\\b|$)`, 'i');
  return pattern.test(text);
}

function findTopicMatch({ preferredSectionId, subsection, text }) {
  const subsectionKey = normalizeKey(subsection);
  const genericSubsectionKeys = new Set(['news', 'business', 'tech', 'technology', 'health', 'sports', 'culture', 'politics', 'world']);
  const candidates = [];

  for (const def of TOPIC_DEFINITIONS) {
    if (preferredSectionId && def.section_id !== preferredSectionId) continue;

    let score = 0;

    if (subsectionKey && !genericSubsectionKeys.has(subsectionKey)) {
      if (normalizeKey(def.label) === subsectionKey) score += 8;
      if (def.aliases.some((alias) => normalizeKey(alias) === subsectionKey)) score += 6;
      if (subsectionKey.includes(normalizeKey(def.label))) score += 3;
    }

    for (const alias of def.aliases) {
      if (aliasInText(text, alias)) {
        score += normalizeKey(alias).split(' ').length > 1 ? 4 : 2;
      }
      if (subsectionKey && normalizeKey(alias).includes(subsectionKey)) {
        score += 1;
      }
    }

    if (
      def.topic_id === 'travel-consumer-issues'
      && (
        aliasInText(text, 'tsa')
        || aliasInText(text, 'airport')
        || aliasInText(text, 'airport security')
        || aliasInText(text, 'travel delays')
        || aliasInText(text, 'government shutdown')
      )
    ) {
      score += 4;
    }
    if (score > 0) candidates.push({ ...def, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

export function resolvePlacementMetadata(input = {}) {
  const classification = input.classification || {};
  const explicitSection = normalizeLabel(input.section || classification.section);
  const explicitSubsection = normalizeLabel(input.subsection || classification.subsection);
  const explicitArticleType = normalizeLabel(input.article_type || input.articleType || classification.articleType);
  const explicitSectionId = normalizeLabel(input.section_id || input.sectionId);
  const explicitTopicId = normalizeTopicId(input.topic_id || input.topicId);

  const tags = uniqueStrings([...(input.tags || []), ...(classification.tags || [])]);
  const topics = uniqueStrings([...(input.topics || [])]);

  const text = buildSearchText([
    input.title,
    input.excerpt,
    input.content,
    explicitSection,
    explicitSubsection,
    tags,
    topics,
    (input.sources || []).map((source) => `${source?.title || ''} ${source?.domain || ''}`),
  ]);

  let sectionId = explicitSectionId || getSectionIdFromLabel(explicitSection) || null;
  let topicId = explicitTopicId || null;
  ({ sectionId, topicId } = canonicalizePlacement(sectionId, topicId));

  if (!topicId) {
    const match = findTopicMatch({ preferredSectionId: sectionId, subsection: explicitSubsection, text });
    if (match) {
      topicId = match.topic_id;
      sectionId = match.section_id;
      ({ sectionId, topicId } = canonicalizePlacement(sectionId, topicId));
    }
  }

  if (!sectionId && topicId) {
    const def = TOPIC_DEFINITIONS.find((item) => item.topic_id === topicId);
    sectionId = def?.section_id || null;
  }

  const genericSubsectionKeys = new Set(['news', 'business', 'tech', 'technology', 'health', 'sports', 'culture', 'politics', 'world']);
  const section = sectionId ? getSectionLabel(sectionId) : (explicitSection || 'News');
  const subsection = (!genericSubsectionKeys.has(normalizeKey(explicitSubsection)) && explicitSubsection)
    ? explicitSubsection
    : (topicId ? getTopicLabel(topicId) : '');
  const normalizedArticleType = explicitArticleType.toLowerCase();
  const article_type = ['report', 'analysis', 'explainer'].includes(normalizedArticleType)
    ? normalizedArticleType
    : 'report';

  const finalTopics = uniqueStrings([...topics, subsection].filter(Boolean)).slice(0, 3);

  return {
    section,
    subsection: subsection || null,
    section_id: sectionId || null,
    topic_id: topicId || null,
    article_type,
    tags,
    topics: finalTopics,
  };
}

export function formatArticleTypeLabel(articleType) {
  const value = normalizeKey(articleType);
  if (value === 'analysis') return 'Analysis';
  if (value === 'explainer') return 'Explainer';
  return 'News Report';
}
