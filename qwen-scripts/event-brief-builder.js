// File: qwen-scripts/event-brief-builder.js
// Purpose: Normalize clustered discovery candidates into structured event briefs.

/**
 * @typedef {Object} NormalizedEventBrief
 * @property {string} id
 * @property {string} title
 * @property {string} whatHappened
 * @property {string} whoIsInvolved
 * @property {string[]} involvedParties
 * @property {string[]} entities
 * @property {string} when
 * @property {string} where
 * @property {string} whyItMatters
 * @property {string} developmentStage
 * @property {string[]} sourceUrls
 * @property {number} publishabilityScore
 * @property {string[]} publishabilityNotes
 * @property {string|null} section_id
 * @property {string|null} topic_id
 * @property {string} region
 * @property {string} angle
 * @property {string|null} cluster_id
 * @property {string|null} eventKey
 */

export async function normalizeEventBrief(rawBrief, _openAiApiKey) {
  const title = cleanEditorialTitle(rawBrief.title);
  const involvedParties = normalizeParties(
    rawBrief.involvedParties
    || rawBrief.entities
    || extractPartiesFromText(`${rawBrief.title || ''} ${rawBrief.summary || ''}`)
  );
  const whatHappened = buildWhatHappened(rawBrief, title);
  const when = buildWhen(rawBrief.when || rawBrief.latestSeenAt);
  const where = inferWhere(rawBrief, involvedParties);
  const whyItMatters = inferWhyItMatters(rawBrief, title, involvedParties);
  const developmentStage = inferDevelopmentStage(rawBrief, title);
  const scoring = scorePublishability(rawBrief, involvedParties, title, whatHappened);

  return {
    id: rawBrief.id || rawBrief.clusterId,
    title,
    whatHappened,
    whoIsInvolved: involvedParties.length > 0 ? involvedParties.join(', ') : 'Not confirmed',
    involvedParties,
    entities: involvedParties,
    when,
    where,
    whyItMatters,
    developmentStage,
    sourceUrls: uniqueStrings(rawBrief.sourceUrls || []),
    publishabilityScore: scoring.score,
    publishabilityNotes: scoring.notes,
    discoveredAt: rawBrief.discoveredAt || rawBrief.latestSeenAt,
    provider: rawBrief.provider || 'cluster',
    section_id: rawBrief.section_id || rawBrief.detectedSectionId || null,
    topic_id: rawBrief.topic_id || rawBrief.detectedTopicId || null,
    region: rawBrief.region || inferRegion(rawBrief, title) || 'global',
    angle: rawBrief.angle || inferAngle(rawBrief, title) || 'general',
    cluster_id: rawBrief.clusterId || rawBrief.cluster_id || null,
    eventKey: rawBrief.eventKey || null,
    cluster_size: Number(rawBrief.clusterSize || rawBrief.candidateCount || 1),
    article_rich_count: Number(rawBrief.articleRichCount || rawBrief.article_rich_count || 0),
    generic_page_count: Number(rawBrief.genericPageCount || rawBrief.generic_page_count || 0),
    discoveryContext: Array.isArray(rawBrief.discoveryContext) ? rawBrief.discoveryContext : [],
  };
}

export async function normalizeClusteredBrief(cluster, openAiApiKey) {
  const representative = cluster?.representative || {};
  return normalizeEventBrief({
    id: cluster.clusterId,
    title: cluster.canonicalTitle || representative.title,
    summary: representative.summary || representative.description || '',
    when: representative.when || cluster.latestSeenAt,
    sourceUrls: cluster.sourceUrls || representative.sourceUrls || [],
    discoveredAt: cluster.latestSeenAt || representative.discoveredAt,
    provider: representative.provider || 'cluster',
    entities: cluster.entities || representative.entities || [],
    involvedParties: cluster.entities || representative.entities || [],
    section_id: cluster.section_id || representative.section_id || representative.detectedSectionId,
    topic_id: cluster.topic_id || representative.topic_id || representative.detectedTopicId,
    clusterId: cluster.clusterId,
    eventKey: cluster.eventKey,
    region: cluster.region || representative.region,
    angle: cluster.angle || representative.angle,
    clusterSize: cluster.candidateCount,
    latestSeenAt: cluster.latestSeenAt,
    discoveryContext: cluster.candidates || [],
    freshness: representative.freshness,
    urgency: representative.urgency,
    genericPage: representative.genericPage || (cluster.genericPageCount >= cluster.candidateCount && (cluster.articleRichCount || 0) === 0),
    trustedSource: cluster.trustedSourceCount > 0,
    articleRichCount: cluster.articleRichCount || 0,
    genericPageCount: cluster.genericPageCount || 0,
  }, openAiApiKey);
}

