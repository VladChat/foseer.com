// File: qwen-scripts/compile-tag-registry.js
// Purpose: Build the canonical controlled-vocabulary tag registry from taxonomy and approved tag definitions.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const TAXONOMY_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/contracts/taxonomy-registry.json');
const TAG_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data/contracts/tag-registry.json');

const TOPIC_THEME_MAP = {
  'us-politics': ['congress', 'white-house', 'supreme-court', 'federal-policy', 'election-law'],
  'world-geopolitics': ['diplomacy', 'military-conflict', 'border-security'],
  'law-crime': ['criminal-investigation'],
  'climate-extreme-weather': ['wildfire', 'hurricane', 'flooding', 'heat-wave'],
  'society-social-trends': ['labor-strike', 'education-policy'],
  'economy-markets': ['inflation', 'interest-rates', 'jobs-report', 'stock-market', 'wall-street'],
  'companies-deals': ['earnings', 'merger', 'bankruptcy', 'layoffs'],
  'consumer-money': ['consumer-debt', 'credit-cards'],
  'housing-real-estate': ['mortgage-rates', 'home-prices', 'rent', 'mortgages'],
  'crypto-bitcoin': ['bitcoin'],
  'travel-consumer-issues': ['airport-security', 'government-shutdown', 'travel-delays', 'airline-fees'],
  'ai-big-tech': ['artificial-intelligence', 'semiconductors', 'antitrust'],
  'consumer-tech': ['smartphones', 'wearables'],
  'cybersecurity': ['privacy', 'data-breach', 'ransomware'],
  'mobility-evs': ['electric-vehicles', 'charging-network', 'autonomous-driving'],
  'space-astronomy': ['rocket-launch', 'satellite'],
  'enterprise-platforms': ['cloud-computing', 'software-platforms'],
  'public-health': ['outbreak', 'hospital-system', 'medicare', 'health-insurance'],
  'medical-research': ['medical-study', 'clinical-trial', 'pediatric-care'],
  'pharma-fda': ['drug-approval', 'rare-disease', 'biotech', 'therapy-access'],
  'mental-health': ['depression', 'anxiety'],
  'wellness-fitness': ['nutrition', 'sleep', 'exercise'],
  'major-leagues': ['mlb', 'nba', 'baseball', 'basketball', 'nfl', 'nhl', 'soccer', 'media-rights', 'attendance'],
  'events-tournaments': ['playoffs', 'world-cup', 'olympics'],
  'transfers-business': ['trade-rumors', 'free-agency', 'franchise-value'],
  'athletes-culture': ['athlete-activism', 'fan-culture'],
  'film-tv': ['streaming', 'box-office', 'franchise', 'awards-season'],
  'music-celebrities': ['concert-tour', 'celebrity-scandal'],
  'internet-culture': ['viral-trend', 'meme-culture'],
  'creators-platforms': ['influencer-economy', 'creator-monetization', 'platform-moderation', 'youtube', 'tiktok', 'instagram', 'podcasting', 'social-media'],
};

