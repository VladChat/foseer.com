// File: qwen-scripts/writers/writer-selector.js
// Purpose: Canonical writer classification and writer rotation bound to the taxonomy registry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAllWriters } from './writer-registry.js';
import {
  loadTaxonomyRegistry,
  getSectionRecord,
  getTopicRecord,
  matchTaxonomyHints,
  resolveSectionId,
  resolveTopicId,
} from '../utils/taxonomy-registry.js';
import { sanitizeStoryClassification } from '../utils/classification-sanity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROTATION_STATE_PATH = path.resolve(__dirname, '../../qwen-data/writer-rotation-state.json');

let writerUsageState = {
  totalArticles: 0,
  lastReset: null,
  byWriter: {},
  recentAssignments: [],
};

function loadWriterState() {
  try {
    if (!fs.existsSync(ROTATION_STATE_PATH)) return;
    const saved = JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf-8'));
    writerUsageState = {
      ...writerUsageState,
      ...saved,
      byWriter: { ...writerUsageState.byWriter, ...(saved.byWriter || {}) },
      recentAssignments: Array.isArray(saved.recentAssignments) ? saved.recentAssignments : [],
    };
    console.log('[writer-selector] Loaded persistent rotation state');
  } catch (error) {
    console.log('[writer-selector] Failed to load rotation state, using defaults:', error.message);
  }
}

function saveWriterState() {
  try {
    const stateDir = path.dirname(ROTATION_STATE_PATH);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(ROTATION_STATE_PATH, JSON.stringify(writerUsageState, null, 2), 'utf-8');
  } catch (error) {
    console.log('[writer-selector] Failed to save rotation state:', error.message);
  }
}

function initializeWriterState() {
  const writers = getAllWriters();
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (const writer of writers) {
    const current = writerUsageState.byWriter[writer.id] || {};
    writerUsageState.byWriter[writer.id] = {
      count: Number(current.count || 0),
      lastAssigned: current.lastAssigned || null,
      streak: Number(current.streak || 0),
      authorCursor: Number(current.authorCursor || 0),
      lastAuthorId: current.lastAuthorId || null,
    };
    if (current.lastAssigned && (now - current.lastAssigned) > oneDayMs) {
      writerUsageState.byWriter[writer.id].streak = 0;
    }
  }
  saveWriterState();
}

loadWriterState();
initializeWriterState();

const SECTION_LABELS = {
  news: 'News',
  business: 'Business',
  tech: 'Tech',
  health: 'Health',
  sports: 'Sports',
  culture: 'Culture',
};

const SECTION_BEAT_FALLBACK = {
  news: 'breaking news',
  business: 'business',
  tech: 'technology',
  health: 'health',
  sports: 'sports',
  culture: 'culture',
};


function canonicalizePlacement(sectionId, topicId, registry = loadTaxonomyRegistry()) {
  const resolvedTopicId = resolveTopicId(topicId);
  const resolvedSectionId = resolveSectionId(sectionId);
  if (resolvedTopicId && registry.sectionByTopic?.[resolvedTopicId]) {
    return {
      sectionId: registry.sectionByTopic[resolvedTopicId],
      topicId: resolvedTopicId,
    };
  }
  return {
    sectionId: resolvedSectionId,
    topicId: resolvedTopicId,
  };
}
const TOPIC_BEAT_HINTS = {
  'us-politics': 'politics',
  'world-geopolitics': 'international affairs',
  'law-crime': 'crime',
  'climate-extreme-weather': 'climate',
  'society-social-trends': 'human interest',
  'economy-markets': 'markets',
  'companies-deals': 'business',
  'consumer-money': 'business',
  'housing-real-estate': 'business',
  'crypto-bitcoin': 'markets',
  'travel-consumer-issues': 'general news',
  'ai-big-tech': 'technology',
  'consumer-tech': 'technology',
  'cybersecurity': 'technology',
  'mobility-evs': 'technology',
  'space-astronomy': 'science',
  'enterprise-platforms': 'technology',
  'public-health': 'health',
  'medical-research': 'science',
  'pharma-fda': 'health policy',
  'mental-health': 'health',
  'wellness-fitness': 'health',
  'major-leagues': 'sports',
  'events-tournaments': 'sports',
  'transfers-business': 'sports business',
  'athletes-culture': 'sports culture',
  'film-tv': 'culture',
  'music-celebrities': 'culture',
  'internet-culture': 'culture',
  'creators-platforms': 'culture',
};

