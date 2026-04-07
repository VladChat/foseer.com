// File: qwen-scripts/utils/pre-draft-coherence-gate.js
// Purpose: Hard pre-draft coherence gate that validates section/topic, tags, and image planning
// BEFORE claim-map and drafting tokens are spent. Rejects or repairs bad candidates upstream.

import { loadTaxonomyRegistry, getTopicRecord, getSectionRecord } from './taxonomy-registry.js';
import { loadTagRegistry } from '../tag-picker.js';

// ============================================================
// Domain keyword maps for section/topic validation
// ============================================================

const DOMAIN_KEYWORDS = {
  sports: [
    'nfl', 'nba', 'mlb', 'nhl', 'football', 'basketball', 'baseball', 'hockey',
    'soccer', 'premier league', 'fa cup', 'champions league', 'world cup',
    'ncaa', 'college sports', 'transfer portal', 'tournament', 'playoff',
    'championship', 'team', 'club', 'player', 'coach', 'manager', 'match',
    'game', 'season', 'league', 'penalty', 'shootout', 'goal', 'score',
    'wimbledon', 'grand slam', 'olympics', 'super bowl', 'superbowl',
    'world series', 'stanley cup', 'finals', 'rider', 'cycling', 'race',
    'tour de france', 'tour of flanders', 'peloton', 'circuit', 'track',
    'pool', 'swimming', 'athletics', 'track and field', 'marathon',
    'sprint', 'relay', 'boxing', 'mma', 'ufc', 'tennis', 'golf', 'rugby',
    'cricket', 'formula 1', 'f1', 'nascar', 'indycar', 'motogp',
    'wrestling', 'boxing', 'fight', 'knockout', 'title fight',
    'manchester city', 'man city', 'midfielder', 'striker', 'defender',
    'goalkeeper', 'pitch', 'stadium', 'transfer', 'free agent', 'signing',
    'guardiola', 'pep', 'silva', 'bernardo', 'exit', 'squad', 'fixture',
  ],
  news: [
    'white house', 'congress', 'senate', 'president', 'administration',
    'supreme court', 'federal', 'executive order', 'diplomacy', 'summit',
    'treaty', 'war', 'conflict', 'military', 'troops', 'invasion',
    'sanctions', 'embassy', 'prime minister', 'parliament', 'election',
    'campaign', 'vote', 'legislation', 'law', 'crime', 'arrest', 'court',
    'trial', 'indictment', 'prosecutor', 'defense', 'verdict',
    'pope', 'vatican', 'cardinal', 'bishop', 'catholic', 'church',
    'easter', 'christmas', 'ramadan', 'religious', 'worship', 'mass',
    'homily', 'pontiff', 'encyclical', 'beatification',
    'earthquake', 'hurricane', 'flood', 'wildfire', 'storm', 'tornado',
    'tsunami', 'drought', 'climate', 'weather',
  ],
  tech: [
    'ai', 'artificial intelligence', 'openai', 'chatgpt', 'google',
    'meta', 'microsoft', 'apple', 'amazon', 'nvidia', 'intel', 'amd',
    'software', 'hardware', 'startup', 'cybersecurity', 'hack', 'breach',
    'ransomware', 'malware', 'data breach', 'cloud', 'saas', 'api',
    'nasa', 'spacex', 'rocket', 'satellite', 'moon', 'mars', 'artemis',
    'space', 'launch', 'orbit', 'ev', 'electric vehicle', 'tesla',
    'autonomous', 'self-driving', 'robotaxi', 'smartphone', 'iphone',
    'android', 'app', 'browser', 'operating system', 'chip', 'semiconductor',
    'quantum', 'blockchain', 'crypto', 'bitcoin', 'ethereum',
  ],
  business: [
    'stock', 'market', 'wall street', 'earnings', 'revenue', 'profit',
    'ipo', 'merger', 'acquisition', 'deal', 'ceo', 'corporate',
    'inflation', 'fed', 'federal reserve', 'interest rate', 'gdp',
    'employment', 'jobs report', 'unemployment', 'recession',
    'housing', 'mortgage', 'real estate', 'rent', 'home prices',
    'crypto', 'bitcoin', 'ethereum', 'digital asset', 'token',
    'bank', 'lending', 'credit', 'debt', 'treasury', 'bond',
    'tariff', 'trade', 'supply chain', 'logistics',
    'earnings', 'quarterly', 'fiscal year', 'guidance', 'forecast',
  ],
  health: [
    'fda', 'drug', 'drugs', 'pharma', 'pharmaceutical', 'biotech',
    'clinical trial', 'treatment', 'therapy', 'disease', 'virus',
    'vaccine', 'pandemic', 'epidemic', 'outbreak', 'hospital',
    'doctor', 'physician', 'nurse', 'patient', 'health', 'mental health',
    'anxiety', 'depression', 'wellness', 'fitness', 'nutrition',
    'cancer', 'diabetes', 'heart', 'stroke', 'obesity',
    'medicare', 'medicaid', 'insurance', 'healthcare',
    'ipledege', 'rems', 'isotretinoin', 'accutane', 'birth defect',
    'embryo', 'fetal', 'toxicity',
  ],
  culture: [
    'film', 'movie', 'cinema', 'television', 'tv', 'series', 'streaming',
    'netflix', 'hulu', 'disney', 'hbo', 'max', 'apple tv',
    'music', 'album', 'song', 'band', 'artist', 'concert', 'tour',
    'book', 'novel', 'author', 'literature', 'publishing',
    'theater', 'broadway', 'opera', 'ballet', 'dance',
    'art', 'museum', 'gallery', 'exhibition',
    'celebrity', 'actor', 'actress', 'director', 'producer',
    'guild', 'union', 'writers guild', 'wga', 'sag', 'aftra',
    'award', 'oscar', 'emmy', 'grammy', 'tony', 'golden globe',
    'review', 'critic', 'criticism', 'premiere', 'release',
    'hollywood', 'studios', 'screenwriter', 'screenplay', 'tentative deal',
    'labor dispute', 'strike', 'picket', 'bargaining', 'ratification',
    'zendaya', 'pattinson', 'actor', 'actress', 'cast',
    'pope', 'vatican', 'catholic', 'easter', 'mass', 'pontiff', 'homily',
    'vinyl', 'streaming music', 'recorded music',
  ],
};

