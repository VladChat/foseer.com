// File: qwen-scripts/writers/forecast-layer.js
// Purpose: Forecast/ending layer - adds forward-looking block when appropriate
// Separate from writer personality to maintain factual discipline

/**
 * Forecast Layer
 * Adds a forward-looking "what may happen next" section
 * This is separate from writer personality to maintain factual discipline
 * Used for article types that benefit from forward-looking analysis
 */

export const FORECAST_LAYER = `FORECAST BLOCK: What May Happen Next

PURPOSE:
Add a forward-looking section that helps readers understand plausible near-term developments based on evidence, not speculation.

FORECAST PRINCIPLES:

1. EVIDENCE-BASED ONLY
   - Base forecasts on stated intentions, patterns, or credible indicators
   - Attribute predictions to sources when available
   - Distinguish between likely, possible, and speculative

2. TIME HORIZON
   - Breaking news: Hours to days
   - News report: Days to weeks
   - Analysis: Weeks to months
   - Deep dive: Months to a year

3. SCENARIO FRAMING
   - Present multiple plausible scenarios when uncertainty is high
   - Indicate relative likelihood when evidence supports it
   - Note key indicators that would signal which path is unfolding

4. HUMILITY
   - Acknowledge uncertainty explicitly
   - Avoid false precision in predictions
   - Note what could change the trajectory

FORECAST STRUCTURE:
1. Transition from current developments to what comes next
2. Present 2-3 plausible scenarios based on evidence
3. Note key indicators or events to watch
4. Close with what would need to change for different outcomes

LANGUAGE GUIDANCE:
- Use "may," "could," "likely," "plausible" appropriately
- Avoid "will" unless based on stated commitments
- Attribute: "Analysts expect," "Officials have indicated," etc.
- Be specific about timeframes: "in the coming weeks," "by year-end"

AVOID:
- Wild speculation without evidentiary basis
- Presenting one scenario as certain when others are plausible
- Vague predictions that could mean anything
- Dramatic language that oversells uncertainty

EXAMPLE TRANSITIONS:
- "Looking ahead, several developments could shape the situation:"
- "What happens next depends on several factors:"
- "Analysts are watching for key indicators:"
- "The coming weeks will likely reveal:"`;

/**
 * Get the forecast layer prompt
 * @returns {string} Forecast layer prompt
 */
export function getForecastLayer() {
  return FORECAST_LAYER;
}

/**
 * Build forecast instructions based on article type and confidence level
 * @param {string} articleType - Article type ID
 * @param {string} confidence - Confidence level: 'high', 'medium', 'low'
 * @returns {string} Tailored forecast instructions
 */
export function buildForecastInstructions(articleType, confidence = 'medium') {
  const typeGuidance = {
    'breaking': 'Focus on immediate developments in the next 24-72 hours. What will readers need to know next?',
    'report': 'Note next steps, scheduled developments, or expected announcements in the coming days to weeks.',
    'analysis': 'Present 2-3 plausible scenarios for the coming weeks to months. What are the key factors that will determine outcomes?',
    'deep-dive': 'Examine medium-term trajectories and key inflection points. What developments over the next 6-12 months could reshape the situation?',
  };
  
  const confidenceGuidance = {
    'high': 'Evidence strongly supports the forecast. Use confident language while acknowledging uncertainty.',
    'medium': 'Evidence is mixed or incomplete. Present multiple scenarios with relative likelihoods.',
    'low': 'High uncertainty. Focus on what to watch rather than specific predictions.',
  };
  
  return `FORECAST GUIDANCE:
${typeGuidance[articleType] || typeGuidance['report']}

CONFIDENCE LEVEL: ${confidence}
${confidenceGuidance[confidence] || confidenceGuidance['medium']}

Keep forecast to 2-3 paragraphs. Be specific about timeframes and indicators.`;
}