export function classifyStory(eventBrief = {}, claimMap = null, sourcePack = {}) {
  const registry = loadTaxonomyRegistry();
  const title = String(eventBrief.title || sourcePack.topic || '').trim();
  const whatHappened = String(eventBrief.whatHappened || eventBrief.summary || '').trim();
  const whyItMatters = String(eventBrief.whyItMatters || '').trim();
  const involvedParties = normalizeStringArray(eventBrief.involvedParties || eventBrief.entities || sourcePack.entities || []);
  const upstreamTopicId = String(sourcePack.topic_id || eventBrief.topic_id || '').trim() || null;
  const upstreamSectionId = String(sourcePack.section_id || eventBrief.section_id || '').trim() || null;
  const text = `${title} ${whatHappened} ${whyItMatters} ${involvedParties.join(' ')}`.toLowerCase();

  const articleType = normalizeArticleType(eventBrief.articleType || eventBrief.article_type) || inferArticleType(text, title.toLowerCase(), claimMap);
  const isBreaking = detectBreakingMode(title.toLowerCase(), whatHappened.toLowerCase());
  const depthMode = inferDepthMode(text, claimMap);

  const hinted = matchTaxonomyHints(
    `${title} ${whatHappened} ${whyItMatters}`,
    (Array.isArray(sourcePack.publishReadySources) ? sourcePack.publishReadySources : sourcePack.sources || []).map((source) => source?.url).filter(Boolean).join(' '),
  );

  let topicId = upstreamTopicId || hinted.detectedTopicId || null;
  let sectionId = upstreamSectionId || hinted.detectedSectionId || null;
  ({ sectionId, topicId } = canonicalizePlacement(sectionId, topicId, registry));

  if (!topicId && sectionId) {
    topicId = pickTopicWithinSection(sectionId, title, text, []);
    ({ sectionId, topicId } = canonicalizePlacement(sectionId, topicId, registry));
  }
  if (!sectionId && topicId) {
    sectionId = registry.sectionByTopic?.[topicId] || null;
  }
  if (!sectionId) {
    sectionId = resolveSectionId(hinted.detectedSectionId) || inferSectionFallback(text);
  }

  const topic = topicId ? getTopicRecord(topicId) : null;
  const section = getSectionRecord(sectionId);
  const sectionLabel = section?.label || SECTION_LABELS[sectionId] || 'News';
  const subsection = String(eventBrief.subsection || topic?.label || '').trim() || null;

  const rawClassification = {
    articleType,
    article_type: articleType,
    isBreaking,
    depthMode,
    section: sectionLabel,
    section_id: sectionId,
    subsection,
    topic_id: topicId,
    topicLabel: topic?.label || subsection || null,
    tags: Array.from(new Set([
      ...normalizeStringArray(eventBrief.tags),
      ...normalizeStringArray(sourcePack.entities),
      ...involvedParties,
      ...(isBreaking ? ['breaking'] : []),
      ...(depthMode === 'deep' ? ['deep'] : []),
      ...(topicId ? [topicId] : []),
    ])).slice(0, 12),
    primaryBeat: TOPIC_BEAT_HINTS[topicId] || topic?.label?.toLowerCase() || SECTION_BEAT_FALLBACK[sectionId] || 'general news',
    secondaryBeat: SECTION_BEAT_FALLBACK[sectionId] || 'general news',
    topicFit: topic ? `${topic.label} within ${sectionLabel}` : `${sectionLabel} fallback routing`,
    confidence: String(topicId ? 'high' : hinted.confidence >= 3 ? 'medium' : 'low'),
  };

  const sanitized = sanitizeStoryClassification(rawClassification, eventBrief, sourcePack, claimMap);
  const sanitizedTopic = sanitized.topic_id ? getTopicRecord(sanitized.topic_id) : null;
  const sanitizedSection = getSectionRecord(sanitized.section_id);

  return {
    ...sanitized,
    subsection: sanitized.subsection || String(eventBrief.subsection || sanitizedTopic?.label || '').trim() || null,
    topicLabel: sanitizedTopic?.label || null,
    primaryBeat: TOPIC_BEAT_HINTS[sanitized.topic_id] || sanitizedTopic?.label?.toLowerCase() || SECTION_BEAT_FALLBACK[sanitized.section_id] || rawClassification.primaryBeat,
    secondaryBeat: SECTION_BEAT_FALLBACK[sanitized.section_id] || rawClassification.secondaryBeat,
    topicFit: sanitizedTopic
      ? `${sanitizedTopic.label} within ${sanitizedSection?.label || sanitized.section || 'News'}`
      : `${sanitizedSection?.label || sanitized.section || 'News'} fallback routing`,
  };
}

