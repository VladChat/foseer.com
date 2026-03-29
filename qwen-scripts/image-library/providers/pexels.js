// File: qwen-scripts/image-library/providers/pexels.js
// Purpose: Normalized Pexels adapter for the shared qwen image-provider layer.

import { pexelsSearch } from '../../utils/api-clients.js';

function inferImageFormat(downloadUrl) {
  const lowered = String(downloadUrl || '').toLowerCase();
  if (lowered.includes('.png')) return 'png';
  if (lowered.includes('.webp')) return 'webp';
  if (lowered.includes('.jpeg')) return 'jpeg';
  return 'jpg';
}

export async function searchPexelsImageCandidates({ query, apiKey, perPage = 15, orientation = 'landscape' }) {
  const result = await pexelsSearch(query, apiKey, {
    perPage,
    orientation,
    logLabel: 'pexels_image_search',
  });

  const photos = result?.data?.photos || [];
  return photos.map((photo) => ({
    provider: 'pexels',
    providerAssetId: photo?.id ? String(photo.id) : null,
    assetKey: photo?.id ? `pexels:${photo.id}` : null,
    sourcePageUrl: photo?.url || null,
    sourceDownloadUrl: photo?.src?.large2x || photo?.src?.large || photo?.src?.original || null,
    thumbnailUrl: photo?.src?.medium || photo?.src?.small || null,
    altText: photo?.alt || '',
    authorName: photo?.photographer || null,
    authorUrl: photo?.photographer_url || null,
    license: 'Pexels License',
    width: photo?.width || 1600,
    height: photo?.height || 900,
    format: inferImageFormat(photo?.src?.large2x || photo?.src?.large || photo?.src?.original || ''),
    searchQuery: query,
    rawTags: String(photo?.alt || '')
      .split(/[,/]/)
      .map((value) => value.trim())
      .filter(Boolean),
    apiVisualType: 'photo',
    raw: photo,
  })).filter((candidate) => candidate.sourceDownloadUrl);
}
