// File: qwen-scripts/utils/image-query-builder.js
// Purpose: Build safer online image-search queries from title and publish-ready source evidence.

const PLACEHOLDER_TERMS = new Set([
  'unspecified', 'general', 'analysis', 'report', 'explainer', 'standard', 'latest', 'breaking',
  'featured', 'story', 'article', 'news', 'photo', 'image', 'images', 'editorial', 'coverage',
  'update', 'updates', 'live', 'desk', 'section', 'topic', 'headline', 'overview',
  'research', 'study', 'studies', 'report', 'reports', 'company', 'companies', 'outlines',
]);

const GENERIC_SECTION_TERMS = new Set([
  'news', 'business', 'tech', 'technology', 'health', 'sports', 'culture',
]);

const SHORT_ENTITY_ALLOWLIST = new Set([
  'ai', 'mlb', 'nba', 'nfl', 'nhl', 'wnba', 'mls', 'ufc', 'pga', 'fda', 'cdc', 'sec', 'ftc',
  'irs', 'epa', 'fcc', 'eu', 'uk', 'us', 'usa', 'who', 'kpmg', 'tiktok', 'tesla', 'meta',
]);

const LEAKY_ENTITY_TERMS = new Set([
  'analysis', 'breaking', 'coverage', 'creators', 'platforms', 'economy', 'markets', 'mental', 'health',
  'cybersecurity', 'technology', 'tech', 'sports', 'culture', 'news', 'business', 'world', 'geopolitics',
]);


const QUESTION_LEAD_TERMS = new Set(['has', 'have', 'what', 'why', 'how', 'is', 'are', 'was', 'were', 'can', 'will', 'did', 'does', 'do', 'should', 'could']);

const TITLE_SUBJECT_STOPWORDS = new Set([
  ...PLACEHOLDER_TERMS,
  'has', 'have', 'what', 'why', 'how', 'is', 'are', 'was', 'were', 'can', 'will', 'did', 'does', 'do',
  'should', 'could', 'would', 'may', 'might', 'after', 'before', 'amid', 'behind', 'about', 'over', 'under',
  'against', 'with', 'from', 'into', 'onto', 'says', 'said', 'say', 'make', 'makes', 'made', 'still', 'new',
  'arrested', 'charge', 'charges', 'faces', 'support', 'supports', 'supported', 'overtaken', 'dominates', 'durable',
  'research', 'study', 'studies', 'company', 'companies', 'outlines', 'ways', 'less', 'more', 'next', 'year', 'years', 'plan', 'plans', 'could', 'addictive',
]);

const PERSON_ROLE_HINTS = [
  'athlete', 'player', 'golfer', 'singer', 'artist', 'actor', 'actress', 'director', 'celebrity',
  'president', 'minister', 'senator', 'speaker', 'founder', 'executive', 'ceo', 'coach',
];


const NON_PERSON_ENTITY_TOKENS = new Set([
  'media', 'platform', 'platforms', 'company', 'companies', 'market', 'markets', 'coverage', 'policy', 'plans', 'health',
  'economy', 'mortgage', 'bitcoin', 'crypto', 'research', 'study', 'social', 'teens', 'seniors', 'insurance',
]);

const SECTION_FALLBACK_QUERIES = {
  News: ['government podium photo', 'press conference photo'],
  Business: ['financial district photo', 'business office photo'],
  Tech: ['technology office photo', 'computer hardware photo'],
  Health: ['medical research photo', 'hospital corridor photo'],
  Sports: ['sports arena photo', 'athlete portrait'],
  Culture: ['concert stage photo', 'film set photo'],
};