function pickTopicWithinSection(sectionId, title, fullText, tags = []) {
  const registry = loadTaxonomyRegistry();
  const topicIds = Array.isArray(registry.topicsBySection?.[sectionId]) ? registry.topicsBySection[sectionId] : [];
  if (!topicIds.length) return null;
  const haystack = `${title} ${fullText} ${normalizeStringArray(tags).join(' ')}`.toLowerCase();
  let best = null;
  for (const topicId of topicIds) {
    const topic = getTopicRecord(topicId);
    if (!topic) continue;
    let score = 0;
    const phrases = [topic.label, topic.slug, ...(topic.aliases || [])].filter(Boolean);
    for (const phrase of phrases) {
      const normalized = String(phrase).toLowerCase();
      if (!normalized) continue;
      if (haystack.includes(normalized)) {
        score += normalized.includes(' ') ? 4 : 2;
      }
    }
    if (!best || score > best.score) best = { topicId, score };
  }
  return best?.score > 0 ? best.topicId : null;
}

function normalizeArticleType(rawType) {
  if (!rawType) return null;
  const normalized = String(rawType).toLowerCase().trim();
  const aliasMap = {
    breaking: 'report',
    feature: 'report',
    'deep-dive': 'analysis',
  };
  if (['report', 'analysis', 'explainer'].includes(normalized)) return normalized;
  return aliasMap[normalized] || null;
}

function inferArticleType(fullText, title, claimMap) {
  const explainerKeywords = ['what is', 'how does', 'explained', 'guide', 'understand', 'why'];
  if (explainerKeywords.some((keyword) => title.includes(keyword))) return 'explainer';
  if (claimMap?.claimsByType) {
    const analyticalClaims = Number(claimMap.claimsByType.analytical || 0);
    const analyticalRatio = analyticalClaims / Math.max(Number(claimMap.totalClaims || 1), 1);
    if (analyticalRatio > 0.4) return 'analysis';
  }
  const analysisKeywords = ['impact', 'consequences', 'implications', 'analysis', 'what this means', 'strategic', 'significance'];
  if (analysisKeywords.some((keyword) => fullText.includes(keyword))) return 'analysis';
  return 'report';
}

function detectBreakingMode(title, whatHappened = '') {
  return ['breaking', 'just in', 'developing', 'live', 'urgent'].some((keyword) => `${title} ${whatHappened}`.includes(keyword));
}

function inferDepthMode(fullText, claimMap) {
  if (['comprehensive', 'deep dive', 'investigation', 'examined', 'thorough'].some((keyword) => fullText.includes(keyword))) {
    return 'deep';
  }
  if ((claimMap?.totalClaims || 0) >= 5) return 'deep';
  return 'standard';
}

function inferSectionFallback(text) {
  if (/(movie|film|music|celebrity|creator|youtube|instagram|tiktok|streaming|viral)/.test(text)) return 'culture';
  if (/(team|game|sports|league|player|tournament|championship)/.test(text)) return 'sports';
  if (/(health|medical|drug|hospital|fda|disease|outbreak|mental health|wellness)/.test(text)) return 'health';
  if (/(tech|ai|software|chip|device|cloud|cyber|data center|platform)/.test(text)) return 'tech';
  if (/(market|economy|business|earnings|stocks|refund|fee|travel|housing|mortgage|crypto)/.test(text)) return 'business';
  return 'news';
}