export function selectBestTopic(briefs) {
  if (!briefs || briefs.length === 0) return null;

  const publishable = briefs.filter((brief) => brief.publishabilityScore >= 6);
  const candidates = publishable.length > 0 ? publishable : briefs;
  candidates.sort((a, b) => {
    const scoreDiff = (b.publishabilityScore || 0) - (a.publishabilityScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const articleDiff = (b.article_rich_count || 0) - (a.article_rich_count || 0);
    if (articleDiff !== 0) return articleDiff;
    const clusterDiff = (b.cluster_size || 1) - (a.cluster_size || 1);
    if (clusterDiff !== 0) return clusterDiff;
    return new Date(b.discoveredAt || 0) - new Date(a.discoveredAt || 0);
  });

  return candidates[0];
}

function cleanEditorialTitle(title) {
  return String(title || 'Untitled story')
    .replace(/\s+/g, ' ')
    .replace(/\s+[|\-–:]\s*[^|\-–:]{1,30}$/g, '')
    .trim()
    .substring(0, 110);
}

function buildWhatHappened(rawBrief, fallbackTitle) {
  const firstSentence = getFirstSentence(rawBrief.summary || '');
  if (firstSentence.length >= 50) return ensureSentence(firstSentence);
  if (String(rawBrief.summary || '').trim()) return ensureSentence(rawBrief.summary.trim().substring(0, 220));
  return ensureSentence(fallbackTitle);
}

function buildWhen(value) {
  const clean = String(value || '').trim();
  if (!clean) return 'Not confirmed';
  return clean;
}

function inferWhere(rawBrief, involvedParties) {
  const text = `${rawBrief.title || ''} ${rawBrief.summary || ''}`;
  const inMatch = text.match(/\b(?:in|at|near|across)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/);
  if (inMatch?.[1]) return inMatch[1].trim();
  if (rawBrief.region && rawBrief.region !== 'global') return rawBrief.region;
  const geoParty = involvedParties.find((party) => KNOWN_GEOGRAPHIES.has(party.toLowerCase()));
  return geoParty || 'Not specified';
}

function inferWhyItMatters(rawBrief, title, involvedParties) {
  const text = `${title} ${rawBrief.summary || ''} ${involvedParties.join(' ')}`.toLowerCase();
  const topicId = rawBrief.topic_id || rawBrief.detectedTopicId || null;

  if (topicId === 'travel-consumer-issues') {
    return 'The development could affect traveler wait times, service reliability, or access to transportation services.';
  }
  if (topicId === 'pharma-fda') {
    return 'The development could matter for treatment access, regulation, or how quickly patients and providers respond.';
  }
  if (topicId === 'world-geopolitics') {
    return 'The development could affect diplomacy, security decisions, or regional stability as the situation develops.';
  }
  if (topicId === 'us-politics') {
    return 'The development could affect policy decisions, government operations, or how public institutions respond next.';
  }

  if (/(election|policy|congress|senate|white house|government|minister|court|shutdown|delays|airport|tsa)/.test(text)) {
    return 'The development could shape public services, public policy, or institutional decision-making.';
  }
  if (/(iran|israel|ukraine|russia|china|conflict|war|military|missile|sanction|ceasefire|geopolit)/.test(text)) {
    return 'The development could affect international security, diplomacy, or energy markets as the situation develops.';
  }
  if (/(market|economy|inflation|stocks|bond|bank|tariff|trade|jobs|gdp|housing|mortgage)/.test(text)) {
    return 'The development could influence business conditions, investor sentiment, consumer costs, or economic policy.';
  }
  if (/(ai|artificial intelligence|cyber|security|chip|software|cloud|technology|platform)/.test(text)) {
    return 'The development matters because it may affect technology adoption, competition, regulation, or security decisions.';
  }
  if (/(health|fda|drug|medical|research|trial|disease|hospital|mental health|fitness)/.test(text)) {
    return 'The development could matter for public health, regulation, scientific progress, or access to treatment.';
  }
  if (/(league|playoff|tournament|transfer|coach|athlete|sports)/.test(text)) {
    return 'The development could reshape competition, fan attention, or the business side of sports.';
  }
  if (/(streaming|movie|film|tv|music|celebrity|creator|tiktok|youtube|viral)/.test(text)) {
    return 'The development could affect entertainment culture, platform behavior, or the creator economy.';
  }

  return 'The development appears timely enough to matter to readers, but the full downstream impact is still developing.';
}

function inferDevelopmentStage(rawBrief, title) {
  const text = `${title} ${rawBrief.summary || ''}`.toLowerCase();
  if (/(resolved|settled|ended|approved|signed|completed|closed)/.test(text)) return 'resolved';
  if ((rawBrief.freshness || 0) >= 8 || /(breaking|just in|developing)/.test(text)) return 'breaking';
  if ((rawBrief.freshness || 0) >= 5) return 'developing';
  return 'confirmed';
}

function scorePublishability(rawBrief, involvedParties, title, whatHappened) {
  let score = 4;
  const notes = [];
  const sourceCount = uniqueStrings(rawBrief.sourceUrls || []).length;

  if (whatHappened.length >= 60) {
    score += 1;
    notes.push('Has a usable summary sentence');
  } else {
    notes.push('Thin summary detail');
  }

  if (involvedParties.length > 0 && !involvedParties.includes('Unspecified')) {
    score += 1;
    notes.push('Specific parties are identified');
  } else {
    notes.push('Parties remain unclear');
  }

  if ((rawBrief.freshness || 0) >= 8) {
    score += 2;
    notes.push('Very fresh development');
  } else if ((rawBrief.freshness || 0) >= 5) {
    score += 1;
    notes.push('Fresh enough for same-day editorial use');
  } else {
    notes.push('Freshness is moderate');
  }

  if ((rawBrief.urgency || 0) >= 7) {
    score += 1;
    notes.push('Story has a clear urgency signal');
  }

  if (sourceCount >= 2) {
    score += 1;
    notes.push('Multiple source URLs already attached');
  } else {
    notes.push('Source diversity still needs source-pack validation');
  }

  if ((rawBrief.clusterSize || rawBrief.candidateCount || 1) >= 2) {
    score += 1;
    notes.push('Clustered across multiple discovery hits');
  }

  if ((rawBrief.articleRichCount || rawBrief.article_rich_count || 0) >= 2) {
    score += 1;
    notes.push('Cluster contains multiple article-like materials');
  }

  if (rawBrief.topic_id || rawBrief.detectedTopicId) {
    score += 1;
    notes.push('Taxonomy topic match is specific enough for routing');
  }

  if ((rawBrief.genericPage && (rawBrief.articleRichCount || rawBrief.article_rich_count || 0) === 0) || /(podcast|video)/i.test(`${title} ${rawBrief.summary || ''}`)) {
    score -= 3;
    notes.push('Looks like non-article format without article support');
  } else if (rawBrief.genericPage) {
    notes.push('Generic signal retained because the cluster still has article support');
  }

  if (rawBrief.trustedSource) {
    score += 1;
    notes.push('At least one trusted source hit is present');
  }

  return { score: Math.max(1, Math.min(10, score)), notes };
}

function getFirstSentence(text) {
  const clean = String(text || '').trim();
  const match = clean.match(/^(.{20,220}?[.!?])(\s|$)/);
  return match?.[1] || clean;
}

function ensureSentence(value) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'Not confirmed.';
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function extractPartiesFromText(text) {
  return normalizeParties(
    String(text || '')
      .split(/\s+/)
      .filter((token) => /^[A-Z][A-Za-z0-9&.-]+$/.test(token))
      .slice(0, 6)
  );
}

function normalizeParties(values) {
  const list = Array.isArray(values) ? values : [values];
  const normalized = uniqueStrings(list.map((value) => String(value || '').trim()).filter(Boolean));
  return normalized.length > 0 ? normalized : ['Unspecified'];
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function inferRegion(rawBrief, title) {
  const text = `${title} ${rawBrief.summary || ''}`.toLowerCase();
  if (/(white house|congress|senate|u\.s\.|united states|tsa|faa|federal)/.test(text)) return 'us';
  if (/middle east|iran|israel|gaza|syria/.test(text)) return 'middle-east';
  return rawBrief.region || 'global';
}

function inferAngle(rawBrief, title) {
  const text = `${title} ${rawBrief.summary || ''}`.toLowerCase();
  if (/(shutdown|delay|airport|consumer)/.test(text)) return 'consumer-impact';
  if (/(court|judge|lawsuit|charged)/.test(text)) return 'legal';
  if (/(policy|congress|senate|white house|federal)/.test(text)) return 'policy';
  return rawBrief.angle || 'general';
}

const KNOWN_GEOGRAPHIES = new Set(['us', 'middle-east', 'ukraine', 'russia', 'china', 'india', 'europe']);
