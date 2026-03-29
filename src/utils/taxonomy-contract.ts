// File: src/utils/taxonomy-contract.ts
// Purpose: Dynamic taxonomy contract aligned with the compiled taxonomy registry and current editorial routing.

import { getTaxonomyRegistry } from './foseer-taxonomy.js';

export type CanonicalArticleType = 'explainer' | 'analysis' | 'report';
export type SectionId = string;
export type TopicId = string;

export interface TaxonomyClassification {
  article_type: CanonicalArticleType;
  section_id: SectionId;
  topic_id: TopicId;
  confidence: number;
  classification_basis: string[];
  assignment_mode: 'auto' | 'manual';
}

export interface TopicTaxonomyCandidate {
  topic_id: TopicId;
  section_id: SectionId;
  topic_label: string;
  section_label: string;
  recommended_article_type: CanonicalArticleType;
  classification_confidence: number;
  classification_basis: string[];
  is_canonical_topic: boolean;
}

const TOPIC_KEYWORDS: Record<string, string[]> = {
  'us-politics': ['politics', 'white house', 'congress', 'senate', 'election', 'campaign', 'policy', 'supreme court', 'administration'],
  'world-geopolitics': ['war', 'diplomacy', 'military', 'ceasefire', 'missile', 'geopolitics', 'ukraine', 'russia', 'israel', 'iran', 'gaza'],
  'law-crime': ['crime', 'court', 'judge', 'arrest', 'charged', 'trial', 'lawsuit', 'investigation', 'police'],
  'climate-extreme-weather': ['climate', 'storm', 'wildfire', 'flood', 'hurricane', 'heatwave', 'tornado'],
  'society-social-trends': ['society', 'education', 'labor', 'workers', 'community', 'communities', 'demographic'],
  'economy-markets': ['economy', 'inflation', 'jobs report', 'rates', 'gdp', 'trade', 'tariff', 'market'],
  'companies-deals': ['earnings', 'profit', 'revenue', 'merger', 'acquisition', 'deal', 'ceo', 'company', 'companies'],
  'consumer-money': ['credit card', 'debt', 'loan', 'budget', 'savings', 'refund', 'fee', 'billing'],
  'housing-real-estate': ['housing', 'real estate', 'mortgage', 'rent', 'landlord', 'tenant', 'property'],
  'crypto-bitcoin': ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'token'],
  'travel-consumer-issues': ['airline', 'airport', 'tsa', 'flight', 'hotel', 'rental car', 'travel'],
  'ai-big-tech': ['ai', 'artificial intelligence', 'openai', 'google', 'meta', 'microsoft', 'nvidia', 'big tech'],
  'consumer-tech': ['consumer tech', 'device', 'gadget', 'smartphone', 'iphone', 'android', 'laptop', 'software'],
  'cybersecurity': ['cybersecurity', 'data breach', 'hack', 'ransomware', 'malware', 'security flaw'],
  'mobility-evs': ['electric vehicle', 'ev', 'tesla', 'charging', 'robotaxi', 'mobility', 'autonomous vehicle'],
  'space-astronomy': ['space', 'astronomy', 'nasa', 'rocket', 'satellite', 'launch', 'moon', 'mars'],
  'enterprise-platforms': ['cloud', 'platform', 'enterprise software', 'saas', 'infrastructure', 'developer platform'],
  'public-health': ['public health', 'outbreak', 'disease', 'virus', 'epidemic', 'hospital system', 'health agency'],
  'medical-research': ['study', 'studies', 'clinical', 'trial', 'researchers', 'treatment study', 'medical research'],
  'pharma-fda': ['fda', 'drug approval', 'pharma', 'pharmaceutical', 'drugmaker', 'recall', 'biotech'],
  'mental-health': ['mental health', 'anxiety', 'depression', 'therapy', 'stress'],
  'wellness-fitness': ['wellness', 'fitness', 'exercise', 'nutrition', 'sleep', 'workout'],
  'major-leagues': ['nfl', 'nba', 'mlb', 'nhl', 'premier league', 'league standings', 'baseball', 'basketball'],
  'events-tournaments': ['tournament', 'world cup', 'olympics', 'playoffs', 'championship', 'grand slam'],
  'transfers-business': ['transfer', 'trade', 'contract extension', 'media rights', 'ownership group', 'sports business'],
  'athletes-culture': ['athlete', 'athletes', 'fans', 'fandom', 'locker room', 'sports culture'],
  'film-tv': ['film', 'movie', 'movies', 'tv', 'television', 'streaming', 'series', 'box office'],
  'music-celebrities': ['music', 'album', 'tour', 'artist', 'celebrity', 'celebrities', 'awards show'],
  'internet-culture': ['internet culture', 'viral', 'meme', 'online discourse', 'reddit', 'social media'],
  'creators-platforms': ['youtube', 'instagram', 'tiktok', 'twitch', 'creator economy', 'creator', 'creators', 'influencer'],
};

const DEFAULT_TOPIC_BY_SECTION: Record<string, string> = {
  news: 'us-politics',
  business: 'economy-markets',
  tech: 'ai-big-tech',
  health: 'public-health',
  sports: 'major-leagues',
  culture: 'film-tv',
};

