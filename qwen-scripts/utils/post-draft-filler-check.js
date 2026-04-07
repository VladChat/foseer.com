// File: qwen-scripts/utils/post-draft-filler-check.js
// Purpose: Light, future-facing post-draft filler detection.
// Detects weak, unsupported, or disconnected sections after drafting.
// Prefers trim/flag over rejecting the whole article. Conservative.

/**
 * Patterns that indicate self-admittedly unsupported content.
 */
const FILLER_PATTERNS = [
  /(?:there is no (?:explicit|direct|clear|independent|firm|concrete|documented|public)).*?(?:evidence|reporting|indication|confirmation|documentation|data|detail|information)/i,
  /(?:it (?:is|remains) (?:not yet|still|unclear|impossible|difficult))\s+(?:to (?:say|determine|know|assess|confirm|verify|tell))/i,
  /(?:any (?:claim|assertion|statement|discussion|analysis|assessment|conversation|speculation)).*?(?:would be speculative|remains speculative|is speculative)/i,
  /(?:no (?:source|outlet|report|article|coverage|account)).*?(?:in the (?:current|available|cited|present))/i,
  /the sources do not (?:describe|detail|provide|discuss|explain|specify|clarify|indicate|confirm)/i,
  /(?:does not|don't) provide a (?:full|complete|detailed|clear|comprehensive)/i,
];

/**
 * Patterns that indicate tangential/disconnected content (international angle injection).
 */
const TANGENTIAL_PATTERNS = [
  /international angle|international issues|international context|international implications|diplomatic consequences/i,
  /global security|global economy|global markets|global impact|global significance/i,
  /broader implications|wider implications|larger implications|systemic implications/i,
  /foreign policy|foreign relations|diplomatic relations|geopolitical implications/i,
];

/**
 * Split article content into sections by H2 headings.
 */
function splitIntoSections(content) {
  if (!content) return [];
  const h2Regex = /^## (.+)$/gm;
  const sections = [];
  let lastMatch = null;
  let lastIndex = 0;
  let match;

  while ((match = h2Regex.exec(content)) !== null) {
    if (lastMatch) {
      sections.push({
        title: lastMatch[1].trim(),
        content: content.substring(lastIndex, match.index).trim(),
        startIndex: lastIndex,
        endIndex: match.index,
      });
    }
    lastMatch = match;
    lastIndex = match.index;
  }

  if (lastMatch) {
    sections.push({
      title: lastMatch[1].trim(),
      content: content.substring(lastIndex).trim(),
      startIndex: lastIndex,
      endIndex: content.length,
    });
  }

  return sections;
}

/**
 * Check if a section contains filler patterns.
 * Returns { isFiller: boolean, confidence: number, matchedPatterns: string[], suggestion: string }
 */
function detectSectionFiller(section) {
  const matchedPatterns = [];
  let totalHits = 0;

  for (const pattern of FILLER_PATTERNS) {
    const matches = section.content.match(pattern);
    if (matches) {
      matchedPatterns.push(matches[0].substring(0, 80));
      totalHits += matches.length;
    }
  }

  // Check for tangential content
  let isTangential = false;
  for (const pattern of TANGENTIAL_PATTERNS) {
    if (pattern.test(section.content)) {
      isTangential = true;
      matchedPatterns.push(`tangential: ${pattern.source.substring(0, 60)}`);
      totalHits += 1;
    }
  }

  // Confidence based on hit density relative to section length
  const wordCount = section.content.split(/\s+/).length;
  const hitDensity = totalHits / Math.max(1, wordCount / 100); // hits per 100 words
  const confidence = Math.min(1, hitDensity / 3); // 3+ hits per 100 words = high confidence

  const isFiller = totalHits >= 2 && confidence >= 0.3;

  let suggestion = 'no action';
  if (isFiller && confidence >= 0.7) {
    suggestion = 'consider removing or heavily trimming this section';
  } else if (isFiller) {
    suggestion = 'flag for editorial review';
  } else if (isTangential) {
    suggestion = 'verify that tangential content is source-grounded';
  }

  return {
    isFiller,
    confidence: Math.round(confidence * 100) / 100,
    isTangential,
    matchedPatterns,
    hitCount: totalHits,
    wordCount,
    suggestion,
  };
}

/**
 * Run post-draft filler check on an article.
 * @param {Object} params - { content, sourcePack, claimMap, brief }
 * @returns {Object} { hasFiller: boolean, sections: [{title, isFiller, confidence, suggestion, matchedPatterns}], warnings: string[], trimmedContent: string|null }
 */
export function checkPostDraftFiller({ content = '', sourcePack = {}, claimMap = {}, brief = {} } = {}) {
  const sections = splitIntoSections(content);
  if (sections.length === 0) {
    return { hasFiller: false, sections: [], warnings: [], trimmedContent: null };
  }

  const results = [];
  const warnings = [];
  let anyFiller = false;

  for (const section of sections) {
    const check = detectSectionFiller(section);
    results.push({
      title: section.title,
      ...check,
    });

    if (check.isFiller) {
      anyFiller = true;
      warnings.push(`Filler detected in section "${section.title}": ${check.hitCount} unsupported patterns (${check.confidence.toFixed(2)} confidence) — ${check.suggestion}`);
    }
  }

  // Check if "Related Coverage" section has irrelevant links
  const relatedCoverageSection = sections.find((s) => s.title.toLowerCase().includes('related coverage'));
  if (relatedCoverageSection) {
    // This section is expected — no filler check needed
  }

  // Check overall article coherence: does the article have enough grounded content?
  const totalWordCount = content.split(/\s+/).length;
  const claimCount = claimMap?.totalClaims || 0;
  const supportedClaims = claimMap?.supportedClaims || 0;
  const sourceCount = sourcePack?.sources?.length || 0;

  if (totalWordCount > 800 && supportedClaims <= 2 && sourceCount <= 2) {
    warnings.push(`Article is long (${totalWordCount} words) but has few supported claims (${supportedClaims}) and sources (${sourceCount}) — may contain filler`);
  }

  return {
    hasFiller: anyFiller,
    sections: results,
    warnings,
    trimmedContent: null, // Future: could auto-trim filler sections
  };
}
