// File: qwen-scripts/writers/prompt-assembler.js
// Purpose: Assembles final prompt from layered components with clear layer responsibilities
// Layer discipline: each layer has ONE clear responsibility, no duplication

import { getCoreEditorialPrompt } from './core-editorial-prompt.js';
import { getArticleTypeLayer } from './article-type-layers.js';
import { getWriterById } from './writer-registry.js';
import { getPublishReadySources } from '../utils/source-pack-access.js';
import { buildQuestionAngleLayer } from './question-angle-layer.js';

/**
 * Evidence Layer Builder
 * Formats claim map and source pack into usable evidence for the LLM
 * RESPONSIBILITY: Factual grounding only - what claims and sources exist
 *
 * @param {Object} claimMap - Claim map from claim-map.js
 * @param {Object} sourcePack - Source pack from source-pack.js
 * @returns {string} Formatted evidence layer
 */
function buildEvidenceLayer(claimMap, sourcePack) {
  const claims = Array.isArray(claimMap?.claims) ? claimMap.claims : [];
  const sources = getPublishReadySources(sourcePack, { minCount: 1 });

  const claimsSection = claims.length > 0
    ? claims.map((c, i) => {
        const claimText = String(c?.claimText || c?.text || c?.statement || 'Claim text unavailable');
        const claimStatus = String(c?.status || 'unknown');
        const sourceCount = Array.isArray(c?.supportingSources) ? c.supportingSources.length : 0;
        return `[${i + 1}] (${claimStatus}) ${claimText.substring(0, 150)}${claimText.length > 150 ? '...' : ''} - ${sourceCount} sources`;
      }).join('\n')
    : 'No structured claims available.';

  const sourcesSection = sources.length > 0
    ? sources.map((s, i) => {
        const sourceDomain = String(s?.domain || 'unknown');
        const sourceCredibility = Number.isFinite(Number(s?.credibility)) ? Number(s.credibility) : 5;
        const sourceTitle = String(s?.title || s?.headline || s?.name || 'Untitled source');
        const role = describeSourceRole(s, sourcePack, i);
        return `[${i + 1}] ${sourceDomain} (${sourceCredibility}/10, ${role}) - ${sourceTitle.substring(0, 80)}${sourceTitle.length > 80 ? '...' : ''}`;
      }).join('\n')
    : 'No sources provided.';

  return `EVIDENCE (factual grounding only):

CLAIMS TO COVER:
${claimsSection}

SOURCES:
${sourcesSection}

EVIDENCE RULES:
- Build article from confirmed claims
- Attribute information to sources naturally in prose when introducing new factual points
- Use sources marked event-direct for the article spine, lead, and core sections
- Use contextual or background sources only for brief framing or consequences
- Do not let a contextual source drive the article's main angle
- Mark uncertainty where claims lack support
- Do not generalize from one source's framing into a broader factual claim without independent support
- Do not present unsupported claims as fact`;
}

function describeSourceRole(source, sourcePack, index) {
  if (source?.isPrimary) return 'primary';
  if (source?.tier === 'core' || source?.role === 'core') return 'event-direct';
  if (source?.role === 'supporting' || source?.tier === 'supporting') return 'context';

  const supportedClaims = Array.isArray(sourcePack?.claims)
    ? sourcePack.claims.filter(claim => Array.isArray(claim?.supportingSources) && claim.supportingSources.includes(source?.url)).length
    : 0;

  if (supportedClaims >= 2) return 'event-direct';
  if (index === 0) return 'event-direct';
  return 'context';
}

