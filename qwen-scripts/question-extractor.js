// File: qwen-scripts/question-extractor.js
// Purpose: Derive high-demand reader questions from shared discovery/news-pool briefs for the question-led article pipeline.

import { openAIComplete } from './utils/api-clients.js';

const GENERIC_QUESTION_PATTERNS = [
  /^what is this\??$/i,
  /^why is this important\??$/i,
  /^what does this mean\??$/i,
  /^what happens\??$/i,
  /^what next\??$/i,
];

export async function extractQuestionCandidate(eventBrief, openAiApiKey, options = {}) {
  const fallback = buildFallbackQuestionCandidate(eventBrief);
  const model = options.model || process.env.OPENAI_QUESTION_MODEL || process.env.OPENAI_WRITER_MODEL || 'gpt-5.1-mini';

  if (!openAiApiKey) {
    return finalizeQuestionCandidate(fallback, eventBrief, {
      provider: 'fallback',
      model: null,
      note: 'OPENAI_API_KEY missing; fallback extractor used',
    });
  }

  const prompt = buildQuestionPrompt(eventBrief, options);

  try {
    const response = await openAIComplete(prompt, openAiApiKey, {
      model,
      maxTokens: 1200,
      temperature: 0.2,
      systemPrompt: 'You extract one urgent, concrete, evidence-safe reader question from a news brief. Return strict JSON only.',
      logLabel: 'question_extraction',
    });

    if (response.status !== 'called_success' || !response.data) {
      return finalizeQuestionCandidate(fallback, eventBrief, {
        provider: 'fallback',
        model,
        note: response.error || 'Question extraction API failed',
      });
    }

    const content = response.data.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') {
      return finalizeQuestionCandidate(fallback, eventBrief, {
        provider: 'fallback',
        model,
        note: 'Question extraction JSON parse failed',
      });
    }

    const candidate = {
      signal: cleanText(parsed.signal) || fallback.signal,
      event: cleanText(parsed.event) || fallback.event,
      uncertainty: cleanText(parsed.uncertainty) || fallback.uncertainty,
      stakes: cleanText(parsed.stakes) || fallback.stakes,
      time_horizon: cleanText(parsed.time_horizon || parsed.timeHorizon) || fallback.time_horizon,
      question: normalizeQuestion(parsed.question) || fallback.question,
      question_type: normalizeQuestionType(parsed.question_type || parsed.questionType) || fallback.question_type,
      score: clampScore(parsed.score, fallback.score),
      reason: cleanText(parsed.reason) || 'LLM-ranked question candidate',
      prompt_version: 'qna-question-extractor-v1',
    };

    return finalizeQuestionCandidate(candidate, eventBrief, {
      provider: 'openai',
      model,
      note: null,
    });
  } catch (error) {
    return finalizeQuestionCandidate(fallback, eventBrief, {
      provider: 'fallback',
      model,
      note: error.message,
    });
  }
}

export async function extractQuestionCandidates(briefs = [], openAiApiKey, options = {}) {
  const items = [];
  for (const brief of briefs) {
    const candidate = await extractQuestionCandidate(brief, openAiApiKey, options);
    items.push(candidate);
  }
  return items;
}

