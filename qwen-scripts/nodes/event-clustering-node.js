// File: qwen-scripts/nodes/event-clustering-node.js
// Purpose: Group discovered materials into event clusters with softer handling for generic/support/background signals.

import { normalizeSourceMaterial, normalizeTitle } from '../utils/source-normalization.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'after', 'over', 'under', 'have', 'has', 'had',
  'are', 'was', 'were', 'will', 'would', 'could', 'should', 'news', 'latest', 'breaking', 'report', 'reports',
  'says', 'said', 'amid', 'today', 'live', 'updates', 'video', 'podcast', 'story', 'stories'
]);

export function clusterDiscoveredCandidates(candidates = [], options = {}) {
  const prepared = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => prepareCandidate(candidate))
    .filter(Boolean)
    .sort((a, b) => (b.discoveryScore || 0) - (a.discoveryScore || 0));

  const clusters = [];

  for (const candidate of prepared) {
    let bestCluster = null;
    let bestScore = -Infinity;

    for (const cluster of clusters) {
      const score = scoreClusterFit(candidate, cluster);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= (options.threshold || 6)) {
      addCandidateToCluster(bestCluster, candidate);
      continue;
    }

    clusters.push(createCluster(candidate));
  }

  return clusters
    .map(finalizeCluster)
    .sort((a, b) => {
      if (b.clusterScore !== a.clusterScore) return b.clusterScore - a.clusterScore;
      return new Date(b.latestSeenAt || 0) - new Date(a.latestSeenAt || 0);
    });
}

function prepareCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const material = normalizeSourceMaterial(candidate, { sourceId: candidate.id || candidate.source_id });
  if (!material) return null;

  const text = `${material.normalized_title || normalizeTitle(candidate.title || '')} ${candidate.summary || ''}`.toLowerCase();
  const keywords = Array.from(new Set(text
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
  )).slice(0, 12);

  return {
    ...candidate,
    ...material,
    keywords,
    entities: material.entities || [],
    section_id: material.section_id || null,
    topic_id: material.topic_id || null,
    region: material.region || 'global',
    angle: material.angle || 'general',
    action: inferAction(text),
    place: inferPlace(material.region, text),
    canonicalUrl: material.canonical_url,
    titleTokens: extractImportantTokens(material.title || candidate.title || ''),
  };
}

function createCluster(candidate) {
  return {
    items: [candidate],
    representative: candidate,
    sectionVotes: new Map(candidate.section_id ? [[candidate.section_id, candidateVoteWeight(candidate)]] : []),
    topicVotes: new Map(candidate.topic_id ? [[candidate.topic_id, candidateVoteWeight(candidate)]] : []),
    entityVotes: new Map(candidate.entities.map((entity) => [entity, candidateVoteWeight(candidate) * 0.7])),
    keywordVotes: new Map(candidate.keywords.map((keyword) => [keyword, candidateVoteWeight(candidate) * 0.5])),
    regionVotes: new Map([[candidate.region || 'global', candidateVoteWeight(candidate)]]),
    angleVotes: new Map([[candidate.angle || 'general', candidateVoteWeight(candidate) * 0.8]]),
    actionVotes: new Map(candidate.action ? [[candidate.action, candidateVoteWeight(candidate) * 0.9]] : []),
    placeVotes: new Map(candidate.place ? [[candidate.place, candidateVoteWeight(candidate) * 0.8]] : []),
    latestSeenAt: candidate.discoveredAt || candidate.when || new Date().toISOString(),
    earliestSeenAt: candidate.discoveredAt || candidate.when || new Date().toISOString(),
    clusterScore: candidate.discoveryScore || 0,
  };
}

