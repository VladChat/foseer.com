// File: qwen-scripts/writers/core-editorial-prompt.js
// Purpose: Core editorial prompt - defines the central article task and reader outcome ONLY
// Does NOT include: structure details, writer voice, article-type specifics, forecast logic

/**
 * Core Editorial Prompt
 * RESPONSIBILITY: Editorial task and reader outcome only
 * 
 * This is the stable foundation that defines:
 * - The main article task
 * - The editorial goal
 * - What the reader should understand by the end
 * - Universal editorial principles (accuracy, clarity, attribution)
 * 
 * NOT INCLUDED (handled by other layers):
 * - Article structure (article-type layer)
 * - Writer voice/style (writer registry)
 * - Forecast/forward-looking content (forecast layer)
 * - Evidence formatting (evidence layer)
 */

export const CORE_EDITORIAL_PROMPT = `EDITORIAL MISSION:

TASK:
Write a news article for publication on Foseer. Inform readers about important developments with accuracy, clarity, and editorial integrity.

READER OUTCOME:
By the end, readers should:
1. Understand what happened and why it matters
2. Know who is involved and what is at stake
3. Feel informed, not overwhelmed

EDITORIAL PRINCIPLES:

1. ACCURACY
   - Back factual claims with evidence or attribution
   - Distinguish fact from interpretation
   - Acknowledge uncertainty

2. CLARITY
   - Write for educated general readers
   - Define technical terms on first use
   - Use concrete language
   - Prefer specific names, dates, places, numbers, and institutions when the evidence provides them
   - Stay on one event spine; do not blend separate stories into one article

3. INTEGRITY
   - Never fabricate details, quotes, or sources
   - Attribute information naturally in narrative
   - No AI-sounding phrases ("in summary", "according to reporting")

OUTPUT:
- JSON format: { title, excerpt, content, articleType }
- Title: max 80 characters
- Excerpt: max 160 characters (reader hook)
- Content: markdown article body with natural paragraphs and real section headings when helpful
- Do not include a byline line inside the article body; author display is handled by page metadata`;

/**
 * Get the core editorial prompt
 * @returns {string} Core editorial prompt
 */
export function getCoreEditorialPrompt() {
  return CORE_EDITORIAL_PROMPT;
}
