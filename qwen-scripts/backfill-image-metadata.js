// File: qwen-scripts/backfill-image-metadata.js
// Purpose: One-shot maintenance task that enriches existing image-registry entries with lightweight relevance metadata.

import { getImageRegistrySummary, loadImageRegistry, saveImageRegistry } from './image-library/registry.js';

const registry = loadImageRegistry();
saveImageRegistry(registry);
const summary = getImageRegistrySummary(registry);
console.log('[image-backfill] Registry metadata enrichment complete:', JSON.stringify(summary));
