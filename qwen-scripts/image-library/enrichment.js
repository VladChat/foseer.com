// File: qwen-scripts/image-library/enrichment.js
// Purpose: Lightweight metadata enrichment for image assets so the image node can score relevance without heavy vision/OCR work.

import path from 'node:path';

const SHORT_ENTITY_ALLOWLIST = new Set([
  'ai', 'cdc', 'ceo', 'covid', 'doj', 'epa', 'eu', 'fbi', 'fda', 'fed', 'gop', 'hhs', 'ipo', 'irs', 'mlb', 'nasa', 'nba', 'nfl', 'nhl', 'npr', 'nyc', 'sec', 'senate', 'tsa', 'uk', 'un', 'us', 'usa', 'usdc', 'who',
]);

const TOKEN_STOPWORDS = new Set([
  'about', 'after', 'against', 'analysis', 'article', 'background', 'breaking', 'briefing', 'business', 'city', 'collage', 'conference', 'cover', 'current', 'daily', 'document', 'editorial', 'event', 'events', 'feature', 'file', 'for', 'from', 'general', 'government', 'headline', 'image', 'images', 'illustration', 'latest', 'media', 'modern', 'near', 'news', 'office', 'people', 'person', 'photo', 'photos', 'picture', 'press', 'public', 'report', 'screen', 'social', 'source', 'story', 'technology', 'today', 'update', 'updates', 'video', 'visual', 'with', 'world', 'www',
]);

const GEO_PATTERNS = [
  ['united states', /\bunited states\b|\bu\.s\.a?\b|\busa\b/],
  ['washington', /\bwashington\b|\bwashington dc\b/],
  ['new york', /\bnew york\b|\bnyc\b/],
  ['chicago', /\bchicago\b/],
  ['california', /\bcalifornia\b/],
  ['texas', /\btexas\b/],
  ['florida', /\bflorida\b/],
  ['canada', /\bcanada\b/],
  ['mexico', /\bmexico\b/],
  ['europe', /\beurope\b|\beuropean union\b|\beu\b/],
  ['united kingdom', /\bunited kingdom\b|\buk\b|\bbritain\b|\bengland\b/],
  ['france', /\bfrance\b|\bparis\b/],
  ['germany', /\bgermany\b|\bberlin\b/],
  ['italy', /\bitaly\b|\brome\b/],
  ['spain', /\bspain\b|\bmadrid\b/],
  ['ukraine', /\bukraine\b|\bkyiv\b/],
  ['russia', /\brussia\b|\bmoscow\b/],
  ['china', /\bchina\b|\bbeijing\b/],
  ['japan', /\bjapan\b|\btokyo\b/],
  ['india', /\bindia\b|\bdelhi\b/],
  ['israel', /\bisrael\b|\bjerusalem\b/],
  ['gaza', /\bgaza\b/],
  ['iran', /\biran\b|\btehran\b/],
  ['middle east', /\bmiddle east\b/],
  ['africa', /\bafrica\b/],
  ['latin america', /\blatin america\b/],
  ['australia', /\baustralia\b|\bsydney\b|\bmelbourne\b/],
];