function buildFocusDisciplineLayer(eventBrief, claimMap, sourcePack, includeForecast) {
  const focusTitle = String(eventBrief?.title || 'this development').trim();
  const supportedClaims = Array.isArray(claimMap?.claims)
    ? claimMap.claims.filter(claim => String(claim?.status || '').toLowerCase() === 'supported').length
    : 0;
  const totalSources = getPublishReadySources(sourcePack, { minCount: 1 }).length;
  const uniqueDomains = Number(sourcePack?.uniqueDomains || 0);
  const thinEvidence = totalSources <= 2 || supportedClaims <= 2 || uniqueDomains <= 1;

  const evidencePosture = thinEvidence
    ? `THIN EVIDENCE MODE:
- Keep the scope narrow and concrete
- Prefer a shorter article over broad interpretation
- Do not add industry-trend, policy-trend, or historical-comparison sections unless directly supported by the core evidence
- If context is needed, keep it to one short paragraph and place it after the confirmed event facts
- Forecast, if included, must stay shorter than the factual body`
    : `NORMAL EVIDENCE MODE:
- Keep one clear event spine
- Context is allowed only when it clearly sharpens reader understanding of the selected event
- Do not widen the article into a second adjacent story`;

  const forecastRule = includeForecast
    ? '- Forecast is optional color at the end, not a second article'
    : '- Do not invent a forward-looking section';

  return `FOCUS AND SCOPE LOCK:
- This article is about: ${focusTitle}
- Stay on this event spine from lead to close
- Do not broaden into adjacent policy, industry, geopolitical, or technology trend coverage unless the core evidence directly supports that move
- Do not widen the geography of the event beyond what the evidence directly states
- Do not turn venue references, host-city references, or scheduling references into broader international claims unless sources explicitly do so
- Do not introduce diplomatic, economic, or systemic implications unless they are directly supported by the claim map
- Core factual sections must be driven by event-direct sources and supported claims
- Background or contextual sources may appear only in brief supporting passages
${forecastRule}

${evidencePosture}`;
}

/**
 * Context Layer Builder
 * Adds event brief context
 * RESPONSIBILITY: Story context only - what happened, why it matters, who is involved
 *
 * @param {Object} eventBrief - Event brief from event-brief-builder.js
 * @returns {string} Formatted context layer
 */
function buildContextLayer(eventBrief) {
  const involved = eventBrief?.whoIsInvolved
    || (Array.isArray(eventBrief?.involvedParties) ? eventBrief.involvedParties.join(', ') : '')
    || 'Not specified';

  return `STORY CONTEXT:

WHAT: ${eventBrief?.title || 'Untitled'}
HAPPENED: ${eventBrief?.whatHappened || 'Not specified'}
MATTERS: ${eventBrief?.whyItMatters || 'Provide context'}
INVOLVED: ${involved}`;
}

/**
 * Assemble Final Prompt
 */
export function assembleFinalPrompt(options) {
  const {
    eventBrief,
    claimMap,
    sourcePack,
    articleType = 'report',
    writerId = 'reporter',
    authorProfile = null,
    includeForecast = false,
    forecastVariant = 'report-watch',
    forecastConfidence = 'medium',
    questionIntent = null,
  } = options;

  const corePrompt = getCoreEditorialPrompt();
  const articleTypeLayer = getArticleTypeLayer(articleType);
  const typePrompt = articleTypeLayer?.prompt_layer || getArticleTypeLayer('report').prompt_layer;
  const writer = getWriterById(writerId);
  const writerPrompt = writer?.prompt_template || getWriterById('reporter').prompt_template;
  const contextPrompt = buildContextLayer(eventBrief);
  const evidencePrompt = buildEvidenceLayer(claimMap, sourcePack);
  const focusPrompt = buildFocusDisciplineLayer(eventBrief, claimMap, sourcePack, includeForecast);
  const authorPrompt = buildAuthorLayer(authorProfile, writer);
  const questionPrompt = buildQuestionAngleLayer(questionIntent);
  const forecastPrompt = includeForecast
    ? buildForecastPrompt({ articleType, forecastVariant, confidence: forecastConfidence })
    : '';

  const layers = [
    corePrompt,
    '',
    typePrompt,
    '',
    writerPrompt,
    '',
    authorPrompt,
    '',
    questionPrompt,
    '',
    contextPrompt,
    '',
    evidencePrompt,
    '',
    focusPrompt,
  ];

  if (includeForecast && forecastPrompt) {
    layers.push('', forecastPrompt);
  }

  layers.push(`
ARTICLE BODY FORMAT:
- Content must be valid markdown body content, not HTML
- Start with a strong opening in natural paragraphs
- Do not place a byline or author-role line inside the content body
- Use real H2 headings for major sections when the article type calls for structure
- Use H3 only when a section genuinely needs sub-structure
- Headings must describe real sections, not decorative labels
- Keep paragraphs readable and grouped by idea
`);

  layers.push(`

OUTPUT FORMAT (JSON only):
{
  "title": "Headline (max 80 chars)",
  "excerpt": "1-2 sentence hook (max 160 chars)",
  "content": "Full article body in markdown (800-1200 words) with natural paragraphs and real H2 headings. Use H3 only when genuinely useful.",
  "articleType": "${articleType}"
}

Return ONLY the JSON object. No additional text.`);

  return layers.join('\n');
}

