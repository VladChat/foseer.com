// File: qwen-scripts/nodes/image-node.js
// Purpose: Wrapper node that produces a standardized image package from draft + taxonomy context.
// Adds post-selection image fit validation and re-search retry if the chosen image
// does not match the story's visual concept set. Conservative: only retries once,
// keeps the better of original vs retry.

import { getArticleImage } from '../image-support.js';
import { buildVisualConceptSet } from '../utils/pre-draft-coherence-gate.js';

/**
 * Compute image fit score (0-1) by comparing image metadata against story visual concepts.
 * Uses image tags, entity hints, scene type, and editorial fit from the metadata.
 */
function computeImageFitScore(image, visualConcepts, candidateText) {
  if (!image?.metadata) return 0.5; // Unknown — neutral score

  const concepts = (visualConcepts?.concepts || []).map((c) => c.toLowerCase());
  if (concepts.length === 0) return 0.5; // No concepts to compare against

  // Gather image tags/labels
  const imageTags = new Set();
  if (image.metadata.entityHints) {
    image.metadata.entityHints.forEach((t) => imageTags.add(t.toLowerCase()));
  }
  if (image.metadata.sceneType) {
    imageTags.add(image.metadata.sceneType.toLowerCase());
  }
  if (image.altText) {
    image.altText.toLowerCase().split(/\s+/).filter((w) => w.length > 3).forEach((w) => imageTags.add(w));
  }

  // Compute overlap
  let hits = 0;
  for (const concept of concepts) {
    if (imageTags.has(concept)) {
      hits += 1;
    } else if ([...imageTags].some((tag) => tag.includes(concept) || concept.includes(tag))) {
      hits += 0.5;
    }
  }

  // Also factor in the existing editorial fit score
  const editorialFit = (image.metadata.editorialFitScore || 0) / 100;

  // Combined: concept overlap (60%) + editorial fit (40%)
  const conceptScore = concepts.length > 0 ? Math.min(1, hits / Math.max(1, concepts.length * 0.5)) : 0.5;
  const combined = (conceptScore * 0.6) + (editorialFit * 0.4);

  return Math.round(combined * 100) / 100;
}

/**
 * Build corrected query from visual concepts for retry search.
 * Uses secondary concept for diversification when primary concept was already tried.
 */
function buildRetryQuery(visualConcepts, sectionId, topicId, triedConcepts = []) {
  const concepts = visualConcepts?.concepts || [];
  // Try to find a concept that wasn't in the initial search
  const freshConcept = concepts.find((c) => !triedConcepts.some((t) => c.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(c.toLowerCase())));
  const primaryConcept = freshConcept || concepts[0];
  if (primaryConcept) {
    return `${primaryConcept} ${sectionId || topicId || 'editorial'} photo`;
  }
  return `${topicId || sectionId || 'news'} editorial photo`;
}

/**
 * Generate image package with post-selection fit validation and retry.
 * @param {Object} selected - Candidate with draft, brief, sourcePack, placement
 * @param {string} articleSlug - Article slug for caching
 * @param {Object} providerApiKeys - { pexelsApiKey, unsplashApiKey, pixabayApiKey }
 * @param {Object} options - Optional { maxRetries, minFitScore }
 * @returns {Object} Image package
 */
export async function generateImagePackage(selected, articleSlug, providerApiKeys = {}, options = {}) {
  const draft = selected?.draft || {};
  // Prefer REPAIRED section/topic from brief/placement over stale draft metadata
  const sectionId = selected?.brief?.section_id
    || selected?.placement?.section_id
    || draft.section_id
    || null;
  const topicId = selected?.brief?.topic_id
    || selected?.placement?.topic_id
    || draft.topic_id
    || null;

  // Build visual concepts for fit validation
  const candidateText = [
    draft?.title, draft?.content, draft?.excerpt,
    selected?.brief?.title, selected?.brief?.whatHappened, selected?.brief?.summary,
  ].filter(Boolean).join(' ').toLowerCase();

  const visualConcepts = buildVisualConceptSet(sectionId, topicId, candidateText);

  const maxRetries = Number(options.maxRetries || 1);
  const minFitScore = Number(options.minFitScore || 0.45);

  // Initial image selection
  console.log(`[image-node] Selecting image for "${articleSlug}" (section=${sectionId}, topic=${topicId})`);
  let image = await getArticleImage(draft, articleSlug, providerApiKeys, {
    brief: selected?.brief || null,
    sourcePack: selected?.sourcePack || null,
    placement: selected?.placement || null,
  });

  // Post-selection fit validation
  const initialFitScore = computeImageFitScore(image, visualConcepts, candidateText);
  console.log(`[image-node] Initial image fit score: ${initialFitScore.toFixed(2)} (provider=${image.provider}, query=${image.metadata?.queryUsed || 'unknown'})`);

  if (initialFitScore < minFitScore && maxRetries > 0 && image.provider !== 'fallback') {
    console.log(`[image-node] Poor image fit (score=${initialFitScore.toFixed(2)} < ${minFitScore}). Retrying with corrected query...`);

    // 2-3 second delay before retry to avoid rate limits and cache convergence
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Build diversified retry query using fresh concepts
    const initialQuery = image.metadata?.queryUsed || '';
    const initialProvider = image.provider || 'unknown';
    const retryQuery = buildRetryQuery(visualConcepts, sectionId, topicId, [initialQuery]);
    console.log(`[image-node] Retry query: "${retryQuery}" (initial query was: "${initialQuery}", provider was: ${initialProvider})`);

    // Retry with concept-based query, preferring alternate provider
    const retryResult = await getArticleImage(draft, articleSlug, providerApiKeys, {
      brief: selected?.brief || null,
      sourcePack: selected?.sourcePack || null,
      placement: selected?.placement || null,
      overrideQuery: retryQuery,
      overrideConcepts: visualConcepts.concepts,
      excludeProvider: initialProvider, // Prefer different provider for retry
    });

    const retryFitScore = computeImageFitScore(retryResult, visualConcepts, candidateText);
    console.log(`[image-node] Retry image fit score: ${retryFitScore.toFixed(2)} (provider=${retryResult.provider})`);

    if (retryFitScore > initialFitScore && retryResult.provider !== 'fallback') {
      image = retryResult;
      console.log(`[image-node] Using retry image (improved from ${initialFitScore.toFixed(2)} to ${retryFitScore.toFixed(2)})`);
    } else {
      console.log(`[image-node] Retry did not improve fit (${retryFitScore.toFixed(2)} vs ${initialFitScore.toFixed(2)}). Keeping original.`);
    }
  }

  if (image.provider === 'fallback') {
    console.log(`[image-node] No suitable online image found; using fallback`);
  }

  const finalFitScore = computeImageFitScore(image, visualConcepts, candidateText);

  return {
    ...image,
    metadata: {
      ...(image.metadata || {}),
      section_id: sectionId,
      topic_id: topicId,
      imageFitScore: finalFitScore,
      visualConcepts: visualConcepts.concepts || [],
      retryAttempted: initialFitScore < minFitScore && maxRetries > 0,
      initialFitScore,
    },
  };
}