function calculateWriterFit(writer, classification) {
  const primaryBeat = String(classification.primaryBeat || '').toLowerCase();
  const secondaryBeat = String(classification.secondaryBeat || '').toLowerCase();
  const articleType = String(classification.articleType || 'report').toLowerCase();
  const section = String(classification.section || '').toLowerCase();
  const topicId = String(classification.topic_id || '').toLowerCase();
  const tags = normalizeStringArray(classification.tags).map((tag) => tag.toLowerCase());

  let beatScore = 0;
  const primaryBeats = normalizeStringArray(writer.primary_beats).map((beat) => beat.toLowerCase());
  const secondaryBeats = normalizeStringArray(writer.secondary_beats).map((beat) => beat.toLowerCase());

  for (const beat of primaryBeats) {
    if (beat === primaryBeat || primaryBeat.includes(beat) || beat.includes(primaryBeat)) beatScore = Math.max(beatScore, 6);
    else if (secondaryBeat && (beat === secondaryBeat || secondaryBeat.includes(beat) || beat.includes(secondaryBeat))) beatScore = Math.max(beatScore, 5);
    else if (topicId && topicId.includes(beat.replace(/\s+/g, '-'))) beatScore = Math.max(beatScore, 5);
  }

  for (const beat of secondaryBeats) {
    if (beat === primaryBeat || primaryBeat.includes(beat) || beat.includes(primaryBeat)) beatScore = Math.max(beatScore, 4);
    else if (secondaryBeat && (beat === secondaryBeat || secondaryBeat.includes(beat) || beat.includes(secondaryBeat))) beatScore = Math.max(beatScore, 3);
  }

  if (beatScore === 0 && section) {
    if ((section === 'news' && primaryBeats.includes('breaking news')) || primaryBeats.includes(section)) beatScore = 3;
    if (secondaryBeats.includes(section)) beatScore = Math.max(beatScore, 2);
  }

  const tagMatches = tags.filter((tag) => primaryBeats.some((beat) => tag.includes(beat.split(' ')[0]))).length;
  beatScore = Math.min(6, beatScore + Math.min(2, tagMatches));

  let typeScore = 0;
  if (normalizeStringArray(writer.preferred_article_types).map((type) => type.toLowerCase()).includes(articleType)) {
    typeScore += 3;
  }
  const compatibleTypes = {
    report: ['breaking', 'feature'],
    analysis: ['deep-dive', 'feature', 'report'],
    explainer: ['report', 'analysis'],
  };
  if (compatibleTypes[articleType]?.some((type) => normalizeStringArray(writer.preferred_article_types).map((item) => item.toLowerCase()).includes(type))) {
    typeScore += 1;
  }
  if (classification.isBreaking && normalizeStringArray(writer.preferred_article_types).map((type) => type.toLowerCase()).includes('breaking')) {
    typeScore += 1;
  }
  if (classification.depthMode === 'deep' && normalizeStringArray(writer.preferred_article_types).map((type) => type.toLowerCase()).includes('deep-dive')) {
    typeScore += 1;
  }

  return {
    beatScore,
    typeScore: Math.min(4, typeScore),
    total: Math.min(10, beatScore + Math.min(4, typeScore)),
  };
}

function calculateAntiStreakPenalty(writerId) {
  const writerData = writerUsageState.byWriter[writerId] || { count: 0, streak: 0 };
  const totalArticles = Math.max(writerUsageState.totalArticles || 0, 1);
  const usageRate = Number(writerData.count || 0) / totalArticles;
  let streakPenalty = 0;
  if (writerData.streak >= 3) streakPenalty = 3;
  else if (writerData.streak >= 2) streakPenalty = 2;
  else if (writerData.streak >= 1) streakPenalty = 1;

  let usagePenalty = 0;
  if (usageRate > 0.4) usagePenalty = 2;
  else if (usageRate > 0.3) usagePenalty = 1;

  return Math.min(3, streakPenalty + usagePenalty);
}

function selectDepartmentAuthor(writer) {
  const authors = Array.isArray(writer?.authors) ? writer.authors : [];
  if (!authors.length) return null;
  const writerData = writerUsageState.byWriter[writer.id] || { authorCursor: 0 };
  const cursor = Number.isFinite(writerData.authorCursor) ? writerData.authorCursor : 0;
  const selectedAuthor = authors[cursor % authors.length];
  writerUsageState.byWriter[writer.id] = {
    ...(writerUsageState.byWriter[writer.id] || {}),
    authorCursor: (cursor + 1) % authors.length,
    lastAuthorId: selectedAuthor.id,
  };
  return selectedAuthor;
}

