// File: qwen-scripts/nodes/source-role-node.js
// Purpose: Assign editorial roles to normalized source materials instead of rejecting everything through one hard filter.

const ARTICLE_ROLE_FLOOR = 5;
const TITLE_STOP_TOKENS = new Set([
  'the','and','for','with','amid','from','that','this','into','after','over','under','have','has','had','are','was','were','will','would','could','should',
  'news','latest','breaking','report','reports','live','updates','today','story','stories','meet','first','time'
]);

const GENERIC_MATCH_TOKENS = new Set([
  'health','public','policy','policies','care','reform','mental','women','events','providers','provider','companies','company','stocks','stock','earnings',
  'business','sports','culture','world','news','latest','breaking','official','statement','report','reports','analysis','article','stories','story'
]);

export function classifySourceRole(material, brief = {}) {
  const source = material || {};
  const reasons = [];
  const sourceText = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
  const briefText = `${brief.title || ''} ${brief.whatHappened || ''} ${brief.whyItMatters || ''}`.toLowerCase();
  const sourceEntities = normalizeList(source.entities);
  const briefEntities = normalizeList(brief.entities || brief.involvedParties);
  const sourceKeywords = normalizeKeywordList(source.keywords);
  const briefKeywords = normalizeKeywordList(extractBriefKeywords(brief));
  const sourceTitleTokens = extractTitleTokens(source.title);
  const briefTitleTokens = extractTitleTokens(brief.title);
  const sourceSignatureTokens = extractSignatureTokens(source.title);
  const briefSignatureTokens = extractSignatureTokens(brief.title);

  let sameEventScore = 0;
  let topicFitScore = 0;
  let confidence = 0;

  const sameCluster = !!(brief.cluster_id && source.cluster_id && brief.cluster_id === source.cluster_id);
  const sameEventKey = !!(brief.eventKey && source.event_key && brief.eventKey === source.event_key);

  if (sameCluster) {
    sameEventScore += 5;
    reasons.push('same_cluster');
  }
  if (sameEventKey) {
    sameEventScore += 4;
    reasons.push('same_event_key');
  }
  if (brief.topic_id && source.topic_id && brief.topic_id === source.topic_id) {
    topicFitScore += 4;
    reasons.push('same_topic');
  } else if (brief.topic_id && source.topic_id && brief.topic_id !== source.topic_id) {
    topicFitScore -= 5;
    reasons.push('different_topic');
  }
  if (brief.section_id && source.section_id && brief.section_id === source.section_id) {
    topicFitScore += 2;
    reasons.push('same_section');
  } else if (brief.section_id && source.section_id && brief.section_id !== source.section_id) {
    topicFitScore -= 3;
    reasons.push('different_section');
  }
  if (brief.region && source.region && brief.region === source.region) {
    topicFitScore += 1;
    reasons.push('same_region');
  }
  if (brief.angle && source.angle && brief.angle === source.angle) {
    topicFitScore += 1;
    reasons.push('same_angle');
  }

  const entityHits = overlapCount(sourceEntities, briefEntities);
  const keywordHits = overlapCount(sourceKeywords, briefKeywords);
  const titleHits = overlapCount(sourceTitleTokens, briefTitleTokens);
  const signatureHits = overlapCount(sourceSignatureTokens, briefSignatureTokens);
  const titleOverlapRatio = computeOverlapRatio(sourceTitleTokens, briefTitleTokens);
  sameEventScore += Math.min(6, entityHits * 2 + Math.min(2, keywordHits));
  if (entityHits > 0) reasons.push(`entity_hits:${entityHits}`);
  if (keywordHits > 0) reasons.push(`keyword_hits:${keywordHits}`);
  if (titleHits >= 2 && titleOverlapRatio >= 0.25) {
    sameEventScore += Math.min(5, titleHits + 1);
    reasons.push(`title_hits:${titleHits}`);
    reasons.push(`title_overlap:${titleOverlapRatio.toFixed(2)}`);
  }
  if (signatureHits > 0) {
    sameEventScore += Math.min(4, signatureHits * 2);
    reasons.push(`signature_hits:${signatureHits}`);
  }
  if (source.normalized_title && brief.title && normalizeTitle(source.normalized_title) === normalizeTitle(brief.title)) {
    sameEventScore += 4;
    reasons.push('exact_title_match');
  }
  if (briefText && sourceText && sourceText.includes(briefText.slice(0, Math.min(60, briefText.length))) && briefText.length >= 24) {
    sameEventScore += 2;
    reasons.push('brief_phrase_match');
  }

  if (
    brief.section_id && source.section_id && brief.section_id !== source.section_id
    && brief.topic_id && source.topic_id && brief.topic_id !== source.topic_id
    && entityHits === 0 && signatureHits === 0 && !(titleHits >= 2 && titleOverlapRatio >= 0.25)
  ) {
    sameEventScore -= 3;
    confidence -= 1;
    reasons.push('cross_desk_weak_overlap');
  }

  if (source.article_likelihood >= 7) {
    confidence += 2;
    reasons.push('article_like');
  }
  if (source.page_kind === 'official_release') {
    confidence += 2;
    reasons.push('official_release');
  }
  if (source.page_kind === 'analysis') {
    confidence += 1;
    reasons.push('analysis_page');
  }
  if (source.genericity_score >= 7) {
    confidence -= 2;
    reasons.push('high_genericity');
  }

  const titleStrong = titleHits >= 2 && titleOverlapRatio >= 0.25;
  const titleModerate = titleHits >= 2 && titleOverlapRatio >= 0.18;
  const strongEventAnchor = sameCluster || sameEventKey || entityHits >= 1 || signatureHits >= 1 || titleStrong || sameEventScore >= 5;
  const moderateEventAnchor = strongEventAnchor || titleModerate || sameEventScore >= 4;
  const articleLike = source.page_kind === 'article' || source.page_kind === 'official_release' || source.page_kind === 'analysis' || source.article_likelihood >= ARTICLE_ROLE_FLOOR;

  const total = sameEventScore + topicFitScore + confidence;

  let role = 'signal_only';
  if (source.page_kind === 'homepage' || source.page_kind === 'video' || source.page_kind === 'audio') {
    role = 'reject';
    reasons.push('page_kind_reject');
  } else if (['section', 'topic', 'live', 'roundup'].includes(source.page_kind)) {
    role = total >= 7 ? 'background' : 'signal_only';
    reasons.push('generic_container');
  } else if (articleLike && total >= 10 && strongEventAnchor) {
    role = 'core';
    reasons.push('core_threshold');
  } else if (articleLike && total >= 7 && moderateEventAnchor) {
    role = 'supporting';
    reasons.push('supporting_threshold');
  } else if (total >= 5) {
    role = 'background';
    reasons.push('background_threshold');
  } else if (total >= 3) {
    role = 'signal_only';
    reasons.push('signal_threshold');
  } else {
    role = 'reject';
    reasons.push('weak_match');
  }

  return {
    role,
    role_confidence: clamp(Math.round((total + 4) * 8), 0, 100),
    role_reason: reasons,
    same_event_score: sameEventScore,
    topic_fit_score: topicFitScore,
    genericity_score: source.genericity_score || 0,
    article_likelihood: source.article_likelihood || 0,
    page_kind: source.page_kind || 'unknown',
    source_id: source.source_id,
    source,
  };
}

function extractBriefKeywords(brief) {
  return `${brief.title || ''} ${brief.whatHappened || ''} ${brief.whyItMatters || ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !GENERIC_MATCH_TOKENS.has(token))
    .slice(0, 16);
}

function extractTitleTokens(value) {
  return Array.from(new Set(String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !TITLE_STOP_TOKENS.has(token))));
}

function extractSignatureTokens(value) {
  return extractTitleTokens(value).filter((token) => token.length >= 5 && !GENERIC_MATCH_TOKENS.has(token)).slice(0, 8);
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeList(values) {
  const raw = Array.isArray(values) ? values : String(values || '').split(/,|;/);
  return Array.from(new Set(raw.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)));
}

function normalizeKeywordList(values) {
  return normalizeList(values).filter((value) => value.length >= 4 && !GENERIC_MATCH_TOKENS.has(value));
}

function overlapCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function computeOverlapRatio(left, right) {
  const overlap = overlapCount(left, right);
  return overlap / Math.max(left.length, right.length, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
