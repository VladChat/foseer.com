// File: qwen-scripts/utils/evidence-policy.js
// Purpose: Shared evidence policy that allows a single strong source for normal factual stories while keeping basic quality safeguards.

import {
  isOfficialPrimaryDomain,
  isTrustedReportingDomain,
  normalizeDomain,
} from '../config/trusted-publishers.js';

const NON_PUBLISHABLE_PAGE_KINDS = new Set(['homepage', 'section', 'topic', 'live', 'roundup', 'video', 'audio']);
const HIGH_RISK_TOPIC_IDS = new Set([
  'world-geopolitics',
  'us-politics',
  'law-crime',
  'climate-extreme-weather',
]);
const GENERIC_TITLE_PATTERNS = [
  /live updates?/i,
  /latest news/i,
  /category/i,
  /tag/i,
  /topics?/i,
  /watch live/i,
  /browse all/i,
  /see all results/i,
];
const GENERIC_URL_PATTERNS = [
  /\/(live|category|tag|topics?)\//i,
  /\/(search)(?:\/|\?|$)/i,
];
const HIGH_RISK_TEXT_PATTERN = /(killed|dead|deaths|war|attack|airstrike|hostage|terror|indicted|charged|sanction|lawsuit|verdict|court)/i;

export function inferPublishableSources(sourcePack = {}) {
  if (Array.isArray(sourcePack?.publishReadySources) && sourcePack.publishReadySources.length > 0) {
    return sourcePack.publishReadySources;
  }
  if (Array.isArray(sourcePack?.sources) && sourcePack.sources.length > 0) {
    return sourcePack.sources;
  }
  return [];
}

export function inferUniqueDomains(sources = []) {
  return new Set(
    (Array.isArray(sources) ? sources : [])
      .map((source) => normalizeDomain(source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || ''))
      .filter(Boolean)
  ).size;
}

export function countEvidenceRoles(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  let trustedReporting = 0;
  let officialPrimary = 0;

  for (const source of list) {
    const domain = source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || '';
    if (isTrustedReportingDomain(domain)) trustedReporting += 1;
    if (isOfficialPrimaryDomain(domain) || String(source?.page_kind || '').toLowerCase() === 'official_release') {
      officialPrimary += 1;
    }
  }

  return { trustedReporting, officialPrimary };
}

export function isHighRiskEvidenceTopic(brief = {}) {
  if (HIGH_RISK_TOPIC_IDS.has(String(brief?.topic_id || '').toLowerCase())) return true;
  const text = `${brief?.title || ''} ${brief?.whatHappened || ''} ${brief?.whyItMatters || ''}`;
  return HIGH_RISK_TEXT_PATTERN.test(text);
}

export function getSingleSourceEvidenceDecision({
  brief = {},
  articleType = 'report',
  sources = [],
  coherenceScore = null,
  sourceConsistencyScore = null,
  directEventSourceCount = 0,
  crossTopicMismatchCount = 0,
} = {}) {
  const sourceCount = Array.isArray(sources) ? sources.length : 0;
  const domainCount = inferUniqueDomains(sources);
  if (sourceCount !== 1) return { enabled: true, pass: false, reason: 'publishable_count_not_one' };
  if (domainCount !== 1) return { enabled: true, pass: false, reason: 'domain_count_not_one' };

  const source = sources[0] || {};
  const roleCounts = countEvidenceRoles(sources);
  if ((Number(roleCounts.trustedReporting || 0) + Number(roleCounts.officialPrimary || 0)) < 1) {
    return { enabled: true, pass: false, reason: 'missing_trusted_or_official_role' };
  }

  if (isHighRiskEvidenceTopic(brief) && !roleCounts.officialPrimary) {
    return { enabled: true, pass: false, reason: 'high_risk_topic_requires_stronger_evidence' };
  }

  const pageKind = String(source?.page_kind || '').toLowerCase();
  if (NON_PUBLISHABLE_PAGE_KINDS.has(pageKind)) {
    return { enabled: true, pass: false, reason: `non_publishable_page_kind:${pageKind}` };
  }

  const title = String(source?.title || '').trim();
  const titleLower = title.toLowerCase();
  const sourceUrl = String(source?.canonical_url || source?.url || '').toLowerCase();
  if (GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(titleLower)) || GENERIC_URL_PATTERNS.some((pattern) => pattern.test(sourceUrl))) {
    return { enabled: true, pass: false, reason: 'generic_or_container_source' };
  }
  if (title.split(/\s+/).filter(Boolean).length < 3) {
    return { enabled: true, pass: false, reason: 'title_too_generic' };
  }
  if (Number(source?.genericity_score || 0) >= 7) {
    return { enabled: true, pass: false, reason: 'high_genericity' };
  }
  if (source?.title_url_mismatch) {
    return { enabled: true, pass: false, reason: 'title_url_mismatch' };
  }
  if ((pageKind === 'unknown' || pageKind === 'analysis' || pageKind === 'article' || pageKind === 'official_release') && Number(source?.article_likelihood || 0) < 4) {
    return { enabled: true, pass: false, reason: 'thin_article_signal' };
  }
  if (Number(crossTopicMismatchCount || 0) > 0) {
    return { enabled: true, pass: false, reason: 'cross_topic_mismatch_detected' };
  }
  if (Number(directEventSourceCount || 0) < 1) {
    return { enabled: true, pass: false, reason: 'direct_event_signal_missing' };
  }

  const minCoherence = isHighRiskEvidenceTopic(brief) ? 0.8 : 0.65;
  if (Number.isFinite(Number(coherenceScore)) && Number(coherenceScore) < minCoherence) {
    return { enabled: true, pass: false, reason: `coherence_below_threshold:${Number(coherenceScore).toFixed(2)}<${minCoherence}` };
  }

  const minConsistency = isHighRiskEvidenceTopic(brief) ? 6.5 : 5.0;
  if (Number.isFinite(Number(sourceConsistencyScore)) && Number(sourceConsistencyScore) < minConsistency) {
    return { enabled: true, pass: false, reason: `consistency_below_threshold:${Number(sourceConsistencyScore).toFixed(2)}<${minConsistency}` };
  }

  const mode = roleCounts.officialPrimary > 0 ? 'single_source_official' : 'single_source_trusted';
  return {
    enabled: true,
    pass: true,
    reason: `${mode}_ok`,
    mode,
    articleType: String(articleType || 'report').toLowerCase(),
    highRisk: isHighRiskEvidenceTopic(brief),
  };
}
