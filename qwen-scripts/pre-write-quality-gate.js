// File: qwen-scripts/pre-write-quality-gate.js
// Purpose: Shared pre-write quality gate to block weak candidates before any expensive writer-token stages.

import {
  countEvidenceRoles,
  getSingleSourceEvidenceDecision,
  inferPublishableSources,
  inferUniqueDomains,
} from './utils/evidence-policy.js';

export function evaluatePreWriteQualityGate({
  brief = {},
  sourcePack = {},
  questionCandidate = null,
  mode = 'article',
  coherenceScore = null,
} = {}, options = {}) {
  const reasons = [];
  const warnings = [];

  const minSources = Math.max(1, Number(options.minSources || process.env.QWEN_PREWRITE_MIN_SOURCES || 1));
  const minDomains = Math.max(1, Number(options.minDomains || process.env.QWEN_PREWRITE_MIN_DOMAINS || 1));
  const minCoherence = Number(options.minCoherence || process.env.QWEN_PREWRITE_MIN_COHERENCE || 0.45);

  const sources = inferPublishableSources(sourcePack);
  const sourceCount = sources.length;
  const domainCount = Number(sourcePack?.uniqueDomains || 0) || inferUniqueDomains(sources);
  const gatePassed = Boolean(sourcePack?.passesGate);
  const gateNotes = Array.isArray(sourcePack?.gateNotes) ? sourcePack.gateNotes : [];
  const roleCounts = countEvidenceRoles(sources);
  const stage3BlockingErrors = (sourcePack?.stage3EditorialGate?.blocking_errors || [])
    .filter((message) => !String(message || '').startsWith('Primary topic_id unsupported by source-pack evidence'));
  const entitySignals = [
    ...(Array.isArray(brief?.entities) ? brief.entities : []),
    ...(Array.isArray(brief?.involvedParties) ? brief.involvedParties : []),
    ...(Array.isArray(brief?.keyEntities) ? brief.keyEntities : []),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const hasEntitySignal = entitySignals.length > 0;
  const singleSourceDecision = getSingleSourceEvidenceDecision({
    brief,
    articleType: brief?.articleType || brief?.article_type || sourcePack?.articleType || 'report',
    sources,
    coherenceScore: Number.isFinite(Number(coherenceScore)) ? Number(coherenceScore) : null,
    sourceConsistencyScore: sourcePack?.metrics?.sourceConsistencyScore,
    directEventSourceCount: sourcePack?.metrics?.directEventSourceCount || 0,
    crossTopicMismatchCount: 0,
  });

  if (!gatePassed) reasons.push('Source-pack gate not passed');
  if (sourceCount < minSources) {
    reasons.push(`Not enough publishable sources (${sourceCount}/${minSources})`);
  }
  if (domainCount < minDomains) {
    reasons.push(`Not enough independent domains (${domainCount}/${minDomains})`);
  }
  if (sourceCount === 1 && !singleSourceDecision.pass) {
    reasons.push(`Single-source evidence not strong enough (${singleSourceDecision.reason})`);
  }
  if (roleCounts.trustedReporting < 1 && roleCounts.officialPrimary < 1) {
    reasons.push('Missing trusted reporting or official primary source');
  }
  if (singleSourceDecision.enabled && !singleSourceDecision.pass && sourceCount === 1) {
    warnings.push(`single_source_rejected:${singleSourceDecision.reason}`);
  }
  if (singleSourceDecision.pass) {
    warnings.push(`single_source_pass:${singleSourceDecision.reason}`);
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