function normalizeText(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseMatches(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  const regex = new RegExp(`(^|\\b)${escapeRegex(normalizedPhrase).replace(/ /g, '\\s+')}(\\b|$)`, 'i');
  return regex.test(text);
}

function getRegistry() {
  return getTaxonomyRegistry();
}

function normalizeTopicId(topicId: string): string {
  return getRegistry().legacyMappings?.topics?.[topicId] || topicId;
}

function getSectionsMap(): Map<string, { id: string; title: string }> {
  return new Map(getRegistry().sections.map((section) => [section.id, { id: section.id, title: section.label }]));
}

function getTopicsMap(): Map<string, { id: string; title: string; sectionId: string; description?: string }> {
  return new Map(getRegistry().topics.map((topic) => [topic.id, { id: topic.id, title: topic.label, sectionId: topic.section_id, description: topic.description }]));
}

function inferSectionFromDeskHint(deskHint?: string): string | null {
  const desk = normalizeText(deskHint || '');
  if (!desk) return null;
  const registry = getRegistry();
  if (registry.legacyMappings?.sections?.[desk]) return registry.legacyMappings.sections[desk];
  if (getSectionsMap().has(desk)) return desk;
  return null;
}

export function isValidSectionId(id: string): id is SectionId {
  return getSectionsMap().has(id);
}

export function isValidTopicId(id: string): id is TopicId {
  return getTopicsMap().has(normalizeTopicId(id));
}

export function getSectionForTopic(topicId: TopicId): SectionId {
  const topic = getTopicsMap().get(normalizeTopicId(topicId));
  return topic?.sectionId || 'news';
}

export function getTopicsForSection(sectionId: SectionId): TopicId[] {
  return getRegistry().topicsBySection?.[sectionId] || [];
}

function getTopicInfo(topicId: string): { label: string; description?: string } {
  const topic = getTopicsMap().get(normalizeTopicId(topicId));
  return {
    label: topic?.title || normalizeTopicId(topicId),
    description: topic?.description,
  };
}

function getSectionLabel(sectionId: string): string {
  return getSectionsMap().get(sectionId)?.title || sectionId;
}

function inferArticleTypeFromTopic(topicId: string, signalTitle: string): CanonicalArticleType {
  const title = normalizeText(signalTitle);
  if (/\b(explained|guide|what is|how to|overview|why it matters)\b/.test(title)) return 'explainer';
  if (/\b(breaking|latest|announced|launches|released|update|files|today|warns|says)\b/.test(title)) return 'report';

  const reportTopics = new Set(getRegistry().writerHints?.reportTopicIds || ['us-politics', 'world-geopolitics', 'law-crime', 'climate-extreme-weather']);
  return reportTopics.has(normalizeTopicId(topicId)) ? 'report' : 'analysis';
}

export function classifyTopicFromSignal(signalTitle: string, signalSummary?: string, deskHint?: string): TopicTaxonomyCandidate {
  const combinedText = normalizeText(`${signalTitle} ${signalSummary || ''}`);
  const topicsMap = getTopicsMap();

  let bestMatch: { topicId: string; score: number; matchedKeywords: string[] } | null = null;
  for (const [topicId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const matchedKeywords = keywords.filter((keyword) => phraseMatches(combinedText, keyword));
    const score = matchedKeywords.length;
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { topicId, score, matchedKeywords };
    }
  }

  if (!bestMatch) {
    const hintedSection = inferSectionFromDeskHint(deskHint);
    const fallbackTopic = DEFAULT_TOPIC_BY_SECTION[hintedSection || 'news'] || 'us-politics';
    const topicInfo = getTopicInfo(fallbackTopic);
    return {
      topic_id: fallbackTopic,
      section_id: getSectionForTopic(fallbackTopic),
      topic_label: topicInfo.label,
      section_label: getSectionLabel(getSectionForTopic(fallbackTopic)),
      recommended_article_type: inferArticleTypeFromTopic(fallbackTopic, signalTitle),
      classification_confidence: hintedSection ? 3.5 : 2,
      classification_basis: [hintedSection ? `Fallback from desk hint: ${deskHint}` : 'Fallback: no direct taxonomy keyword match'],
      is_canonical_topic: topicsMap.has(fallbackTopic),
    };
  }

  const normalizedTopicId = normalizeTopicId(bestMatch.topicId);
  const sectionId = getSectionForTopic(normalizedTopicId);
  const topicInfo = getTopicInfo(normalizedTopicId);

  return {
    topic_id: normalizedTopicId,
    section_id: sectionId,
    topic_label: topicInfo.label,
    section_label: getSectionLabel(sectionId),
    recommended_article_type: inferArticleTypeFromTopic(normalizedTopicId, signalTitle),
    classification_confidence: Math.min(10, 4 + bestMatch.score),
    classification_basis: bestMatch.matchedKeywords.map((keyword) => `Matched taxonomy keyword: ${keyword}`),
    is_canonical_topic: topicsMap.has(normalizedTopicId),
  };
}

export function buildTaxonomyClassification(input: {
  signalTitle: string;
  signalSummary?: string;
  deskHint?: string;
  articleTypeHint?: CanonicalArticleType;
}): TaxonomyClassification {
  const candidate = classifyTopicFromSignal(input.signalTitle, input.signalSummary, input.deskHint);
  return {
    article_type: input.articleTypeHint || candidate.recommended_article_type,
    section_id: candidate.section_id,
    topic_id: candidate.topic_id,
    confidence: candidate.classification_confidence,
    classification_basis: candidate.classification_basis,
    assignment_mode: 'auto',
  };
}