const SCENE_RULES = [
  { sceneType: 'courtroom', patterns: [/\bcourt(room|house)?\b/, /\bjudge\b/, /\bverdict\b/, /\blawsuit\b/, /\blegal\b/] },
  { sceneType: 'hospital', patterns: [/\bhospital\b/, /\bmedical\b/, /\bdoctor\b/, /\bnurse\b/, /\bpatient\b/, /\bclinic\b/, /\blab\b/, /\bresearch\b/] },
  { sceneType: 'stadium', patterns: [/\bstadium\b/, /\barena\b/, /\bfield\b/, /\bmatch\b/, /\bgame\b/, /\bleague\b/, /\bathlete\b/, /\bteam\b/, /\bscore\b/, /\btraining\b/] },
  { sceneType: 'document', patterns: [/\bdocument\b/, /\bfiling\b/, /\bpaperwork\b/, /\breport\b/, /\bchart\b/, /\bcontract\b/, /\bform\b/, /\bpolicy\b/] },
  { sceneType: 'product', patterns: [/\bproduct\b/, /\bdevice\b/, /\bphone\b/, /\blaptop\b/, /\bchip\b/, /\bgadget\b/, /\bvehicle\b/, /\bcar\b/, /\bconsumer\b/] },
  { sceneType: 'portrait', patterns: [/\bportrait\b/, /\bperson\b/, /\bman\b/, /\bwoman\b/, /\bface\b/, /\bspeaker\b/, /\bexecutive\b/, /\bpolitician\b/] },
  { sceneType: 'crowd', patterns: [/\bcrowd\b/, /\bprotest\b/, /\brally\b/, /\baudience\b/, /\bvoters\b/, /\bpeople\b/, /\bgathering\b/] },
  { sceneType: 'building', patterns: [/\bbuilding\b/, /\bcapitol\b/, /\bwhite house\b/, /\boffice tower\b/, /\bcity hall\b/, /\bexterior\b/, /\bheadquarters\b/] },
  { sceneType: 'office', patterns: [/\boffice\b/, /\bmeeting\b/, /\bdesk\b/, /\bworkspace\b/, /\bcomputer\b/, /\bserver\b/, /\bterminal\b/, /\btrading floor\b/] },
  { sceneType: 'abstract', patterns: [/\babstract\b/, /\bbackground\b/, /\bpattern\b/, /\btexture\b/, /\bgradient\b/, /\brender\b/, /\b3d\b/, /\bvector\b/, /\billustration\b/] },
];

