// File: qwen-scripts/nodes/youtube-enrichment-node.js
// Purpose: Pipeline node wrapper for YouTube enrichment. Non-blocking — failure never stops article publishing.

const { enrichArticleWithVideo } = require('../youtube-enrichment.js');

/**
 * Enrich one article candidate with a YouTube video if a strong match exists.
 * @param {Object} candidate - Selected article candidate with draft, brief, sourcePack, placement
 * @param {Object} options - Optional configuration overrides
 * @returns {Promise<Object|null>} Normalized video metadata object, or null if no strong match
 */
export async function enrichCandidateWithVideo(candidate, options = {}) {
  const article = {
    draft: candidate.draft || {},
    brief: candidate.brief || {},
    sourcePack: candidate.sourcePack || {},
    placement: candidate.placement || {},
    articleSlug: candidate.articleSlug || candidate.publishIdentity?.slug || '',
  };

  try {
    const video = await enrichArticleWithVideo(article, options);
    return video;
  } catch (error) {
    console.warn(`[youtube-node] Enrichment failed for "${article.draft.title || 'unknown'}": ${error.message}`);
    return null;
  }
}