const THEME_DEFINITIONS = [
  ['congress', 'Congress', ['Congress', 'House', 'Senate']],
  ['white-house', 'White House', ['White House']],
  ['supreme-court', 'Supreme Court', ['Supreme Court', 'High Court']],
  ['federal-policy', 'Federal Policy', ['federal policy']],
  ['election-law', 'Election Law', ['election law', 'ballot law']],
  ['diplomacy', 'Diplomacy', ['diplomacy', 'diplomatic']],
  ['military-conflict', 'Military Conflict', ['military conflict', 'armed conflict', 'battlefield']],
  ['border-security', 'Border Security', ['border security', 'border enforcement']],
  ['criminal-investigation', 'Criminal Investigation', ['criminal investigation', 'investigation']],
  ['wildfire', 'Wildfire', ['wildfire', 'wildfires']],
  ['hurricane', 'Hurricane', ['hurricane', 'storm surge']],
  ['flooding', 'Flooding', ['flooding', 'flood']],
  ['heat-wave', 'Heat Wave', ['heat wave', 'heatwave']],
  ['labor-strike', 'Labor Strike', ['labor strike', 'worker strike', 'walkout']],
  ['education-policy', 'Education Policy', ['education policy', 'school policy']],
  ['inflation', 'Inflation', ['inflation']],
  ['interest-rates', 'Interest Rates', ['interest rates', 'rate cut', 'rate hike']],
  ['jobs-report', 'Jobs Report', ['jobs report', 'employment report']],
  ['stock-market', 'Stock Market', ['stock market', 'stocks']],
  ['earnings', 'Earnings', ['earnings', 'quarterly results']],
  ['merger', 'Merger', ['merger', 'acquisition', 'takeover']],
  ['bankruptcy', 'Bankruptcy', ['bankruptcy']],
  ['layoffs', 'Layoffs', ['layoffs', 'job cuts']],
  ['consumer-debt', 'Consumer Debt', ['consumer debt', 'household debt']],
  ['credit-cards', 'Credit Cards', ['credit cards', 'credit card']],
  ['mortgage-rates', 'Mortgage Rates', ['mortgage rates', 'home loan rates']],
  ['home-prices', 'Home Prices', ['home prices', 'house prices']],
  ['rent', 'Rent', ['rent', 'rents', 'rental costs']],
  ['bitcoin', 'Bitcoin', ['bitcoin']],
  ['airport-security', 'Airport Security', ['airport security', 'tsa', 'aviation security']],
  ['government-shutdown', 'Government Shutdown', ['government shutdown', 'shutdown']],
  ['travel-delays', 'Travel Delays', ['travel delays', 'flight delays', 'airport delays']],
  ['airline-fees', 'Airline Fees', ['airline fees', 'baggage fees', 'ticket fees']],
  ['artificial-intelligence', 'Artificial Intelligence', ['artificial intelligence', 'generative ai', 'ai']],
  ['semiconductors', 'Semiconductors', ['semiconductors', 'chips', 'chipmaking']],
  ['antitrust', 'Antitrust', ['antitrust', 'competition law']],
  ['privacy', 'Privacy', ['privacy', 'data privacy']],
  ['data-breach', 'Data Breach', ['data breach', 'data leak']],
  ['ransomware', 'Ransomware', ['ransomware']],
  ['smartphones', 'Smartphones', ['smartphones', 'smartphone']],
  ['wearables', 'Wearables', ['wearables', 'smartwatch']],
  ['electric-vehicles', 'Electric Vehicles', ['electric vehicles', 'electric vehicle', 'evs', 'ev']],
  ['charging-network', 'Charging Network', ['charging network', 'charger network']],
  ['autonomous-driving', 'Autonomous Driving', ['autonomous driving', 'self-driving', 'robotaxi']],
  ['rocket-launch', 'Rocket Launch', ['rocket launch', 'launch vehicle']],
  ['satellite', 'Satellite', ['satellite', 'satellites']],
  ['cloud-computing', 'Cloud Computing', ['cloud computing', 'cloud services']],
  ['software-platforms', 'Software Platforms', ['software platforms', 'software platform', 'developer platform']],
  ['outbreak', 'Outbreak', ['outbreak', 'epidemic']],
  ['hospital-system', 'Hospital System', ['hospital system', 'hospital systems']],
  ['medical-study', 'Medical Study', ['medical study', 'medical studies', 'new study']],
  ['clinical-trial', 'Clinical Trial', ['clinical trial', 'clinical trials']],
  ['pediatric-care', 'Pediatric Care', ['pediatric care', 'children', 'child patients']],
  ['drug-approval', 'Drug Approval', ['drug approval', 'fda approval', 'cleared by the fda']],
  ['rare-disease', 'Rare Disease', ['rare disease', 'orphan disease']],
  ['biotech', 'Biotech', ['biotech', 'biotechnology']],
  ['therapy-access', 'Therapy Access', ['therapy access', 'patient access', 'treatment access']],
  ['depression', 'Depression', ['depression']],
  ['anxiety', 'Anxiety', ['anxiety']],
  ['nutrition', 'Nutrition', ['nutrition', 'diet']],
  ['sleep', 'Sleep', ['sleep']],
  ['exercise', 'Exercise', ['exercise', 'workout', 'fitness routine']],
  ['mlb', 'MLB', ['mlb', 'major league baseball']],
  ['nba', 'NBA', ['nba', 'national basketball association']],
  ['nfl', 'NFL', ['nfl', 'national football league']],
  ['nhl', 'NHL', ['nhl', 'national hockey league']],
  ['soccer', 'Soccer', ['soccer', 'football club']],
  ['baseball', 'Baseball', ['baseball', 'major league baseball']],
  ['basketball', 'Basketball', ['basketball', 'pro basketball', 'national basketball association']],
  ['playoffs', 'Playoffs', ['playoffs', 'postseason']],
  ['world-cup', 'World Cup', ['world cup']],
  ['olympics', 'Olympics', ['olympics', 'olympic']],
  ['trade-rumors', 'Trade Rumors', ['trade rumors', 'trade talk']],
  ['free-agency', 'Free Agency', ['free agency', 'free agent']],
  ['media-rights', 'Media Rights', ['media rights', 'broadcast rights', 'tv rights']],
  ['attendance', 'Attendance', ['attendance', 'crowd size']],
  ['franchise-value', 'Franchise Value', ['franchise value', 'team valuation']],
  ['athlete-activism', 'Athlete Activism', ['athlete activism', 'player activism']],
  ['fan-culture', 'Fan Culture', ['fan culture', 'fandom']],
  ['streaming', 'Streaming', ['streaming']],
  ['box-office', 'Box Office', ['box office']],
  ['franchise', 'Franchise', ['franchise', 'franchise film']],
  ['awards-season', 'Awards Season', ['awards season', 'award season']],
  ['concert-tour', 'Concert Tour', ['concert tour', 'world tour']],
  ['celebrity-scandal', 'Celebrity Scandal', ['celebrity scandal', 'celebrity controversy']],
  ['viral-trend', 'Viral Trend', ['viral trend', 'viral trends']],
  ['meme-culture', 'Meme Culture', ['meme culture', 'memes']],
  ['influencer-economy', 'Influencer Economy', ['influencer economy', 'creator economy']],
  ['creator-monetization', 'Creator Monetization', ['creator monetization', 'creator revenue']],
  ['platform-moderation', 'Platform Moderation', ['platform moderation', 'content moderation']],
  ['youtube', 'YouTube', ['youtube']],
  ['tiktok', 'TikTok', ['tiktok', 'tik tok']],
  ['instagram', 'Instagram', ['instagram']],
  ['podcasting', 'Podcasting', ['podcasting', 'podcast']],
  ['wall-street', 'Wall Street', ['wall street', 'market opens', 'market open', 'pre-market', 'premarket']],
  ['mortgages', 'Mortgages', ['mortgages', 'mortgage']],
  ['medicare', 'Medicare', ['medicare']],
  ['health-insurance', 'Health Insurance', ['health insurance', 'insurance coverage', 'coverage loss', 'coverage']],
  ['social-media', 'Social Media', ['social media', 'social platform', 'social platforms']],
];

