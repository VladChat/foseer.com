// File: qwen-scripts/writers/article-type-layers.js
// Purpose: Article-type specific prompt layers that shape structure and emphasis
// Canonical taxonomy is intentionally small for stability: report, analysis, explainer

const TYPE_ALIASES = {
  'breaking': 'report',
  'feature': 'report',
  'deep-dive': 'analysis',
};

export const ARTICLE_TYPE_LAYERS = [
  {
    id: 'report',
    name: 'News Report',
    description: 'Standard news coverage of completed or ongoing developments',
    emphasis: 'Factual completeness, context, balanced coverage',
    ending_behavior: 'Summarize significance and transition cleanly into the next developments',
    includes_forecast: false,
    prompt_layer: `ARTICLE TYPE: News Report

STRUCTURE GUIDANCE:
- Inverted pyramid: most important first
- Complete factual picture: who, what, when, where, why
- Relevant context and background
- Multiple perspectives when applicable
- Use 3-5 natural H2 section headings when they help readers scan the story
- Use H3 only when a section genuinely needs one extra layer of sub-structure

EMPHASIS:
- Factual completeness
- Clear attribution throughout
- Context that helps readers understand significance
- Balanced presentation of available information

ENDING:
- Summarize why this matters
- Transition cleanly into the next developments readers should watch
- Avoid editorializing`,
  },
  {
    id: 'explainer',
    name: 'Explainer',
    description: 'Makes complex topics accessible and understandable',
    emphasis: 'Clarity, education, reader comprehension',
    ending_behavior: 'Reinforce key takeaways and what changes next',
    includes_forecast: false,
    prompt_layer: `ARTICLE TYPE: Explainer

STRUCTURE GUIDANCE:
- Start with why readers should care
- Build understanding from basics to complexity
- Use examples throughout
- Anticipate and answer reader questions
- Prefer 4-6 clear H2 section headings that break the topic into real reader questions or explanatory blocks
- Use H3 for short sub-explanations only when it improves clarity

EMPHASIS:
- Accessibility without condescension
- Step-by-step explanation
- Definitions of technical terms
- Real-world examples and applications

ENDING:
- Reinforce key takeaways
- Clarify what changes next or what readers should watch
- Keep the tone explanatory, not speculative`,
  },
  {
    id: 'analysis',
    name: 'Analysis',
    description: 'Deep examination of consequences, meaning, and implications',
    emphasis: 'Insight, consequences, strategic meaning',
    ending_behavior: 'Forward-looking scenarios and what to watch',
    includes_forecast: true,
    prompt_layer: `ARTICLE TYPE: Analysis

STRUCTURE GUIDANCE:
- Establish the development and its significance
- Provide strategic context and background
- Analyze impacts on stakeholders
- Examine plausible scenarios
- Strongly prefer 5-7 clear H2 section headings so the article reads as structured analysis rather than one wall of text
- Use H3 when a section has distinct sub-points that need clean separation

EMPHASIS:
- Insight over information
- Consequences and implications
- Who wins, who loses, why it matters
- Evidence-backed interpretation

ENDING:
- Forward-looking scenarios
- What developments to watch
- Key questions that remain`,
  },
];

function normalizeTypeId(typeId) {
  const normalized = String(typeId || 'report').toLowerCase();
  return TYPE_ALIASES[normalized] || normalized;
}

export function getArticleTypeLayer(typeId) {
  const normalized = normalizeTypeId(typeId);
  return ARTICLE_TYPE_LAYERS.find(t => t.id === normalized);
}

export function getAllArticleTypes() {
  return [...ARTICLE_TYPE_LAYERS];
}

/**
 * Compatibility helper. It now indicates whether the canonical type is typically more forecast-oriented,
 * but forecast gating itself is handled in article-drafter.js for stability.
 */
export function shouldIncludeForecast(typeId) {
  const normalized = normalizeTypeId(typeId);
  return normalized === 'analysis';
}