export function selectBestQuestionCandidate(questionCandidates = []) {
  return [...(Array.isArray(questionCandidates) ? questionCandidates : [])]
    .filter((candidate) => candidate?.valid !== false)
    .sort((left, right) => {
      const scoreDiff = Number(right?.selection_score || 0) - Number(left?.selection_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const publishabilityDiff = Number(right?.publishabilityScore || 0) - Number(left?.publishabilityScore || 0);
      if (publishabilityDiff !== 0) return publishabilityDiff;
      return new Date(right?.discoveredAt || 0) - new Date(left?.discoveredAt || 0);
    })[0] || null;
}

function buildQuestionPrompt(eventBrief, options = {}) {
  const title = cleanText(eventBrief?.title) || 'Untitled development';
  const whatHappened = cleanText(eventBrief?.whatHappened) || title;
  const whyItMatters = cleanText(eventBrief?.whyItMatters) || 'The downstream implications are still developing.';
  const involved = Array.isArray(eventBrief?.involvedParties) && eventBrief.involvedParties.length > 0
    ? eventBrief.involvedParties.join(', ')
    : cleanText(eventBrief?.whoIsInvolved) || 'Not clearly identified';
  const when = cleanText(eventBrief?.when) || cleanText(eventBrief?.discoveredAt) || 'Not confirmed';
  const where = cleanText(eventBrief?.where) || cleanText(eventBrief?.region) || 'Not specified';
  const articleTypeHint = cleanText(options.articleTypeHint) || 'analysis';

  return `You are an expert in identifying the single strongest reader question hiding inside a breaking-news signal.

TASK:
Turn the brief below into one concrete, high-demand question that real readers would want answered right now.

RULES:
- Do not summarize the brief
- Do not invent facts
- Focus on what is unresolved
- The question must be specific, urgent, and answer-seeking
- Prefer outcome, timing, likelihood, next-step, or consequence questions
- Avoid generic questions like "What is this?" or "Why is this important?"
- Keep the question narrow enough that an evidence-based article can answer it
- Score from 1 to 10 based on urgency + stakes + answerability
- Suggested downstream article type hint: ${articleTypeHint}

BRIEF:
Title: ${title}
What happened: ${whatHappened}
Why it matters: ${whyItMatters}
Who is involved: ${involved}
When: ${when}
Where: ${where}

OUTPUT JSON ONLY:
{
  "signal": "...",
  "event": "...",
  "uncertainty": "...",
  "stakes": "...",
  "time_horizon": "...",
  "question": "...",
  "question_type": "will|when|how_likely|what_happens_next|impact|meaning",
  "score": 1,
  "reason": "..."
}`;
}

function finalizeQuestionCandidate(candidate, eventBrief, meta = {}) {
  const question = normalizeQuestion(candidate?.question);
  const valid = isValidQuestion(question);
  const publishabilityScore = Number(eventBrief?.publishabilityScore || 0);
  const selectionScore = (Number(candidate?.score || 0) * 2)
    + publishabilityScore
    + Math.min(4, Number(eventBrief?.cluster_size || 0) || 0)
    + Math.min(3, Number(eventBrief?.article_rich_count || 0) || 0);

  return {
    signal: cleanText(candidate?.signal) || cleanText(eventBrief?.title) || 'Untitled signal',
    event: cleanText(candidate?.event) || cleanText(eventBrief?.whatHappened) || cleanText(eventBrief?.title) || 'Developing event',
    uncertainty: cleanText(candidate?.uncertainty) || 'The next outcome is unresolved',
    stakes: cleanText(candidate?.stakes) || cleanText(eventBrief?.whyItMatters) || 'Readers want clarity on what could change next',
    time_horizon: cleanText(candidate?.time_horizon || candidate?.timeHorizon) || inferTimeHorizon(eventBrief),
    question,
    question_type: normalizeQuestionType(candidate?.question_type || candidate?.questionType) || 'what_happens_next',
    score: clampScore(candidate?.score, 6),
    reason: cleanText(candidate?.reason) || 'Fallback-ranked question candidate',
    valid,
    invalid_reason: valid ? null : 'Generic or malformed question',
    provider: meta.provider || 'fallback',
    model: meta.model || null,
    note: meta.note || null,
    prompt_version: candidate?.prompt_version || 'qna-question-extractor-v1',
    selection_score: selectionScore,
    briefId: eventBrief?.id || null,
    poolIdentityKey: eventBrief?.poolIdentityKey || null,
    publishabilityScore,
    discoveredAt: eventBrief?.discoveredAt || null,
    briefTitle: cleanText(eventBrief?.title) || null,
    brief: eventBrief,
  };
}

function buildFallbackQuestionCandidate(eventBrief) {
  const title = cleanText(eventBrief?.title) || 'Untitled development';
  const why = cleanText(eventBrief?.whyItMatters) || 'The downstream effects are still unclear.';
  const developmentText = `${title} ${cleanText(eventBrief?.whatHappened)} ${why}`.toLowerCase();

  let questionType = 'what_happens_next';
  let question = `What happens next after ${stripTrailingPunctuation(title)}?`;
  let uncertainty = 'the next confirmed move or outcome';
  let stakes = why;

  if (/(may|might|could|set to|expected|prepar|plan|consider|weigh|pending|vote|talks|deadline|review)/i.test(developmentText)) {
    questionType = 'how_likely';
    question = 'How likely is the reported move to become official in the coming days?';
    uncertainty = 'whether the reported move becomes a concrete action';
  } else if (/(market|stocks|bond|fed|rates|inflation|tariff|trade|economy|housing|mortgage|bitcoin|crypto)/i.test(developmentText)) {
    questionType = 'impact';
    question = `What happens next for markets after ${stripTrailingPunctuation(title)}?`;
    uncertainty = 'how investors and affected sectors respond next';
  } else if (/(war|strike|conflict|military|ceasefire|missile|attack|troops|sanction|border)/i.test(developmentText)) {
    questionType = 'how_likely';
    question = `How likely is further escalation after ${stripTrailingPunctuation(title)}?`;
    uncertainty = 'whether the situation escalates further in the near term';
  } else if (/(health|disease|outbreak|fda|drug|hospital|crisis|warning)/i.test(developmentText)) {
    questionType = 'impact';
    question = `How serious could this get after ${stripTrailingPunctuation(title)}?`;
    uncertainty = 'how severe the health impact could become';
  }

  return {
    signal: title,
    event: cleanText(eventBrief?.whatHappened) || title,
    uncertainty,
    stakes,
    time_horizon: inferTimeHorizon(eventBrief),
    question,
    question_type: questionType,
    score: inferFallbackScore(eventBrief),
    reason: 'Rule-based fallback question extracted from brief signals',
  };
}

function inferFallbackScore(eventBrief) {
  const publishability = Number(eventBrief?.publishabilityScore || 0);
  const clusterSize = Math.min(2, Number(eventBrief?.cluster_size || 0) >= 3 ? 2 : 1);
  const articleRich = Math.min(1, Number(eventBrief?.article_rich_count || 0) >= 2 ? 1 : 0);
  return Math.max(4, Math.min(10, publishability + clusterSize + articleRich));
}

function inferTimeHorizon(eventBrief) {
  const stage = String(eventBrief?.developmentStage || '').toLowerCase();
  if (stage === 'breaking') return 'next 24 to 72 hours';
  if (stage === 'developing') return 'coming days to weeks';
  return 'near term';
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function normalizeQuestion(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  const normalized = raw.replace(/^question\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  return /[?]$/.test(normalized) ? normalized : `${stripTrailingPunctuation(normalized)}?`;
}

function normalizeQuestionType(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '_');
  if (!normalized) return null;
  if (['will', 'when', 'how_likely', 'what_happens_next', 'impact', 'meaning'].includes(normalized)) {
    return normalized;
  }
  if (normalized.includes('next')) return 'what_happens_next';
  if (normalized.includes('likely')) return 'how_likely';
  if (normalized.includes('impact') || normalized.includes('effect')) return 'impact';
  if (normalized.includes('mean')) return 'meaning';
  return 'what_happens_next';
}

function isValidQuestion(question) {
  if (!question) return false;
  if (question.split(/\s+/).length < 5) return false;
  return !GENERIC_QUESTION_PATTERNS.some((pattern) => pattern.test(question.trim()));
}

function stripTrailingPunctuation(value) {
  return String(value || '').replace(/[\s.?!,:;]+$/g, '').trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampScore(value, fallback = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(10, Math.round(numeric)));
}
