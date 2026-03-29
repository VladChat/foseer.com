// File: qwen-scripts/image-library/providers/pixabay.js
// Purpose: Normalized Pixabay adapter for the shared qwen image-provider layer.

import { pixabaySearch } from '../../utils/api-clients.js';

function inferImageFormat(downloadUrl) {
  const lowered = String(downloadUrl || '').toLowerCase();
  if (lowered.includes('.png')) return 'png';
  if (lowered.includes('.webp')) return 'webp';
  if (lowered.includes('.svg')) return 'svg';
  return 'jpg';
}

function buildAuthorUrl(hit) {
  if (!hit?.user || !hit?.user_id) return null;
  return `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/`;
}

function chooseDownloadUrl(hit) {
  return hit?.largeImageURL || hit?.fullHDURL || hit?.webformatURL || hit?.imageURL || null;
}

export async function searchPixabayImageCandidates({ query, apiKey, perPage = 15, orientation = 'landscape' }) {
  const result = await pixabaySearch(query, apiKey, {
    perPage,
    orientation,
    imageType: 'photo',
    minWidth: 1200,
    minHeight: 675,
    safesearch: true,
    logLabel: 'pixabay_image_search',
  });

  const hits = result?.data?.hits || [];
  return hits.map((hit) => {
    const downloadUrl = chooseDownloadUrl(hit);
    const tags = String(hit?.tags || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return {
      provider: 'pixabay',
      providerAssetId: hit?.id ? String(hit.id) : null,
      assetKey: hit?.id ? `pixabay:${hit.id}` : null,
      sourcePageUrl: hit?.pageURL || null,
      sourceDownloadUrl: downloadUrl,
      thumbnailUrl: hit?.webformatURL || hit?.previewURL || null,
      altText: tags.length > 0 ? tags.join(', ') : (query || ''),
      authorName: hit?.user || null,
      authorUrl: buildAuthorUrl(hit),
      license: 'Pixabay Content License',
      width: hit?.imageWidth || hit?.webformatWidth || 1600,
      height: hit?.imageHeight || hit?.webformatHeight || 900,
      format: inferImageFormat(downloadUrl),
      searchQuery: query,
      rawTags: tags,
      apiVisualType: hit?.type || 'photo',
      raw: hit,
    };
  }).filter((candidate) => candidate.sourceDownloadUrl);
}
