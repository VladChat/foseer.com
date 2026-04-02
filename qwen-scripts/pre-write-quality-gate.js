// File: qwen-scripts/pre-write-quality-gate.js
// Purpose: Shared pre-write quality gate to block weak candidates before any expensive writer-token stages.

import {
  isOfficialPrimaryDomain,
  isStrictSingleSourceWhitelistDomain,
  isTrustedReportingDomain,
  normalizeDomain,
} from './config/trusted-publishers.js';

function inferUniqueDomains(sources = []) {
  return new Set(
    (Array.isArray(sources) ? sources : [])
      .map((source) => normalizeDomain(source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || ''))
      .filter(Boolean)
  ).size;
}

function countSourcesByRole(sources = []) {
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

export function evaluatePreWriteQualityGate({
  brief = {},
  sourcePack = {},
  questionCandidate = null,
  mode = 'article',
  coherenceScore = null,
} = {}, options = {}) {
  const reasons = [];
  const warnings = [];

  const minSources = Math.max(1, Number(options.minSources || process.env.QWEN_PREWRITE_MIN_SOURCES || 2));
  const minDomains = Math.max(1, Number(options.minDomains || process.env.QWEN_PREWRITE_MIN_DOMAINS || 2));
  const minCoherence = Number(options.minCoherence || process.env.QWEN_PREWRITE_MIN_COHERENCE || 0.45);

  const sources = Array.isArray(sourcePack?.sources) ? sourcePack.sources : [];
  const sourceCount = sources.length;
  const domainCount = Number(sourcePack?.uniqueDomains || 0) || inferUniqueDomains(sources);
  const gatePassed = Boolean(sourcePack?.passesGate);
  const gateNotes = Array.isArray(sourcePack?.gateNotes) ? sourcePack.gateNotes : [];
  const roleCounts = countSourcesByRole(sources);
  const stage3BlockingErrors = (sourcePack?.stage3EditorialGate?.blocking_errors || [])
    .filter((message) => !String(message || '').startsWith('Primary topic_id unsupported by source-pack evidence'));
  const entitySignals = [
    ...(Array.isArray(brief?.entities) ? brief.entities : []),
    ...(Array.isArray(brief?.involvedParties) ? brief.involvedParties : []),
    ...(Array.isArray(brief?.keyEntities) ? brief.keyEntities : []),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const hasEntitySignal = entitySignals.length > 0;
  const singleSourceDecision = evaluateSingleSourceWhitelistEligibility({
    brief,
    sources,
    sourceCount,
    domainCount,
    coherenceScore: Number.isFinite(Number(coherenceScore)) ? Number(coherenceScore) : null,
    roleCounts,
    options,
  });

  if (!gatePassed) reasons.push('Source-pack gate not passed');
  if (sourceCount < minSources) {
    if (!singleSourceDecision.pass) reasons.push(`Not enough publishable sources (${sourceCount}/${minSources})`);
  }
  if (domainCount < minDomains) {
    if (!singleSourceDecision.pass) reasons.push(`Not enough independent domains (${domainCount}/${minDomains})`);
  }
  if (roleCounts.trustedReporting < 1 && roleCounts.officialPrimary < 1) {
    reasons.push('Missing trusted reporting or official primary source');
  }
  if (singleSourceDecision.enabled && !singleSourceDecision.pass && sourceCount === 1) {
    warnings.push(`single_source_whitelist_rejected:${singleSourceDecision.reason}`);
  }
  if (singleSourceDecision.pass) {
    warnings.push(`single_source_whitelist_pass:${singleSourceDecision.reason}`);
  }
  if (stage3BlockingErrors.length > 0) {
    reasons.push(...stage3BlockingErrors.map((error) => `Stage-3 editorial blocker: ${error}`));
  }
  if (Number.isFinite(minCoherence) && Number.isFinite(Number(coherenceScore)) && Number(coherenceScore) < minCoherence) {
    const gateMentionsCoherence = gateNotes.some((note) => /coherence|mixes unrelated/i.test(String(note || '')));
    const stage3MentionsCoherence = stage3BlockingErrors.some((error) => /coherence|mixes unrelated/i.test(String(error || '')));
    if (hasEntitySignal && (gateMentionsCoherence || stage3MentionsCoherence || !gatePassed)) {
      reasons.push(`Source-pack coherence below pre-write threshold (${Number(coherenceScore).toFixed(2)} < ${minCoherence.toFixed(2)})`);
    } else {
      warnings.push(`Low coherence observed but not treated as blocker (${Number(coherenceScore).toFixed(2)} < ${minCoherence.toFixed(2)})`);
    }
  }

  if (mode === 'qna') {
    const question = String(questionCandidate?.question || '').trim();
    if (!question) reasons.push('Missing concrete reader question');
    if (questionCandidate && questionCandidate.selection_eligible === false) {
      reasons.push('Question candidate failed selection eligibility');
    }
  }

  for (const note of gateNotes) {
    const text = String(note || '').toLowerCase();
    if (text.includes('coherence too low') || text.includes('mixes unrelated')) {
      warnings.push(note);
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    warnings: Array.from(new Set(warnings)),
    metrics: {
      mode,
      source_count: sourceCount,
      unique_domains: domainCount,
      trusted_reporting_sources: roleCounts.trustedReporting,
      official_primary_sources: roleCounts.officialPrimary,
      coherence_score: Number.isFinite(Number(coherenceScore)) ? Number(coherenceScore) : null,
      min_sources: minSources,
      min_domains: minDomains,
      min_coherence: Number.isFinite(minCoherence) ? minCoherence : null,
      gate_passed: gatePassed,
      gate_notes: gateNotes,
      stage3_blocking_errors: stage3BlockingErrors,
      has_entity_signal: hasEntitySignal,
      single_source_whitelist: singleSourceDecision,
      brief_title: brief?.title || null,
    },
  };
}

function evaluateSingleSourceWhitelistEligibility({
  brief = {},
  sources = [],
  sourceCount = 0,
  domainCount = 0,
  coherenceScore = null,
  roleCounts = { trustedReporting: 0, officialPrimary: 0 },
  options = {},
} = {}) {
  const enabled = parseBooleanFlag(
    options.enableSingleSourceWhitelist
    ?? options.singleSourceWhitelist
    ?? process.env.QWEN_ENABLE_SINGLE_SOURCE_WHITELIST
  ) === true;
  if (!enabled) return { enabled: false, pass: false, reason: 'disabled' };
  if (sourceCount !== 1) return { enabled: true, pass: false, reason: 'publishable_count_not_one' };
  if (domainCount !== 1) return { enabled: true, pass: false, reason: 'domain_count_not_one' };
  if (isHighRiskBrief(brief)) return { enabled: true, pass: false, reason: 'high_risk_topic_requires_multi_source' };

  const source = Array.isArray(sources) ? sources[0] : null;
  const domain = source?.canonical_domain || source?.domain || source?.canonical_url || source?.url || '';
  if (!isStrictSingleSourceWhitelistDomain(domain)) {
    return { enabled: true, pass: false, reason: 'domain_not_in_strict_single_source_whitelist' };
  }
  if ((Number(roleCounts.trustedReporting || 0) + Number(roleCounts.officialPrimary || 0)) < 1) {
    return { enabled: true, pass: false, reason: 'missing_trusted_or_official_role' };
  }

  const pageKind = String(source?.page_kind || '').toLowerCase();
  if (['homepage', 'section', 'topic', 'live', 'roundup'].includes(pageKind)) {
    return { enabled: true, pass: false, reason: `non_publishable_page_kind:${pageKind}` };
  }
  const title = String(source?.title || '').toLowerCase();
  const sourceUrl = String(source?.canonical_url || source?.url || '').toLowerCase();
  if (/(live updates?|latest news|category|tag|topics?)/.test(title) || /\/(live|category|tag|topics?)\//.test(sourceUrl)) {
    return { enabled: true, pass: false, reason: 'generic_or_container_source' };
  }

  const minSingleSourceCoherence = Number(
    options.singleSourceWhitelistMinCoherence
    ?? process.env.QWEN_SINGLE_SOURCE_WHITELIST_MIN_COHERENCE
    ?? 0.72
  );
  if (Number.isFinite(minSingleSourceCoherence) && Number.isFinite(Number(coherenceScore)) && Number(coherenceScore) < minSingleSourceCoherence) {
    return { enabled: true, pass: false, reason: `coherence_below_threshold:${Number(coherenceScore).toFixed(2)}<${minSingleSourceCoherence}` };
  }

  return { enabled: true, pass: true, reason: 'strict_whitelist_single_source_ok' };
}

function isHighRiskBrief(brief = {}) {
  const highRiskTopicIds = new Set([
    'world-geopolitics',
    'us-politics',
    'law-crime',
    'climate-extreme-weather',
  ]);
  if (highRiskTopicIds.has(String(brief?.topic_id || '').toLowerCase())) return true;
  const text = `${brief?.title || ''} ${brief?.whatHappened || ''} ${brief?.whyItMatters || ''}`.toLowerCase();
  return /(killed|dead|deaths|war|attack|airstrike|hostage|terror|indicted|charged|sanction|lawsuit|verdict|court)/.test(text);
}

function parseBooleanFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}