const CONTEXT_QUERY_RULES = [
  { keywords: ['mortgage', 'mortgages', 'housing', 'loan', 'homebuyer', 'fannie mae', 'freddie mac'], phrase: 'mortgage' },
  { keywords: ['crypto', 'bitcoin', 'stablecoin', 'token', 'tether'], phrase: 'crypto' },
  { keywords: ['audit', 'auditor', 'kpmg', 'accounting'], phrase: 'audit' },
  { keywords: ['baseball', 'mlb'], phrase: 'baseball' },
  { keywords: ['basketball', 'nba', 'wnba'], phrase: 'basketball' },
  { keywords: ['football', 'nfl'], phrase: 'football' },
  { keywords: ['hockey', 'nhl'], phrase: 'hockey' },
  { keywords: ['golf', 'pga', 'masters'], phrase: 'golf' },
  { keywords: ['music', 'singer', 'album', 'concert', 'tour', 'diva'], phrase: 'concert' },
  { keywords: ['film', 'tv', 'television', 'movie', 'series', 'streaming', 'actor', 'director'], phrase: 'film' },
  { keywords: ['court', 'lawsuit', 'judge', 'trial', 'legal', 'verdict'], phrase: 'courtroom' },
  { keywords: ['fda', 'doctor', 'medical', 'hospital', 'health', 'clinic', 'drug'], phrase: 'medical' },
  { keywords: ['chip', 'software', 'cloud', 'ai', 'technology', 'cybersecurity'], phrase: 'technology' },
  { keywords: ['white house', 'president', 'senate', 'government', 'administration'], phrase: 'government' },
];

const ENTITY_EXPANSIONS = {
  mlb: ['baseball'],
  nba: ['basketball'],
  wnba: ['basketball'],
  nfl: ['football'],
  nhl: ['hockey'],
  pga: ['golf'],
  tether: ['crypto'],
  'fannie mae': ['mortgage'],
  'freddie mac': ['mortgage'],
  who: ['health'],
  fda: ['medical'],
};