/**
 * Build forecast prompt from stable variants.
 */
function buildAuthorLayer(authorProfile, writer) {
  if (!authorProfile?.name) {
    return `BYLINE MODE:
- Treat ${writer?.name || 'the selected department'} as the editorial department guiding the article.
- Do not invent a named individual author inside the article body.
- Do not add any byline line in the content body; the page layout renders author information separately.`;
  }

  return `BYLINE MODE:
- Department: ${writer?.name || 'Unknown department'}
- Assigned author: ${authorProfile.name}
- Author role: ${authorProfile.bio || writer?.name || 'Staff writer'}
- Author variation: ${authorProfile.style_note || 'Stay fully inside department rules.'}
- Keep the department style dominant. The author variation is subtle and must never contradict department rules.
- Do not add any byline line in the content body; the page layout renders author information separately.`;
}

function buildForecastPrompt({ articleType, forecastVariant, confidence }) {
  const variants = {
    'breaking-watch': {
      heading: 'WHAT TO WATCH NEXT',
      timeframe: '24-72 hours',
      guidance: [
        'Focus on the next confirmed decisions, statements, or milestones readers should watch right away.',
        'Do not drift into long-range speculation.',
        'Keep it tight and concrete.',
      ],
    },
    'report-watch': {
      heading: 'WHAT TO WATCH NEXT',
      timeframe: 'coming days to weeks',
      guidance: [
        'Focus on scheduled developments, expected responses, and concrete indicators to monitor.',
        'Keep the tone cautious and evidence-based.',
        'Avoid pretending the story has a clear long-term outcome.',
      ],
    },
    'explainer-watch': {
      heading: 'WHAT CHANGES NEXT',
      timeframe: 'coming weeks to months',
      guidance: [
        'Explain what decisions, milestones, or policy moves could change the picture next.',
        'Help the reader understand what will matter next, not just what might happen.',
        'Avoid dramatic forecasting.',
      ],
    },
    'analysis': {
      heading: 'WHAT COULD HAPPEN NEXT',
      timeframe: 'weeks to months',
      guidance: [
        'Present 2-3 plausible scenarios grounded in the evidence.',
        'Name the main factors or indicators that would shape the outcome.',
        'Acknowledge uncertainty explicitly.',
      ],
    },
    'analysis-deep': {
      heading: 'WHAT COULD HAPPEN NEXT',
      timeframe: 'one to six months',
      guidance: [
        'Present 2-3 plausible medium-term scenarios grounded in the evidence.',
        'Connect near-term triggers to broader structural consequences.',
        'Acknowledge uncertainty explicitly.',
      ],
    },
  };

  const config = variants[forecastVariant] || variants['report-watch'];

  return `${config.heading} (forward-looking ending only):

Add a brief closing section (2-3 paragraphs) using a natural markdown H2 heading for this section:
- Time horizon: ${config.timeframe}
- Confidence: ${confidence}
- ${config.guidance.join('\n- ')}
- Use "may," "could," "likely," and "expected" carefully
- Avoid "will" unless tied to a stated commitment
- Do not introduce a second story line
- Do not add macro implications unless the claim map directly supports them
- Do not restate generic trend commentary just to extend the ending
- Keep the section consistent with article type: ${articleType}`;
}

/**
 * Get prompt assembly summary for logging/debugging
 */
export function getPromptAssemblySummary(options) {
  const {
    articleType = 'report',
    writerId = 'reporter',
    authorProfile = null,
    includeForecast = false,
    forecastVariant = 'report-watch',
    questionIntent = null,
  } = options;

  const articleTypeLayer = getArticleTypeLayer(articleType);
  const writer = getWriterById(writerId);

  return {
    core_editorial: true,
    article_type: {
      id: articleType,
      name: articleTypeLayer?.name || 'Unknown',
    },
    writer: {
      id: writerId,
      name: writer?.name || 'Unknown',
    },
    author: authorProfile ? {
      id: authorProfile.id,
      name: authorProfile.name,
    } : null,
    forecast_included: includeForecast,
    forecast_variant: includeForecast ? forecastVariant : null,
    question_mode: !!questionIntent?.question,
    layers_count: 5 + (includeForecast ? 1 : 0) + (questionIntent?.question ? 1 : 0),
  };
}