const SPORT_SPECIFIC_KEYWORDS = {
  football: ['football', 'soccer', 'fa cup', 'premier league', 'champions league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'goal', 'penalty', 'shootout', 'red card', 'yellow card', 'manager', 'transfer', 'striker', 'midfielder', 'defender', 'goalkeeper', 'pitch', 'stadium'],
  basketball: ['basketball', 'nba', 'ncaa', 'dunk', 'three-pointer', 'point guard', 'center', 'power forward', 'small forward', 'shooting guard', 'court', 'arena'],
  baseball: ['baseball', 'mlb', 'pitcher', 'batter', 'home run', 'inning', 'diamond', 'outfield', 'bullpen', 'world series'],
  cycling: ['cycling', 'cyclist', 'rider', 'peloton', 'tour de france', 'tour of flanders', 'giro', 'vuelta', 'time trial', 'sprint', 'stage', 'mountain stage', 'yellow jersey', 'red light', 'railway crossing'],
};

// ============================================================
// Core validation functions
// ============================================================

/**
 * Tokenize text into lowercase words, filtering stop words.
 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Extract all meaningful text from a candidate for coherence checking.
 */
function extractCandidateText(candidate) {
  const parts = [];

  // Brief text
  if (candidate?.brief?.title) parts.push(candidate.brief.title);
  if (candidate?.brief?.summary) parts.push(candidate.brief.summary);
  if (candidate?.brief?.whatHappened) parts.push(candidate.brief.whatHappened);
  if (candidate?.brief?.whyItMatters) parts.push(candidate.brief.whyItMatters);
  if (candidate?.brief?.angle) parts.push(candidate.brief.angle);
  if (candidate?.brief?.region) parts.push(candidate.brief.region);

  // Source pack text
  if (candidate?.sourcePack) {
    for (const src of (candidate.sourcePack.sources || [])) {
      if (src?.title) parts.push(src.title);
      if (src?.summary) parts.push(src.summary);
      if (src?.domain) parts.push(src.domain);
    }
  }

  // Entities
  if (candidate?.brief?.entities) {
    parts.push(...candidate.brief.entities);
  }

  return parts.join(' ').toLowerCase();
}

/**
 * Check whether the candidate text supports the proposed section.
 * Returns { score: 0-1, matchedKeywords: string[], evidence: string }
 */
function validateSectionCoherence(candidate, proposedSectionId) {
  const text = extractCandidateText(candidate);
  const keywords = tokenize(text);

  const sectionKeywords = DOMAIN_KEYWORDS[proposedSectionId] || [];
  if (sectionKeywords.length === 0) {
    return { score: 0.5, matchedKeywords: [], evidence: 'No domain keywords for this section' };
  }

  const matchedKeywords = sectionKeywords.filter((kw) => {
    if (kw.includes(' ')) {
      return text.includes(kw);
    }
    return keywords.includes(kw);
  });

  const score = sectionKeywords.length > 0
    ? Math.min(1, matchedKeywords.length / Math.max(3, Math.min(sectionKeywords.length, 8)))
    : 0.5;

  return {
    score,
    matchedKeywords: matchedKeywords.slice(0, 6),
    evidence: matchedKeywords.length > 0
      ? `Found ${matchedKeywords.length} section-relevant terms: ${matchedKeywords.slice(0, 4).join(', ')}`
      : `No terms found for section "${proposedSectionId}"`,
  };
}

/**
 * Check whether the candidate text supports the proposed topic.
 * Returns { score: 0-1, matchedAlias: string, evidence: string }
 */
function validateTopicCoherence(candidate, proposedTopicId) {
  const text = extractCandidateText(candidate);
  const topicRecord = getTopicRecord(proposedTopicId);

  if (!topicRecord) {
    return { score: 0, matchedAlias: null, evidence: `Unknown topic_id: ${proposedTopicId}` };
  }

  const aliases = topicRecord.aliases || [];
  const topicKeywords = tokenize(topicRecord.label || '').concat(aliases.map((a) => a).flatMap((a) => tokenize(a)));

  const matchedAlias = aliases.find((alias) => text.includes(alias.toLowerCase()));
  const labelMatch = text.includes((topicRecord.label || '').toLowerCase());

  let score = 0;
  if (labelMatch) score += 0.5;
  if (matchedAlias) score += 0.4;

  // Check for specific keyword overlaps
  const keywordHits = topicKeywords.filter((kw) => kw.length > 2 && text.includes(kw)).length;
  score += Math.min(0.3, keywordHits * 0.05);

  return {
    score: Math.min(1, score),
    matchedAlias: matchedAlias || (labelMatch ? topicRecord.label : null),
    evidence: labelMatch || matchedAlias
      ? `Topic "${topicRecord.label}" matched via "${matchedAlias || topicRecord.label}"`
      : `No direct topic match for "${topicRecord.label}"`,
  };
}

/**
 * Cross-check: does the candidate look like sports but is placed in tech/business/etc?
 * Returns { isMismatch: boolean, detectedDomain: string|null, proposedSection: string, confidence: number }
 */
function detectDomainMismatch(candidate, proposedSectionId) {
  const text = extractCandidateText(candidate);

  // Check which domain has the strongest keyword presence
  const domainScores = {};
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw.includes(' ')) {
        if (text.includes(kw)) hits += 2;
      } else if (text.includes(kw)) {
        hits += 1;
      }
    }
    domainScores[domain] = hits;
  }

  // Find the top domain
  const sortedDomains = Object.entries(domainScores).sort((a, b) => b[1] - a[1]);
  const topDomain = sortedDomains[0];
  const secondDomain = sortedDomains[1];

  // If the top domain has moderate signal but doesn't match proposed section, flag it
  const threshold = 3; // Lowered from 4 to catch more mismatches
  if (topDomain[1] >= threshold && topDomain[0] !== proposedSectionId) {
    return {
      isMismatch: true,
      detectedDomain: topDomain[0],
      proposedSection: proposedSectionId,
      confidence: Math.min(1, topDomain[1] / 8), // Normalized to 8 instead of 10
      topKeywords: sortedDomains.filter(([, score]) => score >= 2).map(([domain, score]) => ({ domain, score })).slice(0, 3),
    };
  }

  return { isMismatch: false, detectedDomain: null, proposedSection: proposedSectionId, confidence: 0 };
}