function normalizeText(value) {
  return String(value || '')
    .replace(/[’']/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueValues(values = []) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const label = normalizeText(value);
    const key = normalizeKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    output.push(label);
  }
  return output;
}

function tokenize(value) {
  return normalizeKey(value).split(/\s+/).filter(Boolean);
}

function isPlaceholderPhrase(value) {
  const key = normalizeKey(value);
  if (!key) return true;
  if (PLACEHOLDER_TERMS.has(key)) return true;
  if (GENERIC_SECTION_TERMS.has(key)) return true;
  return false;
}


function isBroadTopicAlias(value) {
  const key = normalizeKey(value);
  if (!key) return true;
  return [
    'u s politics policy', 'u s politics and policy', 'world geopolitics', 'economy and markets',
    'climate and extreme weather', 'business', 'technology', 'tech', 'health', 'sports', 'culture', 'news',
  ].includes(key);
}

function containsKeyword(evidenceKey, keyword) {
  const normalizedKeyword = normalizeKey(keyword);
  if (!evidenceKey || !normalizedKeyword) return false;
  const evidenceTokens = new Set(evidenceKey.split(' ').filter(Boolean));
  const parts = normalizedKeyword.split(' ').filter(Boolean);
  if (parts.length === 1) return evidenceTokens.has(parts[0]);
  if (evidenceKey.includes(normalizedKeyword)) return true;
  return parts.every((part) => evidenceTokens.has(part));
}

function phraseSupportedInEvidence(evidenceKey, phrase) {
  const normalizedPhrase = normalizeKey(phrase);
  if (!evidenceKey || !normalizedPhrase) return false;
  return containsKeyword(evidenceKey, normalizedPhrase);
}

function isUsefulSingleToken(token) {
  if (!token) return false;
  if (SHORT_ENTITY_ALLOWLIST.has(token)) return true;
  return token.length >= 4;
}

function scoreEntityPhrase(phrase, evidence = {}) {
  const key = normalizeKey(phrase);
  if (!key || isPlaceholderPhrase(phrase) || LEAKY_ENTITY_TERMS.has(key)) return -1;
  const parts = key.split(' ').filter(Boolean);
  if (parts.length === 1 && !isUsefulSingleToken(parts[0])) return -1;

  const titleSupport = phraseSupportedInEvidence(evidence.titleKey, key);
  const sourceSupport = phraseSupportedInEvidence(evidence.sourceTitleKey, key);
  const bodySupport = phraseSupportedInEvidence(evidence.bodyKey, key);
  if (!titleSupport && !sourceSupport && parts.length === 1 && SHORT_ENTITY_ALLOWLIST.has(parts[0])) return -1;

  let score = 0;
  if (titleSupport) score += 7;
  if (sourceSupport) score += 6;
  if (bodySupport && (titleSupport || sourceSupport)) score += 2;
  if (parts.length >= 2) score += 2;
  if (parts.length === 1 && SHORT_ENTITY_ALLOWLIST.has(parts[0]) && (titleSupport || sourceSupport)) score += 1;
  return score;
}

function cleanTitleWord(word) {
  return String(word || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function isCandidateEntityWord(word) {
  const cleaned = cleanTitleWord(word);
  if (!cleaned) return false;
  if (/^[A-Z]{2,}$/.test(cleaned)) return true;
  if (/^[A-Z][a-z]+$/.test(cleaned)) return true;
  return false;
}

function extractTitledPhrases(text) {
  const rawWords = normalizeText(text).split(/\s+/).filter(Boolean);
  const phrases = [];
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    const phrase = buffer.join(' ').trim();
    const key = normalizeKey(phrase);
    const first = key.split(' ')[0] || '';
    if (phrase && !isPlaceholderPhrase(phrase) && !QUESTION_LEAD_TERMS.has(first)) {
      phrases.push(phrase);
    }
    buffer = [];
  };

  for (const word of rawWords) {
    const cleaned = cleanTitleWord(word);
    const lower = cleaned.toLowerCase();
    if (!buffer.length && QUESTION_LEAD_TERMS.has(lower)) {
      continue;
    }
    if (['of', 'and', 'the', 'for', 'vs', 'v'].includes(lower) && buffer.length > 0) {
      buffer.push(cleaned);
      continue;
    }
    if (isCandidateEntityWord(cleaned)) {
      buffer.push(cleaned);
      if (buffer.length >= 3) flush();
      continue;
    }
    flush();
  }
  flush();
  return uniqueValues(phrases).filter((value) => !isPlaceholderPhrase(value));
}

function buildSourceEvidence(sourcePackSources = []) {
  const titles = uniqueValues((sourcePackSources || []).map((source) => source?.title).filter(Boolean));
  const summaries = uniqueValues(
    (sourcePackSources || [])
      .flatMap((source) => [source?.summary, source?.snippet, ...(Array.isArray(source?.entities) ? source.entities : [])])
      .filter(Boolean)
  );

  return {
    sourceTitles: titles,
    sourceTitlesText: titles.join(' | '),
    sourceBodiesText: summaries.join(' | '),
  };
}

function sanitizeGeoHints(geoHints = [], evidenceKey = '') {
  const output = [];
  for (const value of uniqueValues(geoHints)) {
    const key = normalizeKey(value);
    if (!key || isPlaceholderPhrase(key)) continue;
    if (!phraseSupportedInEvidence(evidenceKey, key) && key.length < 4) continue;
    output.push(value);
    if (output.length >= 3) break;
  }
  return output;
}

function sanitizeEntityHints(entityHints = [], evidence, geoHints = []) {
  const geoKeys = new Set(uniqueValues(geoHints).map((value) => normalizeKey(value)).filter(Boolean));
  const candidates = [
    ...extractTitledPhrases(evidence.titleOriginal).map((phrase, index) => ({ phrase, origin: 'title', order: index })),
    ...extractTitledPhrases(evidence.sourceTitlesText).map((phrase, index) => ({ phrase, origin: 'source', order: 100 + index })),
    ...uniqueValues(entityHints).map((phrase, index) => ({ phrase, origin: 'hint', order: 200 + index })),
  ];

  const ranked = candidates
    .map((entry) => {
      const key = normalizeKey(entry.phrase);
      if (!key || geoKeys.has(key)) return null;
      if (QUESTION_LEAD_TERMS.has(key.split(' ')[0] || '')) return null;
      const titleSupport = phraseSupportedInEvidence(evidence.titleKey, key);
      const sourceSupport = phraseSupportedInEvidence(evidence.sourceTitleKey, key);
      const support = entry.origin === 'hint'
        ? (titleSupport || sourceSupport)
        : (titleSupport || sourceSupport || (entry.origin !== 'title' && phraseSupportedInEvidence(evidence.bodyKey, key)));
      if (!support) return null;
      return { ...entry, score: scoreEntityPhrase(entry.phrase, evidence) };
    })
    .filter((entry) => entry && entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.order - b.order));

  return uniqueValues(ranked.map((entry) => entry.phrase)).slice(0, 4);
}

function deriveContextPhrases(evidenceText) {
  const normalized = normalizeKey(evidenceText);
  const phrases = [];
  for (const rule of CONTEXT_QUERY_RULES) {
    if (rule.keywords.some((keyword) => containsKeyword(normalized, keyword))) {
      phrases.push(rule.phrase);
    }
  }
  return uniqueValues(phrases).slice(0, 3);
}

function deriveSectionSubject(section, contextPhrases = []) {
  if (contextPhrases.length > 0) return contextPhrases[0];
  const fallbacks = SECTION_FALLBACK_QUERIES[section] || [];
  return fallbacks[0] || null;
}

function buildTitleSubjectPhrase(title, validatedEntities = []) {
  const entityTokens = new Set(validatedEntities.flatMap((value) => tokenize(value)));
  const tokens = tokenize(title)
    .filter((token) => !TITLE_SUBJECT_STOPWORDS.has(token))
    .filter((token) => !GENERIC_SECTION_TERMS.has(token))
    .filter((token) => !entityTokens.has(token))
    .filter((token) => token.length >= 4 || SHORT_ENTITY_ALLOWLIST.has(token))
    .slice(0, 3);
  return tokens.join(' ').trim();
}

function looksPersonLike(entity, evidenceText) {
  const key = normalizeKey(entity);
  if (!key) return false;
  const tokens = key.split(' ').filter(Boolean);
  if (tokens.some((token) => NON_PERSON_ENTITY_TOKENS.has(token))) return false;
  if (tokens.length >= 2 && tokens.length <= 3) {
    return tokens.every((token) => token.length > 2 && !PLACEHOLDER_TERMS.has(token) && !GENERIC_SECTION_TERMS.has(token));
  }
  const normalizedEvidence = normalizeKey(evidenceText);
  return PERSON_ROLE_HINTS.some((hint) => normalizedEvidence.includes(hint));
}

function pushQuery(list, value) {
  const normalized = normalizeText(value);
  const key = normalizeKey(normalized);
  if (!normalized || !key) return;
  if (isPlaceholderPhrase(normalized)) return;
  if (list.some((existing) => normalizeKey(existing) === key)) return;
  list.push(normalized);
}

function buildEntityLedQueries(primaryEntities = [], contextPhrases = [], geoHints = [], evidenceText = '') {
  const queries = [];
  const firstContext = contextPhrases[0] || null;

  primaryEntities.slice(0, 2).forEach((entity, index) => {
    const entityKey = normalizeKey(entity);
    const expansion = ENTITY_EXPANSIONS[entityKey]?.[0] || null;
    const preferredContext = expansion || firstContext;
    pushQuery(queries, `${entity} photo`);
    if (looksPersonLike(entity, evidenceText)) pushQuery(queries, `${entity} portrait`);
    if (preferredContext) pushQuery(queries, `${entity} ${preferredContext} photo`);
    if (firstContext && expansion && expansion !== firstContext && index === 0) pushQuery(queries, `${entity} ${firstContext} photo`);
    if (geoHints[0]) pushQuery(queries, `${geoHints[0]} ${entity} photo`);
  });

  if (primaryEntities.length >= 2) {
    pushQuery(queries, `${primaryEntities[0]} ${primaryEntities[1]} photo`);
  }

  return queries;
}

export function buildImageQueryPlan({
  title,
  excerpt,
  section,
  articleType,
  topicRecord,
  entityHints = [],
  geoHints = [],
  publishReadySources = [],
  maxQueries = 8,
} = {}) {
  const sourceEvidence = buildSourceEvidence(publishReadySources);
  const evidence = {
    titleOriginal: normalizeText(title),
    titleKey: normalizeKey(title),
    sourceTitlesText: normalizeText(sourceEvidence.sourceTitlesText),
    sourceTitleKey: normalizeKey(sourceEvidence.sourceTitlesText),
    bodyKey: normalizeKey([excerpt, sourceEvidence.sourceBodiesText, topicRecord?.label].filter(Boolean).join(' | ')),
  };
  const fullEvidenceText = [title, excerpt, sourceEvidence.sourceTitlesText, sourceEvidence.sourceBodiesText, topicRecord?.label]
    .filter(Boolean)
    .join(' | ');

  const validatedEntities = sanitizeEntityHints(entityHints, evidence, geoHints);
  const validatedGeoHints = sanitizeGeoHints(geoHints, normalizeKey(fullEvidenceText));
  const contextSeedText = [title, sourceEvidence.sourceTitlesText, topicRecord?.label].filter(Boolean).join(' | ');
  const contextPhrases = deriveContextPhrases(contextSeedText || fullEvidenceText);
  let titleSubject = buildTitleSubjectPhrase(title, validatedEntities);
  const titleSubjectKey = normalizeKey(titleSubject);
  const geoKeys = new Set(validatedGeoHints.map((value) => normalizeKey(value)));
  const contextKeys = new Set(contextPhrases.map((value) => normalizeKey(value)));
  if (geoKeys.has(titleSubjectKey) || contextKeys.has(titleSubjectKey) || isBroadTopicAlias(titleSubjectKey)) {
    titleSubject = '';
  }
  const sectionSubject = deriveSectionSubject(section, contextPhrases);
  const sourceTitleHints = sourceEvidence.sourceTitles.slice(0, 2);

  const queries = [];
  buildEntityLedQueries(validatedEntities, contextPhrases, validatedGeoHints, fullEvidenceText).forEach((query) => pushQuery(queries, query));

  if (titleSubject && validatedEntities[0]) pushQuery(queries, `${validatedEntities[0]} ${titleSubject} photo`);
  if (titleSubject && contextPhrases[0]) pushQuery(queries, `${titleSubject} ${contextPhrases[0]} photo`);
  if (titleSubject) pushQuery(queries, `${titleSubject} photo`);
  if (sectionSubject && validatedEntities.length === 0) pushQuery(queries, sectionSubject);

  if (validatedEntities.length === 0 || queries.length < 3) {
    (SECTION_FALLBACK_QUERIES[section] || []).forEach((query) => pushQuery(queries, query));
  }
  if (validatedEntities.length === 0 && queries.length < Math.max(3, Math.min(5, maxQueries))) {
    const conservativeFallback = section && section !== 'News' ? `${section} photo` : 'editorial photo';
    pushQuery(queries, conservativeFallback);
  }

  return {
    queries: queries.slice(0, maxQueries),
    entityHints: validatedEntities,
    geoHints: validatedGeoHints,
    sourceHints: sourceTitleHints,
    contextPhrases,
    debug: {
      validatedEntities,
      validatedGeoHints,
      contextPhrases,
      titleSubject,
      sourceTitleHints,
    },
  };
}
