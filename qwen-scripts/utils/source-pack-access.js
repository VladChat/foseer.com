// File: qwen-scripts/utils/source-pack-access.js
// Purpose: Resolve the cleanest safe-to-draft source set from a source pack.

export function getPublishReadySources(sourcePack = {}, options = {}) {
  const minCount = Number(options.minCount || 2);
  const publishReady = Array.isArray(sourcePack?.publishReadySources)
    ? sourcePack.publishReadySources.filter(Boolean)
    : [];
  const raw = Array.isArray(sourcePack?.sources)
    ? sourcePack.sources.filter(Boolean)
    : [];

  if (publishReady.length >= Math.max(1, minCount)) return publishReady;
  if (publishReady.length > 0 && raw.length === 0) return publishReady;
  return raw;
}

export function getPublishReadySourceUrls(sourcePack = {}, options = {}) {
  return new Set(
    getPublishReadySources(sourcePack, options)
      .map((source) => source?.canonical_url || source?.url)
      .filter(Boolean)
  );
}