const ENTITY_DEFINITIONS = [
  ['fda', 'FDA', ['fda']],
  ['cdc', 'CDC', ['cdc']],
  ['nih', 'NIH', ['nih']],
  ['white-house-entity', 'White House', ['white house']],
  ['congress-entity', 'Congress', ['congress', 'senate', 'house']],
  ['supreme-court-entity', 'Supreme Court', ['supreme court', 'high court']],
  ['pentagon', 'Pentagon', ['pentagon']],
  ['doj', 'DOJ', ['doj', 'justice department']],
  ['ftc', 'FTC', ['ftc', 'federal trade commission']],
  ['sec', 'SEC', ['sec', 'securities and exchange commission']],
  ['apple', 'Apple', ['apple']],
  ['google', 'Google', ['google']],
  ['meta', 'Meta', ['meta', 'facebook']],
  ['microsoft', 'Microsoft', ['microsoft']],
  ['openai', 'OpenAI', ['openai']],
  ['nvidia', 'Nvidia', ['nvidia']],
  ['tesla', 'Tesla', ['tesla']],
  ['amazon', 'Amazon', ['amazon']],
  ['pfizer', 'Pfizer', ['pfizer']],
  ['moderna', 'Moderna', ['moderna']],
  ['denali-therapeutics', 'Denali Therapeutics', ['denali therapeutics', 'denali']],
  ['mlb-entity', 'MLB', ['mlb', 'major league baseball']],
  ['nba-entity', 'NBA', ['nba', 'national basketball association']],
  ['nfl-entity', 'NFL', ['nfl', 'national football league']],
  ['nhl-entity', 'NHL', ['nhl', 'national hockey league']],
  ['fifa', 'FIFA', ['fifa']],
  ['olympics-entity', 'Olympics', ['olympics', 'olympic']],
  ['disney', 'Disney', ['disney']],
  ['netflix', 'Netflix', ['netflix']],
  ['youtube-entity', 'YouTube', ['youtube']],
  ['tiktok-entity', 'TikTok', ['tiktok', 'tik tok']],
  ['spotify', 'Spotify', ['spotify']],
  ['tsa', 'TSA', ['tsa', 'transportation security administration']],
];

