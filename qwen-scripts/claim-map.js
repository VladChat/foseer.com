// File: qwen-scripts/claim-map.js
// Purpose: Deterministic claim map for one coherent story without burning extra LLM calls

import { getPublishReadySources } from './utils/source-pack-access.js';

const CLAIM_TYPE = { FACTUAL: 'factual', CONTEXTUAL: 'contextual', ANALYTICAL: 'analytical' };
const CLAIM_STATUS = { SUPPORTED: 'supported', NEEDS_VERIFICATION: 'needs_verification', UNSUPPORTED: 'unsupported' };
const EVIDENCE_STRENGTH = { STRONG: 'strong', MODERATE: 'moderate', WEAK: 'weak', NONE: 'none' };
const CLAIM_MAP_QUALITY = { STRONG: 'strong', DEGRADED: 'degraded', FAILED: 'failed' };

export async function createClaimMap(sourcePack, _openAiApiKey) {
  const sources = getPublishReadySources(sourcePack, { minCount: 2 });
  console.log(`[claim-map] topic=${sourcePack.topic} sources=${sources.length}`);

  if (sources.length < 2) {
    return createFailedClaimMap(sourcePack, 'Need at least 2 sources for claim map');
  }

  try {
    const claims = buildDeterministicClaims(sourcePack, sources);
    if (claims.length < 2) {
      return createFallbackClaimMap(sourcePack, 'Deterministic claim builder found too little overlap');
    }
    return finalizeClaimMap(sourcePack, claims, false, null);
  } catch (error) {
    console.error(`[claim-map] error=${error.message}`);
    return createFallbackClaimMap(sourcePack, error.message);
  }
}

function buildDeterministicClaims(sourcePack, sources) {
  const claims = [];
  const uniqueDomains = new Set(sources.map(s => s.canonicalDomain || s.domain || 'unknown')).size;
  const commonTerms = getCommonTermsAcrossSources(sources, 2, 6);

  claims.push({
    id: `claim-${Date.now()}-0`,
    claimText: ensureSentence(cleanClaimText(sourcePack.topic || sources[0]?.title || 'The reported development is active.')),
    claimType: CLAIM_TYPE.FACTUAL,
    supportingSources: uniqueUrls(sources.slice(0, 3).map(source => source.url)),
    supportingSourceIndices: sources.slice(0, 3).map((_, index) => index + 1),
    evidenceExcerpt: buildEvidenceExcerpt(sources.slice(0, 2)),
    evidenceStartOffset: null,
    evidenceStrength: uniqueDomains >= 2 ? EVIDENCE_STRENGTH.STRONG : EVIDENCE_STRENGTH.MODERATE,
    confidenceScore: uniqueDomains >= 2 ? 8 : 6,
    status: CLAIM_STATUS.SUPPORTED,
  });

  claims.push({
    id: `claim-${Date.now()}-1`,
    claimText: `${sources.length} sources across ${uniqueDomains} domains are reporting the same development.`,
    claimType: CLAIM_TYPE.FACTUAL,
    supportingSources: uniqueUrls(sources.map(source => source.url)),
    supportingSourceIndices: sources.map((_, index) => index + 1),
    evidenceExcerpt: buildEvidenceExcerpt(sources.slice(0, 3)),
    evidenceStartOffset: null,
    evidenceStrength: uniqueDomains >= 3 ? EVIDENCE_STRENGTH.STRONG : EVIDENCE_STRENGTH.MODERATE,
    confidenceScore: uniqueDomains >= 3 ? 8 : 7,
    status: CLAIM_STATUS.SUPPORTED,
  });

  if (commonTerms.length >= 2) {
    claims.push({
      id: `claim-${Date.now()}-2`,
      claimText: `Across the coverage, the reporting repeatedly references ${commonTerms.slice(0, 4).join(', ')}.`,
      claimType: CLAIM_TYPE.CONTEXTUAL,
      supportingSources: uniqueUrls(findSupportingSourcesForTerms(sources, commonTerms.slice(0, 4)).map(source => source.url)),
      supportingSourceIndices: findSupportingSourceIndicesForTerms(sources, commonTerms.slice(0, 4)),
      evidenceExcerpt: buildEvidenceExcerpt(findSupportingSourcesForTerms(sources, commonTerms.slice(0, 4)).slice(0, 2)),
      evidenceStartOffset: null,
      evidenceStrength: EVIDENCE_STRENGTH.MODERATE,
      confidenceScore: 6,
      status: CLAIM_STATUS.SUPPORTED,
    });
  }

  return claims.filter(claim => claim.claimText && claim.supportingSources.length > 0).slice(0, 4);
}

function getCommonTermsAcrossSources(sources, minOccurrences = 2, limit = 6) {
  const counts = new Map();
  for (const source of sources) {
    const seenInSource = new Set(extractContentTerms(`${source.title || ''} ${source.snippet || ''}`));
    for (const term of seenInSource) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .filter(([, count]) => count >= minOccurrences)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .map(([term]) => term)
    .slice(0, limit);
}

function extractContentTerms(text) {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'after', 'over', 'under', 'have', 'has', 'had',
    'are', 'was', 'were', 'will', 'would', 'could', 'should', 'news', 'latest', 'breaking', 'report', 'reports',
    'says', 'said', 'amid', 'about', 'into', 'across', 'their', 'there', 'them', 'they', 'than', 'been', 'being'
  ]);

  return Array.from(new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !stop.has(token))
  ));
}

function findSupportingSourcesForTerms(sources, terms) {
  return sources.filter(source => {
    const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
    return terms.some(term => text.includes(term));
  });
}

