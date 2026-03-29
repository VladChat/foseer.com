// File: qwen-scripts/normalize-cache-ttl.js
// Purpose: Rewrite Brave, GDELT, and Google cache metadata so all cache files are stamped with the canonical 8-hour TTL.

import { normalizeAllCacheTTLs, getCacheStats, DEFAULT_TTL_HOURS } from './utils/cache-manager.js';

const summary = normalizeAllCacheTTLs();
const stats = getCacheStats();

console.log(`[cache-ttl] Canonical TTL hours: ${DEFAULT_TTL_HOURS}`);
console.log(`[cache-ttl] Rewritten files: ${summary.rewritten_files}`);
for (const [provider, providerSummary] of Object.entries(summary.providers)) {
  console.log(`[cache-ttl] ${provider}: files=${providerSummary.files} rewritten=${providerSummary.rewritten_files}`);
}
console.log(`[cache-ttl] Stats: ${JSON.stringify(stats)}`);