const GEOGRAPHY_DEFINITIONS = [
  ['united-states', 'United States', ['united states', 'u.s.', 'us']],
  ['china', 'China', ['china']],
  ['europe', 'Europe', ['europe', 'european union', 'eu']],
  ['russia', 'Russia', ['russia']],
  ['ukraine', 'Ukraine', ['ukraine']],
  ['middle-east', 'Middle East', ['middle east']],
  ['israel', 'Israel', ['israel']],
  ['gaza', 'Gaza', ['gaza']],
  ['united-kingdom', 'United Kingdom', ['united kingdom', 'uk', 'britain']],
  ['canada', 'Canada', ['canada']],
  ['california', 'California', ['california']],
  ['new-york', 'New York', ['new york']],
  ['washington', 'Washington', ['washington']],
  ['florida', 'Florida', ['florida']],
  ['texas', 'Texas', ['texas']],
];

const FORMAT_DEFINITIONS = [
  ['analysis', 'Analysis', ['analysis']],
  ['explainer', 'Explainer', ['explainer']],
  ['timeline', 'Timeline', ['timeline']],
  ['live-updates', 'Live Updates', ['live updates', 'live coverage']],
];


const TOPIC_ALIAS_ENRICHMENTS = {
  'economy-markets': ['market', 'market opening', 'market opens', 'pre-market', 'premarket', 'wall street'],
  'housing-real-estate': ['mortgage', 'mortgages'],
  'public-health': ['health coverage', 'insurance coverage', 'medicare'],
  'creators-platforms': ['social media'],
  'major-leagues': ['mlb', 'nba', 'major league baseball', 'national basketball association', 'baseball', 'basketball'],
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildTag(tagId, label, type, aliases = [], sectionIds = [], topicIds = [], extra = {}) {
  return {
    tag_id: tagId,
    slug: slugify(tagId || label),
    label,
    type,
    section_ids: Array.from(new Set(sectionIds.filter(Boolean))),
    topic_ids: Array.from(new Set(topicIds.filter(Boolean))),
    aliases: Array.from(new Set([label, ...(aliases || [])].filter(Boolean))),
    indexable: extra.indexable !== false,
    priority: extra.priority || (type === 'topic' ? 100 : type === 'theme' ? 80 : type === 'entity' ? 60 : 40),
    min_posts_to_index: extra.min_posts_to_index || (type === 'topic' ? 1 : type === 'theme' ? 3 : type === 'entity' ? 4 : 999),
    related_tags: Array.from(new Set(extra.related_tags || [])),
  };
}

export function buildTagRegistry() {
  const taxonomy = readJson(TAXONOMY_REGISTRY_PATH);
  const tags = [];
  const topicTagByTopicId = {};
  const themeTagSlugsByTopicId = {};
  const entityTagSlugsByTopicId = {};

  for (const topic of taxonomy.topics || []) {
    const tag = buildTag(topic.id, topic.label, 'topic', [topic.slug, ...(topic.aliases || []), ...(TOPIC_ALIAS_ENRICHMENTS[topic.id] || [])], [topic.section_id], [topic.id], { priority: 100, min_posts_to_index: 1 });
    tags.push(tag);
    topicTagByTopicId[topic.id] = tag.slug;
  }

  const themeTagsBySlug = new Map();
  for (const [tagId, label, aliases] of THEME_DEFINITIONS) {
    const topicIds = Object.entries(TOPIC_THEME_MAP).filter(([, values]) => values.includes(tagId)).map(([topicId]) => topicId);
    const sectionIds = Array.from(new Set(topicIds.map((topicId) => taxonomy.sectionByTopic?.[topicId]).filter(Boolean)));
    const tag = buildTag(tagId, label, 'theme', aliases, sectionIds, topicIds, { min_posts_to_index: 3 });
    tags.push(tag);
    themeTagsBySlug.set(tag.slug, tag);
    for (const topicId of topicIds) {
      if (!themeTagSlugsByTopicId[topicId]) themeTagSlugsByTopicId[topicId] = [];
      themeTagSlugsByTopicId[topicId].push(tag.slug);
    }
  }

  const entityTopicHints = {
    'ai-big-tech': ['openai', 'google', 'meta', 'microsoft', 'nvidia', 'apple', 'amazon'],
    'consumer-tech': ['apple', 'google', 'meta', 'microsoft', 'youtube-entity', 'tiktok-entity'],
    'cybersecurity': ['microsoft', 'google', 'doj', 'ftc'],
    'mobility-evs': ['tesla'],
    'major-leagues': ['mlb-entity', 'nba-entity', 'nfl-entity', 'nhl-entity'],
    'events-tournaments': ['fifa', 'olympics-entity'],
    'transfers-business': ['mlb-entity', 'nba-entity', 'nfl-entity', 'nhl-entity'],
    'film-tv': ['disney', 'netflix'],
    'music-celebrities': ['spotify'],
    'creators-platforms': ['youtube-entity', 'tiktok-entity', 'instagram', 'spotify'],
  };

  for (const [tagId, label, aliases] of ENTITY_DEFINITIONS) {
    const topicIds = Object.entries(entityTopicHints).filter(([, values]) => values.includes(tagId)).map(([topicId]) => topicId);
    const sectionIds = Array.from(new Set(topicIds.map((topicId) => taxonomy.sectionByTopic?.[topicId]).filter(Boolean)));
    const tag = buildTag(tagId, label, 'entity', aliases, sectionIds, topicIds, { indexable: false, min_posts_to_index: 4 });
    tags.push(tag);
    for (const topicId of topicIds) {
      if (!entityTagSlugsByTopicId[topicId]) entityTagSlugsByTopicId[topicId] = [];
      entityTagSlugsByTopicId[topicId].push(tag.slug);
    }
  }

  const geographyTagSlugs = [];
  for (const [tagId, label, aliases] of GEOGRAPHY_DEFINITIONS) {
    const tag = buildTag(tagId, label, 'geography', aliases, [], [], { indexable: false, min_posts_to_index: 999 });
    tags.push(tag);
    geographyTagSlugs.push(tag.slug);
  }

  const formatTagSlugs = [];
  for (const [tagId, label, aliases] of FORMAT_DEFINITIONS) {
    const tag = buildTag(tagId, label, 'format', aliases, [], [], { indexable: false, min_posts_to_index: 999 });
    tags.push(tag);
    formatTagSlugs.push(tag.slug);
  }

  const bySlug = Object.fromEntries(tags.map((tag) => [tag.slug, tag]));
  const byType = tags.reduce((acc, tag) => {
    if (!acc[tag.type]) acc[tag.type] = [];
    acc[tag.type].push(tag);
    return acc;
  }, { topic: [], theme: [], entity: [], geography: [], format: [] });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source_taxonomy_registry: 'qwen-data/contracts/taxonomy-registry.json',
    tags,
    topicTagByTopicId,
    themeTagSlugsByTopicId,
    entityTagSlugsByTopicId,
    geographyTagSlugs,
    formatTagSlugs,
    bySlug,
    byType,
  };
}

export function writeTagRegistry() {
  const registry = buildTagRegistry();
  fs.mkdirSync(path.dirname(TAG_REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(TAG_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
  console.log(`[tag-registry] Wrote ${registry.tags.length} canonical tags to ${TAG_REGISTRY_PATH}`);
  return registry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeTagRegistry();
}