function addCandidateToCluster(cluster, candidate) {
  cluster.items.push(candidate);
  cluster.clusterScore += candidate.discoveryScore || 0;
  cluster.representative = chooseRepresentative(cluster.representative, candidate);
  const weight = candidateVoteWeight(candidate);
  vote(cluster.sectionVotes, candidate.section_id, weight);
  vote(cluster.topicVotes, candidate.topic_id, weight);
  vote(cluster.regionVotes, candidate.region || 'global', weight);
  vote(cluster.angleVotes, candidate.angle || 'general', weight * 0.8);
  vote(cluster.actionVotes, candidate.action || null, weight * 0.9);
  vote(cluster.placeVotes, candidate.place || null, weight * 0.8);
  for (const entity of candidate.entities) vote(cluster.entityVotes, entity, weight * 0.7);
  for (const keyword of candidate.keywords) vote(cluster.keywordVotes, keyword, weight * 0.5);
  if (new Date(candidate.discoveredAt || candidate.when || 0) > new Date(cluster.latestSeenAt || 0)) {
    cluster.latestSeenAt = candidate.discoveredAt || candidate.when || cluster.latestSeenAt;
  }
  if (new Date(candidate.discoveredAt || candidate.when || 0) < new Date(cluster.earliestSeenAt || 0)) {
    cluster.earliestSeenAt = candidate.discoveredAt || candidate.when || cluster.earliestSeenAt;
  }
}

function chooseRepresentative(current, candidate) {
  if (!current) return candidate;
  return representativeScore(candidate) > representativeScore(current) ? candidate : current;
}

function representativeScore(candidate) {
  return (candidate.discoveryScore || 0)
    + (candidate.trustedSource ? 1 : 0)
    + (candidate.article_likelihood || 0) * 0.7
    - (candidate.genericity_score || 0) * 0.8;
}

function finalizeCluster(cluster) {
  const section_id = pickTopVote(cluster.sectionVotes);
  const topic_id = pickTopVote(cluster.topicVotes);
  const region = pickTopVote(cluster.regionVotes) || 'global';
  const angle = pickTopVote(cluster.angleVotes) || 'general';
  const action = pickTopVote(cluster.actionVotes) || 'general';
  const place = pickTopVote(cluster.placeVotes) || region;
  const entities = topVotes(cluster.entityVotes, 6);
  const keywords = topVotes(cluster.keywordVotes, 8);
  const sourceUrls = Array.from(new Set(cluster.items.flatMap((item) => item.sourceUrls || [item.url]).filter(Boolean)));
  const dayBucket = new Date(cluster.latestSeenAt || Date.now()).toISOString().slice(0, 10);
  const seed = [topic_id || section_id || 'general', action, place, ...entities.slice(0, 2)]
    .filter(Boolean)
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'event';
  const articleRichCount = cluster.items.filter((item) => (item.article_likelihood || 0) >= 5).length;
  const genericSignalCount = cluster.items.filter((item) => (item.genericity_score || 0) >= 6).length;

  return {
    clusterId: `evt-${dayBucket}-${seed}`,
    eventKey: `${dayBucket}:${seed}`,
    section_id,
    topic_id,
    region,
    angle,
    action,
    place,
    entities,
    keywords,
    representative: cluster.representative,
    candidates: cluster.items,
    candidateCount: cluster.items.length,
    sourceUrls,
    trustedSourceCount: cluster.items.filter((item) => item.trustedSource).length,
    genericPageCount: genericSignalCount,
    articleRichCount,
    latestSeenAt: cluster.latestSeenAt,
    earliestSeenAt: cluster.earliestSeenAt,
    clusterScore: Math.round((cluster.clusterScore + articleRichCount * 2 - genericSignalCount * 0.5 + cluster.items.length) * 10) / 10,
    canonicalTitle: cluster.representative?.title || 'Untitled event',
  };
}