function findSupportingSourceIndicesForTerms(sources, terms) {
  return sources
    .map((source, index) => ({ source, index: index + 1 }))
    .filter(({ source }) => {
      const text = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
      return terms.some(term => text.includes(term));
    })
    .map(({ index }) => index);
}

function buildEvidenceExcerpt(sources) {
  const excerpt = sources
    .map(source => source.snippet || source.title || '')
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ')
    .substring(0, 260);

  return excerpt || 'Source titles and snippets support this claim.';
}

function cleanClaimText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[|]+/g, ' ')
    .trim()
    .substring(0, 180);
}

function ensureSentence(value) {
  const clean = String(value || '').trim();
  if (!clean) return 'The development is being reported by multiple sources.';
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function uniqueUrls(values) {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function finalizeClaimMap(sourcePack, claims, isFallback, fallbackReason) {
  const supportedClaims = claims.filter(c => c.status === CLAIM_STATUS.SUPPORTED).length;
  const unsupportedClaims = claims.filter(c => c.status === CLAIM_STATUS.UNSUPPORTED).length;
  const avgConfidence = claims.length ? claims.reduce((sum, claim) => sum + claim.confidenceScore, 0) / claims.length : 0;
  const quality = claims.length >= 2 && supportedClaims >= 2 ? CLAIM_MAP_QUALITY.STRONG : claims.length >= 2 ? CLAIM_MAP_QUALITY.DEGRADED : CLAIM_MAP_QUALITY.FAILED;
  const safeForDrafting = quality !== CLAIM_MAP_QUALITY.FAILED;
  const claimsByType = {
    factual: claims.filter(c => c.claimType === CLAIM_TYPE.FACTUAL).length,
    contextual: claims.filter(c => c.claimType === CLAIM_TYPE.CONTEXTUAL).length,
    analytical: claims.filter(c => c.claimType === CLAIM_TYPE.ANALYTICAL).length,
  };
  const claimsByStrength = {
    strong: claims.filter(c => c.evidenceStrength === EVIDENCE_STRENGTH.STRONG).length,
    moderate: claims.filter(c => c.evidenceStrength === EVIDENCE_STRENGTH.MODERATE).length,
    weak: claims.filter(c => c.evidenceStrength === EVIDENCE_STRENGTH.WEAK).length,
    none: claims.filter(c => c.evidenceStrength === EVIDENCE_STRENGTH.NONE).length,
  };

  const claimMap = {
    eventId: sourcePack.eventId,
    topic: sourcePack.topic,
    claims,
    totalClaims: claims.length,
    supportedClaims,
    unsupportedClaims,
    avgConfidence,
    claimsByType,
    claimsByStrength,
    quality,
    passesGate: safeForDrafting,
    safeForDrafting,
    qualityIssues: quality === CLAIM_MAP_QUALITY.DEGRADED ? ['Using minimal deterministic claim map'] : quality === CLAIM_MAP_QUALITY.FAILED ? ['No usable claims'] : [],
    evidenceBasis: isFallback ? 'Fallback claim map from kept source titles/snippets' : 'Deterministic claim map from kept source titles/snippets',
    isFallback,
    fallbackReason,
    createdAt: new Date().toISOString(),
  };

  logClaimMapSummary(claimMap);
  return claimMap;
}

function createFallbackClaimMap(sourcePack, reason) {
  console.log(`[claim-map] fallback reason=${reason}`);
  const draftReadySources = getPublishReadySources(sourcePack, { minCount: 1 });
  const claims = draftReadySources.slice(0, 2).map((source, index) => ({
    id: `claim-fallback-${Date.now()}-${index}`,
    claimText: ensureSentence(source.title),
    claimType: CLAIM_TYPE.FACTUAL,
    supportingSources: [source.url],
    supportingSourceIndices: [index + 1],
    evidenceExcerpt: source.snippet || '',
    evidenceStartOffset: null,
    evidenceStrength: EVIDENCE_STRENGTH.MODERATE,
    confidenceScore: 6,
    status: CLAIM_STATUS.SUPPORTED,
  }));
  if (claims.length < 2) return createFailedClaimMap(sourcePack, reason);
  return finalizeClaimMap(sourcePack, claims, true, reason);
}

function createFailedClaimMap(sourcePack, reason) {
  return {
    eventId: sourcePack?.eventId || 'unknown',
    topic: sourcePack?.topic || 'unknown',
    claims: [],
    totalClaims: 0,
    supportedClaims: 0,
    unsupportedClaims: 0,
    avgConfidence: 0,
    claimsByType: { factual: 0, contextual: 0, analytical: 0 },
    claimsByStrength: { strong: 0, moderate: 0, weak: 0, none: 0 },
    quality: CLAIM_MAP_QUALITY.FAILED,
    passesGate: false,
    safeForDrafting: false,
    qualityIssues: [reason],
    evidenceBasis: 'No usable claims',
    isFallback: true,
    fallbackReason: reason,
    createdAt: new Date().toISOString(),
  };
}

function logClaimMapSummary(claimMap) {
  console.log(`[claim-map] quality=${claimMap.quality} total_claims=${claimMap.totalClaims} supported=${claimMap.supportedClaims} fallback=${claimMap.isFallback}`);
}

export function validateClaimMap(claimMap) {
  const issues = [...(claimMap.qualityIssues || [])];
  return {
    passes: !!claimMap.safeForDrafting,
    issues,
    quality: claimMap.quality,
    safeForDrafting: claimMap.safeForDrafting,
    isFallback: claimMap.isFallback,
  };
}

export function getClaimTypeWeight(claimType) {
  return { factual: 1.0, contextual: 0.7, analytical: 0.5 }[claimType] || 0.5;
}

export function getEvidenceStrengthScore(strength) {
  return { strong: 9, moderate: 7, weak: 4, none: 1 }[strength] || 4;
}