/**
 * Check if tags are coherent with the section/topic.
 * Returns { pass: boolean, errors: string[], correctedTags: object|null }
 */
function validateTagCoherence(candidate, proposedSectionId, proposedTopicId, existingTags) {
  const errors = [];
  const text = extractCandidateText(candidate);

  if (!existingTags || existingTags.length === 0) {
    return { pass: true, errors: [], correctedTags: null };
  }

  // Get the correct topic's label for comparison
  const topicRecord = getTopicRecord(proposedTopicId);
  const correctTopicLabel = topicRecord?.label?.toLowerCase() || '';

  // Get all topic definitions to check tag-to-domain alignment
  const registry = loadTaxonomyRegistry();
  const topicDefs = registry.topicDefinitions || [];

  for (const tag of existingTags) {
    const tagLower = tag.toLowerCase();

    // Check for sport-specific mismatches
    if (tagLower === 'nba' && !text.includes('basketball') && !text.includes('nba')) {
      // Check if this is actually a basketball article
      const hasBasketballTerms = ['basketball', 'nba', 'dunk', 'hoops', 'court'].some((t) => text.includes(t));
      if (!hasBasketballTerms) {
        errors.push(`Tag "${tag}" is basketball-specific but article contains no basketball signals`);
      }
    }

    if (tagLower === 'nfl' && !text.includes('nfl') && !text.includes('football')) {
      const hasFootballTerms = ['nfl', 'football', 'touchdown', 'quarterback', 'super bowl'].some((t) => text.includes(t));
      if (!hasFootballTerms) {
        errors.push(`Tag "${tag}" is football-specific but article contains no NFL signals`);
      }
    }

    if (tagLower === 'cybersecurity') {
      const hasCyberTerms = ['cyber', 'hack', 'breach', 'ransomware', 'malware', 'data breach', 'security flaw', 'cybersecurity'].some((t) => text.includes(t));
      if (!hasCyberTerms) {
        errors.push(`Tag "${tag}" is cybersecurity-specific but article contains no cybersecurity signals`);
      }
    }

    if (tagLower === 'criminal investigation') {
      const hasCrimeTerms = ['arrest', 'charged', 'indicted', 'criminal', 'prosecution', 'investigation'].some((t) => text.includes(t));
      // Cycling rule violations are regulatory, not criminal
      const isSportsRegulatory = text.includes('cycling') || text.includes('race') || text.includes('rider') || text.includes('race officials');
      if (!hasCrimeTerms && isSportsRegulatory) {
        errors.push(`Tag "${tag}" is too strong for a sports regulatory issue`);
      }
    }

    if (tagLower === 'strategy') {
      errors.push(`Tag "${tag}" is too vague to be useful`);
    }

    // Check if tag belongs to a completely different section
    for (const topicDef of topicDefs) {
      if (topicDef.section_id !== proposedSectionId) {
        const topicLabelLower = (topicDef.label || '').toLowerCase();
        if (tagLower === topicLabelLower || topicDef.aliases?.some((a) => a.toLowerCase() === tagLower)) {
          // Tag belongs to a different section's topic
          errors.push(`Tag "${tag}" belongs to section "${topicDef.section_id}" topic "${topicDef.label}", not "${proposedSectionId}"`);
        }
      }
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    correctedTags: errors.length > 0 ? null : null,
  };
}

/**
 * Build a topic-aware visual concept set for image queries.
 * Returns { concepts: string[], avoidTerms: string[], suggestedQuery: string }
 */
export function buildVisualConceptSet(proposedSectionId, proposedTopicId, candidateText) {
  const concepts = [];
  const avoidTerms = ['global', 'news', 'report', 'breaking', 'latest', 'update', 'coverage'];

  // Map topic to visual concepts
  const topicVisualConcepts = {
    // Sports
    'major-leagues': ['stadium', 'arena', 'game action', 'athletes competing', 'crowd'],
    'events-tournaments': ['tournament', 'trophy', 'championship', 'finals', 'celebration'],
    'transfers-business': ['athlete signing', 'team logo', 'press conference', 'sports contract'],
    'athletes-culture': ['athlete portrait', 'sports culture', 'fans', 'stadium atmosphere'],
    // Tech
    'ai-big-tech': ['data center', 'ai visualization', 'server room', 'technology', 'code'],
    'consumer-tech': ['smartphone', 'laptop', 'consumer electronics', 'gadgets'],
    'cybersecurity': ['lock icon', 'cybersecurity', 'digital security', 'firewall', 'network'],
    'mobility-evs': ['electric vehicle', 'charging station', 'autonomous car', 'ev charging'],
    'space-astronomy': ['space', 'moon', 'mars', 'rocket', 'stars', 'telescope', 'nasa', 'spacecraft'],
    // Health
    'public-health': ['public health', 'hospital', 'medical', 'healthcare', 'doctor'],
    'medical-research': ['laboratory', 'research', 'clinical trial', 'microscope'],
    'pharma-fda': ['pharmaceutical', 'pill bottle', 'fda building', 'medical regulation', 'pills'],
    'mental-health': ['mental health', 'therapy', 'counseling', 'wellness'],
    'wellness-fitness': ['fitness', 'exercise', 'wellness', 'nutrition'],
    // Business
    'economy-markets': ['stock market', 'trading floor', 'economy', 'financial'],
    'companies-deals': ['corporate', 'office building', 'business deal', 'handshake'],
    'consumer-money': ['personal finance', 'money', 'budget', 'savings'],
    'housing-real-estate': ['house', 'real estate', 'home', 'property'],
    'crypto-bitcoin': ['cryptocurrency', 'bitcoin', 'blockchain', 'digital currency'],
    'travel-consumer-issues': ['airport', 'travel', 'flight', 'airport terminal', 'passenger'],
    // News
    'us-politics': ['white house', 'capitol', 'congress', 'washington dc', 'politics'],
    'world-geopolitics': ['diplomacy', 'international', 'summit', 'government', 'flags', 'united nations'],
    'law-crime': ['courthouse', 'justice', 'legal', 'law enforcement'],
    'climate-extreme-weather': ['extreme weather', 'storm', 'climate', 'environment', 'natural disaster'],
    'society-social-trends': ['community', 'people', 'social', 'education', 'public'],
    // Culture
    'film-tv': ['cinema', 'film set', 'movie theater', 'television', 'screenplay'],
    'music-celebrities': ['music', 'concert', 'album', 'stage', 'musical performance'],
    'internet-culture': ['internet', 'social media', 'viral', 'online', 'digital culture'],
    'creators-platforms': ['content creator', 'streaming', 'social platform', 'digital content'],
  };

  const topicConcepts = topicVisualConcepts[proposedTopicId] || [];
  concepts.push(...topicConcepts.slice(0, 3));

  // Add section-level fallback if topic has no concepts
  if (concepts.length === 0) {
    const sectionConcepts = {
      sports: ['sports action', 'stadium', 'athletes'],
      tech: ['technology', 'digital', 'innovation'],
      health: ['healthcare', 'medical', 'wellness'],
      business: ['business', 'corporate', 'finance'],
      news: ['newsroom', 'journalism', 'current events'],
      culture: ['culture', 'arts', 'entertainment'],
    };
    concepts.push(...(sectionConcepts[proposedSectionId] || []));
  }

  // Extract entity-specific visual terms from candidate text
  // Use tokenized approach instead of capitalized-phrase extraction to avoid noise
  const VISUAL_NOISE_TOKENS = new Set([
    'the', 'this', 'that', 'these', 'those', 'about', 'after', 'before', 'between',
    'during', 'from', 'through', 'within', 'without', 'under', 'over', 'above',
    'new', 'latest', 'breaking', 'first', 'second', 'third', 'last', 'next',
    'how', 'what', 'why', 'when', 'where', 'which', 'who', 'could', 'would',
    'signs', 'signing', 'sign', 'target', 'targeting', 'order', 'executive',
    'college', 'sports', 'transfers', 'eligibility', 'campus', 'athletics',
    'emerged', 'stronger', 'digital', 'disruption', 'industry', 'music',
    'recorded', 'storm', 'reveals', 'reveal', 'race', 'funding', 'remarks',
    'update', 'updates', 'report', 'reports', 'coverage',
  ]);
  // Tokenize and filter for meaningful visual entity terms
  const tokens = candidateText.split(/[\s\-_,.]+/).filter((t) => t.length > 3);
  const addedEntities = new Set();
  for (const token of tokens) {
    const tl = token.toLowerCase();
    if (VISUAL_NOISE_TOKENS.has(tl)) continue;
    if (tl === proposedSectionId) continue;
    if (addedEntities.size >= 3) break;
    // Only add tokens that look like proper nouns or domain-specific terms
    if (/^[A-Z]/.test(token) || (tl.length >= 5 && !/^(and|the|for|with|from|this|that)/.test(tl))) {
      addedEntities.add(tl);
      concepts.push(tl);
    }
  }

  // Build the suggested query: combine topic concept with key entity
  const primaryConcept = concepts[0] || `${proposedTopicId} ${proposedSectionId}`;
  const suggestedQuery = `${primaryConcept} ${proposedSectionId}`;

  return {
    concepts: [...new Set(concepts)].slice(0, 8),
    avoidTerms,
    suggestedQuery,
  };
}

// ============================================================
// Main gate function
// ============================================================

/**
 * Evaluate pre-draft coherence of a candidate.
 * Must be called AFTER source-pack assembly but BEFORE claim-map/drafting.
 *
 * @param {Object} candidate - The candidate with brief, sourcePack, placement
 * @param {Object} options - Optional configuration
 * @returns {Object} { pass: boolean, action: 'pass'|'repair'|'reject', repairs: object|null, reasons: string[], warnings: string[] }
 */
export function evaluatePreDraftCoherence(candidate, options = {}) {
  const results = {
    pass: true,
    action: 'pass',
    repairs: null,
    reasons: [],
    warnings: [],
    sectionCheck: null,
    topicCheck: null,
    domainMismatch: null,
    tagCheck: null,
    imagePlan: null,
  };

  const proposedSectionId = candidate?.sourcePack?.section_id
    || candidate?.brief?.section_id
    || candidate?.placement?.section_id
    || null;

  const proposedTopicId = candidate?.sourcePack?.topic_id
    || candidate?.brief?.topic_id
    || candidate?.placement?.topic_id
    || null;

  const articleLabel = candidate?.brief?.title || candidate?.sourcePack?.topic || 'Untitled';

  if (!proposedSectionId) {
    results.pass = false;
    results.action = 'reject';
    results.reasons.push('No section_id available for coherence check');
    return results;
  }

  // 1. Section coherence check
  const sectionCheck = validateSectionCoherence(candidate, proposedSectionId);
  results.sectionCheck = sectionCheck;

  // 2. Domain mismatch detection
  const domainMismatch = detectDomainMismatch(candidate, proposedSectionId);
  results.domainMismatch = domainMismatch;

  if (domainMismatch.isMismatch && domainMismatch.confidence >= 0.5) {
    results.pass = false;
    results.action = 'repair';
    results.reasons.push(
      `Section mismatch: candidate placed in "${proposedSectionId}" but content signals "${domainMismatch.detectedDomain}" (confidence: ${(domainMismatch.confidence * 100).toFixed(0)}%, top signals: ${JSON.stringify(domainMismatch.topKeywords)})`
    );

    // Try to repair: suggest the correct section
    results.repairs = {
      suggested_section_id: domainMismatch.detectedDomain,
      suggested_topic_id: null, // Will need topic-level repair too
      reason: domainMismatch.evidence,
    };

    // Try to find a topic within the detected section
    const registry = loadTaxonomyRegistry();
    const topicsInDetectedSection = registry.topicsBySection?.[domainMismatch.detectedDomain] || [];
    if (topicsInDetectedSection.length > 0) {
      results.repairs.suggested_topic_id = topicsInDetectedSection[0];
    }
  }

  // 3. Topic coherence check (only if section passed or was repaired)
  if (proposedTopicId) {
    const topicCheck = validateTopicCoherence(candidate, proposedTopicId);
    results.topicCheck = topicCheck;

    if (topicCheck.score < 0.3 && results.action !== 'repair') {
      results.warnings.push(`Topic coherence low for "${proposedTopicId}": score=${topicCheck.score.toFixed(2)}, ${topicCheck.evidence}`);
    }
  }

  // 4. Tag coherence check
  const existingTags = candidate?.canonicalPublishPayload?.tagging?.tags
    || candidate?.brief?.tags
    || [];
  if (existingTags.length > 0) {
    const tagCheck = validateTagCoherence(candidate, proposedSectionId, proposedTopicId, existingTags);
    results.tagCheck = tagCheck;

    if (!tagCheck.pass) {
      results.warnings.push(...tagCheck.errors);
    }
  }

  // 5. Image query planning
  const candidateText = extractCandidateText(candidate);
  const imagePlan = buildVisualConceptSet(proposedSectionId, proposedTopicId, candidateText);
  results.imagePlan = imagePlan;

  // Final decision
  if (results.action === 'repair' && !results.repairs?.suggested_section_id) {
    // Can't repair → reject
    results.action = 'reject';
    results.reasons.push('Section/topic mismatch detected but no repair path available');
  }

  if (results.action === 'pass' && results.warnings.length >= 3) {
    // Too many warnings → consider rejection
    results.action = 'reject';
    results.reasons.push(`Multiple coherence warnings (${results.warnings.length}): ${results.warnings.join('; ')}`);
  }

  console.log(`[coherence-gate] ${articleLabel}: section=${proposedSectionId} topic=${proposedTopicId} action=${results.action}`);
  if (results.sectionCheck) {
    console.log(`[coherence-gate]   section_score=${results.sectionCheck.score.toFixed(2)} matched=[${results.sectionCheck.matchedKeywords.join(', ')}]`);
  }
  if (results.domainMismatch?.isMismatch) {
    console.log(`[coherence-gate]   MISMATCH: detected=${results.domainMismatch.detectedDomain} confidence=${(results.domainMismatch.confidence * 100).toFixed(0)}%`);
  }
  if (results.tagCheck?.errors?.length > 0) {
    console.log(`[coherence-gate]   tag_errors=${results.tagCheck.errors.join('; ')}`);
  }

  return results;
}

/**
 * Apply coherence repairs to a candidate in-place.
 * Returns true if repair was applied, false if not possible.
 */
export function applyCoherenceRepair(candidate, coherenceResult) {
  if (!coherenceResult?.repairs?.suggested_section_id) {
    return false;
  }

  const repairs = coherenceResult.repairs;

  // Repair section_id
  if (candidate?.sourcePack) {
    candidate.sourcePack.section_id = repairs.suggested_section_id;
  }
  if (candidate?.brief) {
    candidate.brief.section_id = repairs.suggested_section_id;
  }
  if (candidate?.placement) {
    candidate.placement.section_id = repairs.suggested_section_id;
  }

  // Repair topic_id if available
  if (repairs.suggested_topic_id) {
    if (candidate?.sourcePack) {
      candidate.sourcePack.topic_id = repairs.suggested_topic_id;
    }
    if (candidate?.brief) {
      candidate.brief.topic_id = repairs.suggested_topic_id;
    }
    if (candidate?.placement) {
      candidate.placement.topic_id = repairs.suggested_topic_id;
    }
  }

  console.log(`[coherence-gate] REPAIRED: section_id=${repairs.suggested_section_id} topic_id=${repairs.suggested_topic_id || 'unchanged'}`);
  return true;
}
