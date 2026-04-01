// File: qwen-scripts/image-library/providers/unsplash.js
// Purpose: Normalized Unsplash adapter for the shared qwen image-provider layer.

import { unsplashSearch } from '../../utils/api-clients.js';

function inferImageFormat(downloadUrl) {
  const lowered = String(downloadUrl || '').toLowerCase();
  if (lowered.includes('.png')) return 'png';
  if (lowered.includes('.webp')) return 'webp';
  if (lowered.includes('.jpeg')) return 'jpeg';
  return 'jpg';
}

function normalizeTags(photo = {}, query = '') {
  const tagTitles = Array.isArray(photo?.tags)
    ? photo.tags
      .map((tag) => tag?.title || tag?.source?.title || null)
      .filter(Boolean)
    : [];

  const descriptionTokens = String(photo?.alt_description || photo?.description || '')
    .split(/[,/]/)
    .map((value) => value.trim())
    .filter(Boolean);

  const queryTokens = String(query || '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set([...tagTitles, ...descriptionTokens, ...queryTokens])).slice(0, 24);
}

export async function searchUnsplashImageCandidates({ query, apiKey, perPage = 15, orientation = 'landscape' }) {
  const result = await unsplashSearch(query, apiKey, {
    perPage,
    orientation,
    contentFilter: 'high',
    orderBy: 'relevant',
    logLabel: 'unsplash_image_search',
  });

  const photos = result?.data?.results || [];
  return photos.map((photo) => {
    const downloadUrl = photo?.urls?.regular || photo?.urls?.full || photo?.urls?.raw || null;
    const tags = normalizeTags(photo, query);
    return {
      provider: 'unsplash',
      providerAssetId: photo?.id ? String(photo.id) : null,
      assetKey: photo?.id ? `unsplash:${photo.id}` : null,
      sourcePageUrl: photo?.links?.html || null,
      sourceDownloadUrl: downloadUrl,
      thumbnailUrl: photo?.urls?.small || photo?.urls?.thumb || null,
      altText: photo?.alt_description || photo?.description || query || '',
      authorName: photo?.user?.name || null,
      authorUrl: photo?.user?.links?.html || null,
      license: 'Unsplash License',
      width: photo?.width || 1600,
      height: photo?.height || 900,
      format: inferImageFormat(downloadUrl),
      searchQuery: query,
      rawTags: tags,
      apiVisualType: 'photo',
      raw: photo,
    };
  }).filter((candidate) => candidate.sourceDownloadUrl);
}