export function selectWriter(classification, options = {}) {
  const { considerRotation = true, allowCrossBeat = true } = options;
  const writers = getAllWriters();
  let fallbackUsed = false;

  const scoredWriters = writers.map((writer) => {
    const fitScores = calculateWriterFit(writer, classification);
    const antiStreakPenalty = considerRotation ? calculateAntiStreakPenalty(writer.id) : 0;
    const finalScore = fitScores.total - antiStreakPenalty;
    return { writer, fitScores, antiStreakPenalty, finalScore };
  }).sort((a, b) => b.finalScore - a.finalScore);

  let selected = scoredWriters[0];
  if (!allowCrossBeat && selected && selected.finalScore < 4) {
    const primaryMatches = scoredWriters.filter((item) => item.fitScores.beatScore >= 4);
    if (primaryMatches.length > 0) {
      selected = primaryMatches[0];
      fallbackUsed = true;
    }
  }
  if (selected && selected.finalScore < 3) fallbackUsed = true;

  const selectedAuthor = selected ? selectDepartmentAuthor(selected.writer) : null;

  if (selected) {
    writerUsageState.totalArticles += 1;
    const current = writerUsageState.byWriter[selected.writer.id] || { count: 0, streak: 0, authorCursor: 0, lastAuthorId: null };
    writerUsageState.byWriter[selected.writer.id] = {
      count: Number(current.count || 0) + 1,
      lastAssigned: Date.now(),
      streak: Number(current.streak || 0) + 1,
      authorCursor: current.authorCursor || 0,
      lastAuthorId: writerUsageState.byWriter[selected.writer.id]?.lastAuthorId || current.lastAuthorId || null,
    };

    writerUsageState.recentAssignments.push({
      writerId: selected.writer.id,
      timestamp: Date.now(),
      articleType: classification.articleType,
      beat: classification.primaryBeat,
      section: classification.section,
      topic_id: classification.topic_id || null,
    });
    writerUsageState.recentAssignments = writerUsageState.recentAssignments.slice(-50);

    for (const writerId of Object.keys(writerUsageState.byWriter)) {
      if (writerId !== selected.writer.id) writerUsageState.byWriter[writerId].streak = 0;
    }
    saveWriterState();
  }

  return {
    selectedWriter: selected?.writer || null,
    selectedAuthor,
    fitScore: selected?.fitScores.total || 0,
    fitFactors: {
      beatScore: selected?.fitScores.beatScore || 0,
      typeScore: selected?.fitScores.typeScore || 0,
      beatMatch: classification.primaryBeat,
      typeMatch: classification.articleType,
      sectionId: classification.section_id || null,
      topicId: classification.topic_id || null,
    },
    rotationPenalty: selected?.antiStreakPenalty || 0,
    finalScore: selected?.finalScore || 0,
    fallbackUsed,
    reasoning: selected ? buildSelectionReasoning(selected, classification, fallbackUsed) : 'No writer selected',
  };
}

function buildSelectionReasoning(scoredWriter, classification, fallbackUsed) {
  const reasons = [];
  if (scoredWriter.fitScores.beatScore >= 5) reasons.push(`Strong beat match for ${classification.primaryBeat}`);
  else if (scoredWriter.fitScores.beatScore >= 3) reasons.push(`Good beat coverage for ${classification.primaryBeat}`);
  else reasons.push(`Cross-beat assignment for ${classification.primaryBeat}`);
  if (scoredWriter.fitScores.typeScore >= 3) reasons.push(`Specializes in ${classification.articleType} articles`);
  if (scoredWriter.antiStreakPenalty > 0) reasons.push(`Anti-streak penalty applied (-${scoredWriter.antiStreakPenalty})`);
  if (fallbackUsed) reasons.push('Fallback selection (limited fit available)');
  return reasons.join('. ');
}

export function getWriterUsageStats() {
  const writers = getAllWriters();
  const total = Math.max(writerUsageState.totalArticles || 0, 1);
  return {
    totalArticles: writerUsageState.totalArticles,
    lastReset: writerUsageState.lastReset,
    persistentStatePath: ROTATION_STATE_PATH,
    byWriter: writers.map((writer) => ({
      id: writer.id,
      name: writer.name,
      count: writerUsageState.byWriter[writer.id]?.count || 0,
      streak: writerUsageState.byWriter[writer.id]?.streak || 0,
      lastAuthorId: writerUsageState.byWriter[writer.id]?.lastAuthorId || null,
      percentage: Math.round(((writerUsageState.byWriter[writer.id]?.count || 0) / total) * 100),
    })),
    recentAssignments: writerUsageState.recentAssignments.slice(-10),
  };
}

export function resetWriterUsage() {
  writerUsageState.recentAssignments = [];
  writerUsageState.totalArticles = 0;
  writerUsageState.lastReset = new Date().toISOString();
  initializeWriterState();
  saveWriterState();
  console.log('[writer-selector] Writer usage reset');
}

function normalizeStringArray(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}