const SECTION_SCENE_BONUS = {
  News: ['courtroom', 'building', 'crowd', 'document', 'portrait'],
  Business: ['office', 'building', 'document', 'portrait', 'product'],
  Tech: ['office', 'product', 'abstract', 'document'],
  Health: ['hospital', 'portrait', 'document'],
  Sports: ['stadium', 'crowd', 'portrait'],
  Culture: ['portrait', 'crowd', 'product', 'building'],
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHintArray(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function slugToText(value) {
  return String(value || '')
    .replace(/^legacy:/, '')
    .replace(/^pexels:/, '')
    .replace(/^pixabay:/, '')
    .replace(/[._/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLegacySlugText(asset) {
  const candidates = [];
  if (asset?.assetKey) candidates.push(slugToText(asset.assetKey));
  if (asset?.fileRelativePath) {
    const dirname = path.basename(path.dirname(asset.fileRelativePath));
    candidates.push(slugToText(dirname));
  }
  if (asset?.metadataRelativePath) {
    const dirname = path.basename(path.dirname(asset.metadataRelativePath));
    candidates.push(slugToText(dirname));
  }
  return candidates.filter(Boolean).join(' ');
}

export function buildAssetSearchText(asset = {}) {
  return [
    asset.altText,
    ...(asset.sectionHints || []),
    ...(asset.queryHistory || []),
    ...(asset.tags || []),
    ...(asset.topicHints || []),
    ...(asset.entityHints || []),
    ...(asset.geoHints || []),
    asset.sceneType,
    asset.visualType,
    asset.authorName,
    getLegacySlugText(asset),
    asset.rawTags,
    asset.sourcePageUrl,
  ].filter(Boolean).join(' ');
}

export function tokenizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isEntityLikeToken(token) {
  if (!token) return false;
  if (SHORT_ENTITY_ALLOWLIST.has(token)) return true;
  return token.length >= 4 && token.length <= 24;
}

export function inferGeoHintsFromText(text) {
  const normalized = ` ${String(text || '').toLowerCase()} `;
  const matches = [];
  for (const [label, pattern] of GEO_PATTERNS) {
    if (pattern.test(normalized)) {
      matches.push(label);
    }
  }
  return normalizeHintArray(matches).slice(0, 5);
}

export function inferEntityHintsFromText(text, geoHints = []) {
  const geoTokens = new Set(geoHints.flatMap((hint) => tokenizeSearchText(hint)));
  const tokens = tokenizeSearchText(text);
  const filtered = tokens.filter((token) => !TOKEN_STOPWORDS.has(token));
  const entities = [];

  for (const token of filtered) {
    if (!isEntityLikeToken(token)) continue;
    if (geoTokens.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    entities.push(token);
  }

  return normalizeHintArray(entities).slice(0, 8);
}

export function inferSceneTypeFromText(text, section = null) {
  const normalized = ` ${String(text || '').toLowerCase()} `;
  for (const rule of SCENE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return rule.sceneType;
    }
  }
  if (section && SECTION_SCENE_BONUS[section]?.length) {
    return SECTION_SCENE_BONUS[section][0];
  }
  return 'generic';
}

export function inferVisualType(asset = {}) {
  const candidate = String(asset.visualType || asset.apiVisualType || asset.rawType || asset.type || '').toLowerCase().trim();
  if (['photo', 'illustration', 'vector', 'graphic', 'render'].includes(candidate)) {
    return candidate;
  }

  const searchable = buildAssetSearchText(asset).toLowerCase();
  if (asset.provider === 'pexels') return 'photo';
  if (/\bvector\b/.test(searchable) || asset.format === 'svg') return 'vector';
  if (/\billustration\b/.test(searchable)) return 'illustration';
  if (/\brender\b|\b3d\b/.test(searchable)) return 'render';
  if (/\bgraphic\b|\binfographic\b/.test(searchable)) return 'graphic';
  return 'photo';
}

function computeBaseEditorialFitScore(asset = {}, hints = {}) {
  let score = 34;
  const sizeScore = Number(asset.width || 0) * Number(asset.height || 0);
  if (asset.altText) score += 10;
  if ((asset.queryHistory || []).length > 0) score += 10;
  if ((hints.entityHints || []).length > 0) score += 10;
  if ((hints.geoHints || []).length > 0) score += 6;
  if ((asset.sectionHints || []).length > 0) score += 6;
  if ((asset.topicHints || []).length > 0) score += 6;
  if (hints.sceneType && hints.sceneType !== 'generic') score += 6;
  if (hints.visualType === 'photo') score += 7;
  if (hints.visualType === 'illustration') score += 2;
  if (hints.visualType === 'vector') score -= 4;
  if (hints.visualType === 'graphic') score -= 2;
  if (sizeScore >= 1600 * 900) score += 7;
  if (sizeScore >= 2400 * 1350) score += 4;
  score -= Math.min(12, Number(asset.useCount || 0) * 2);
  return clamp(Math.round(score), 0, 100);
}

export function enrichAssetMetadata(asset = {}, options = {}) {
  const section = options.section || asset.sectionHint || asset.section || asset.sectionHints?.[0] || null;
  const searchText = buildAssetSearchText(asset);
  const geoHints = normalizeHintArray(asset.geoHints?.length ? asset.geoHints : inferGeoHintsFromText(searchText));
  const entityHints = normalizeHintArray(asset.entityHints?.length ? asset.entityHints : inferEntityHintsFromText(searchText, geoHints));
  const sceneType = asset.sceneType || inferSceneTypeFromText(searchText, section);
  const visualType = inferVisualType(asset);
  const hasStoredEditorialScore = asset.editorialFitScore !== undefined
    && asset.editorialFitScore !== null
    && String(asset.editorialFitScore).trim() !== ''
    && Number.isFinite(Number(asset.editorialFitScore));
  const editorialFitScore = hasStoredEditorialScore && !options.force
    ? clamp(Math.round(Number(asset.editorialFitScore)), 0, 100)
    : computeBaseEditorialFitScore(asset, { entityHints, geoHints, sceneType, visualType });

  return {
    entityHints,
    sceneType,
    geoHints,
    visualType,
    editorialFitScore,
  };
}

export function applyEnrichmentToAsset(asset = {}, options = {}) {
  return {
    ...asset,
    ...enrichAssetMetadata(asset, options),
  };
}

export function buildArticleSearchProfile({ title, excerpt, queries = [], section = null, topicId = null, entityHints = [], sourceHints = [], sectionHints = [], topicHints = [] } = {}) {
  const combined = [title, excerpt, ...(queries || []), ...(entityHints || []), ...(sourceHints || []), ...(sectionHints || []), ...(topicHints || [])]
    .filter(Boolean)
    .join(' ');
  const geoHints = inferGeoHintsFromText(combined);
  const extractedEntities = inferEntityHintsFromText(combined, geoHints);
  const tokens = normalizeHintArray(tokenizeSearchText(combined).filter((token) => !TOKEN_STOPWORDS.has(token) && token.length >= 3));
  const titleTokens = normalizeHintArray(tokenizeSearchText(title).filter((token) => !TOKEN_STOPWORDS.has(token) && token.length >= 3)).slice(0, 8);
  const excerptTokens = normalizeHintArray(tokenizeSearchText(excerpt).filter((token) => !TOKEN_STOPWORDS.has(token) && token.length >= 3)).slice(0, 10);
  const sourceTokens = normalizeHintArray((sourceHints || []).flatMap((value) => tokenizeSearchText(value)).filter((token) => !TOKEN_STOPWORDS.has(token) && token.length >= 3)).slice(0, 10);
  const primaryEntityHints = normalizeHintArray([...(entityHints || []), ...extractedEntities]).slice(0, 6);
  return {
    section,
    topicId,
    searchText: combined,
    tokens,
    titleTokens,
    excerptTokens,
    sourceTokens,
    geoHints,
    sourceHints: normalizeHintArray(sourceHints).slice(0, 8),
    entityHints: normalizeHintArray([...(entityHints || []), ...extractedEntities]).slice(0, 10),
    primaryEntityHints,
  };
}

export function computeContextualEditorialFit(asset = {}, articleProfile = {}) {
  const enriched = applyEnrichmentToAsset(asset);
  const assetTokens = new Set(tokenizeSearchText(buildAssetSearchText(enriched)).filter((token) => !TOKEN_STOPWORDS.has(token)));
  const queryTokens = new Set((articleProfile.tokens || []).map((token) => String(token).toLowerCase()));
  const titleTokens = new Set((articleProfile.titleTokens || []).map((token) => String(token).toLowerCase()));
  const excerptTokens = new Set((articleProfile.excerptTokens || []).map((token) => String(token).toLowerCase()));
  const sourceTokens = new Set((articleProfile.sourceTokens || []).map((token) => String(token).toLowerCase()));
  const overlap = Array.from(queryTokens).filter((token) => assetTokens.has(token)).length;
  const titleOverlap = Array.from(titleTokens).filter((token) => assetTokens.has(token)).length;
  const excerptOverlap = Array.from(excerptTokens).filter((token) => assetTokens.has(token)).length;
  const sourceOverlap = Array.from(sourceTokens).filter((token) => assetTokens.has(token)).length;

  const assetEntities = new Set((enriched.entityHints || []).map((value) => String(value).toLowerCase()));
  const articleEntities = new Set((articleProfile.entityHints || []).map((value) => String(value).toLowerCase()));
  const primaryEntities = new Set((articleProfile.primaryEntityHints || []).map((value) => String(value).toLowerCase()));
  const entityOverlap = Array.from(articleEntities).filter((value) => assetEntities.has(value)).length;
  const primaryEntityOverlap = Array.from(primaryEntities).filter((value) => assetEntities.has(value)).length;

  const assetGeos = new Set((enriched.geoHints || []).map((value) => String(value).toLowerCase()));
  const articleGeos = new Set((articleProfile.geoHints || []).map((value) => String(value).toLowerCase()));
  const geoOverlap = Array.from(articleGeos).filter((value) => assetGeos.has(value)).length;

  const sectionMatch = articleProfile.section && (asset.sectionHints || []).some((value) => String(value).toLowerCase() === String(articleProfile.section).toLowerCase()) ? 1 : 0;
  const topicMatch = articleProfile.topicId && (asset.topicHints || []).some((value) => String(value).toLowerCase() === String(articleProfile.topicId).toLowerCase()) ? 1 : 0;
  const sceneBonus = SECTION_SCENE_BONUS[articleProfile.section || '']?.includes(enriched.sceneType) ? 1 : 0;
  const visualPenalty = ['vector', 'graphic'].includes(enriched.visualType) && (articleProfile.section === 'News' || articleProfile.section === 'Business') ? 1 : 0;
  const scenicPenalty = ['building', 'crowd', 'document', 'office', 'portrait', 'stadium', 'hospital'].includes(enriched.sceneType)
    ? 0
    : ((articleProfile.section === 'News' || articleProfile.section === 'Business' || articleProfile.section === 'Culture' || articleProfile.section === 'Sports') ? 1 : 0);
  const abstractPenalty = enriched.sceneType === 'abstract' ? 1 : 0;
  const genericPenalty = titleOverlap === 0 && primaryEntityOverlap === 0 && geoOverlap === 0 ? 1 : 0;
  const weakConfirmationPenalty = (titleOverlap + primaryEntityOverlap + geoOverlap + sourceOverlap) === 0 ? 1 : 0;

  const confirmationScore = clamp(
    Math.round(
      titleOverlap * 18
      + primaryEntityOverlap * 20
      + geoOverlap * 14
      + sourceOverlap * 10
      + excerptOverlap * 6
    ),
    0,
    100,
  );

  const articleRelevanceScore = clamp(
    Math.round(
      overlap * 8
      + titleOverlap * 18
      + entityOverlap * 14
      + primaryEntityOverlap * 18
      + geoOverlap * 12
      + sourceOverlap * 10
      + excerptOverlap * 5
      + sectionMatch * 8
      + topicMatch * 10
      + sceneBonus * 5
      - visualPenalty * 10
      - scenicPenalty * 10
      - abstractPenalty * 10
      - genericPenalty * 16
      - weakConfirmationPenalty * 8
    ),
    0,
    100,
  );

  const assetQualityScore = clamp(
    Math.round(
      Number(enriched.editorialFitScore || 0)
      - visualPenalty * 6
      - abstractPenalty * 5
      - scenicPenalty * 3
    ),
    0,
    100,
  );

  const finalScore = clamp(
    Math.round(assetQualityScore * 0.28 + articleRelevanceScore * 0.72),
    0,
    100,
  );

  const confirmedStrong = finalScore >= 80
    && articleRelevanceScore >= 64
    && confirmationScore >= 38
    && (titleOverlap >= 2 || primaryEntityOverlap >= 1 || geoOverlap >= 1 || sourceOverlap >= 2);

  const tier = confirmedStrong
    ? 'strong'
    : finalScore >= 58 && articleRelevanceScore >= 40 && confirmationScore >= 20
      ? 'acceptable'
      : finalScore >= 40 && articleRelevanceScore >= 24
        ? 'usable'
        : 'weak';

  return {
    baseScore: Number(enriched.editorialFitScore || 0),
    assetQualityScore,
    articleRelevanceScore,
    confirmationScore,
    overlap,
    titleOverlap,
    excerptOverlap,
    sourceOverlap,
    entityOverlap,
    primaryEntityOverlap,
    geoOverlap,
    sectionMatch,
    topicMatch,
    sceneBonus,
    visualPenalty,
    scenicPenalty,
    abstractPenalty,
    genericPenalty,
    weakConfirmationPenalty,
    finalScore,
    confirmedStrong,
    tier,
  };
}