function scoreClusterFit(candidate, cluster) {
  const representative = cluster.representative || {};
  let score = 0;
  if (candidate.topic_id && representative.topic_id && candidate.topic_id === representative.topic_id) score += 3;
  else if (candidate.topic_id && representative.topic_id && candidate.topic_id !== representative.topic_id) score -= 4.5;
  if (candidate.section_id && representative.section_id && candidate.section_id === representative.section_id) score += 2;
  else if (candidate.section_id && representative.section_id && candidate.section_id !== representative.section_id) score -= 3.5;
  if (candidate.region && representative.region && candidate.region === representative.region) score += 1;
  if (candidate.angle && representative.angle && candidate.angle === representative.angle) score += 0.5;
  if (candidate.action && representative.action && candidate.action === representative.action) score += 1.5;
  if (candidate.place && representative.place && candidate.place === representative.place) score += 1;
  if (candidate.canonicalUrl && representative.canonicalUrl && candidate.canonicalUrl === representative.canonicalUrl) score += 8;
  if (candidate.normalized_title && representative.normalized_title && candidate.normalized_title === representative.normalized_title) score += 6;

  const entityOverlap = intersectCount(candidate.entities, representative.entities || []);
  const keywordOverlap = intersectCount(candidate.keywords, representative.keywords || []);
  const titleOverlap = intersectCount(candidate.titleTokens || [], representative.titleTokens || []);
  score += Math.min(4, entityOverlap * 2);
  score += Math.min(4, keywordOverlap);
  score += Math.min(3, titleOverlap * 1.5);

  if (candidate.section_id && representative.section_id && candidate.section_id !== representative.section_id && entityOverlap === 0 && keywordOverlap < 2 && titleOverlap === 0) {
    score -= 3;
  }
  if (candidate.action && representative.action && candidate.action !== representative.action && candidate.action !== 'general' && representative.action !== 'general' && entityOverlap === 0 && titleOverlap === 0) {
    score -= 3;
  }
  if (candidate.place && representative.place && candidate.place !== representative.place && candidate.place !== 'global' && representative.place !== 'global' && entityOverlap === 0 && titleOverlap === 0) {
    score -= 2.5;
  }

  const sameDay = (candidate.discoveredAt || '').slice(0, 10) && (candidate.discoveredAt || '').slice(0, 10) === (cluster.latestSeenAt || '').slice(0, 10);
  if (sameDay) score += 1;
  if ((candidate.article_likelihood || 0) >= 5 && (representative.article_likelihood || 0) >= 5) score += 1;
  if ((candidate.genericity_score || 0) >= 7 && (representative.genericity_score || 0) >= 7) score += 0.5;

  return score;
}

function vote(map, key, weight = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + weight);
}

function pickTopVote(map) {
  const entries = Array.from((map || new Map()).entries()).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || null;
}

function topVotes(map, limit) {
  return Array.from((map || new Map()).entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function extractImportantTokens(value = '') {
  return Array.from(new Set(String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token))));
}

function textContainsPattern(text = '', pattern = '') {
  const normalizedText = String(text || '').toLowerCase();
  const normalizedPattern = String(pattern || '').toLowerCase().trim();
  if (!normalizedPattern) return false;
  const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(normalizedText);
}

function candidateVoteWeight(candidate = {}) {
  const articleLikelihood = Number(candidate.article_likelihood || 0);
  const genericity = Number(candidate.genericity_score || 0);
  const sourceQuality = Number(candidate.source_quality_score || candidate.sourceQualityScore || 0);
  const trustedBoost = candidate.trustedSource ? 0.8 : 0;
  const weight = 1 + articleLikelihood * 0.45 + sourceQuality * 0.08 + trustedBoost - genericity * 0.18;
  return Math.max(0.35, Math.round(weight * 100) / 100);
}

function intersectCount(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function inferAction(text = '') {
  const patterns = [
    ['ceasefire', 'ceasefire'], ['shutdown', 'shutdown'], ['earnings', 'earnings'], ['lawsuit', 'lawsuit'],
    ['announcement', 'announcement'], ['announce', 'announcement'], ['approval', 'approval'], ['approve', 'approval'],
    ['charges', 'charges'], ['charge', 'charges'], ['warning', 'warning'], ['warn', 'warning'],
    ['research', 'research'], ['launch', 'launch'], ['delay', 'delays'], ['attack', 'attack'],
    ['trial', 'trial'], ['vote', 'vote'], ['ban', 'ban'], ['signing', 'signing'], ['sign', 'signing'],
  ];
  const match = patterns.find(([pattern]) => textContainsPattern(text, pattern));
  return match?.[1] || 'general';
}

function inferPlace(region = '', text = '') {
  const lower = `${region || ''} ${text || ''}`.toLowerCase();
  const patterns = ['united states', 'washington', 'middle east', 'china', 'russia', 'ukraine', 'iran', 'israel', 'india', 'europe', 'us'];
  const match = patterns.find((pattern) => textContainsPattern(lower, pattern));
  return match || String(region || 'global').toLowerCase();
}
