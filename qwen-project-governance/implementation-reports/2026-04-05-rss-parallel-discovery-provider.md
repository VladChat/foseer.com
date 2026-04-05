<!--
File: qwen-project-governance/implementation-reports/2026-04-05-rss-parallel-discovery-provider.md
Purpose: Record RSS parallel discovery provider integration into the active qwen discovery pipeline.
-->

# RSS Parallel Discovery Provider Integration

## Scope
Implemented RSS as a fourth discovery channel inside the active `qwen-*` discovery architecture, without changing downstream clustering/selection/source-pack/publish gates.

## Architecture Decisions
- Added a dedicated authoring registry at `src/data/rss-feeds.json`.
- Added a compiled runtime registry at `qwen-data/contracts/rss-feed-registry.json`.
- Added compiler `qwen-scripts/compile-rss-feed-registry.js` with strict validation:
  - duplicate feed IDs fail compile
  - invalid URLs fail compile
  - unknown section/topic hints fail compile unless resolvable via taxonomy aliases/legacy mappings
  - topic hints derive canonical section hints from `qwen-data/contracts/taxonomy-registry.json`
- Added runtime loader `qwen-scripts/utils/rss-feed-registry.js`.
- Added RSS provider `qwen-scripts/rss-discovery.js`:
  - independent per-feed polling with per-feed try/catch
  - feed-level backoff and failure tracking
  - stateful seen-item dedupe by stable key
  - RSS/Atom parsing + HTML summary sanitization
  - normalization to the same candidate shape used by discovery
  - coverage-aware acceptance (undercovered section/topic boosts + diversity penalties + hard caps)
- Added RSS state file `qwen-data/events/rss-provider-state.json`.
- Integrated RSS channel into `qwen-scripts/discovery.js` as channel 4 (`disableRss` toggle).
- Hardened channel isolation in `runDiscovery()` with channel-level try/catch for Brave/Google/GDELT/RSS so one provider error does not fail the whole discovery run.

## Coverage Balancing Logic
RSS acceptance uses soft balancing, not overrides:
- `rssCoverageBoost` from 48h section/topic deficits (`discovered-news-pool`, `news-pool`, and recent publish manifests).
- `publisherDiversityPenalty` in final selection loop.
- `sectionRepetitionPenalty` in final selection loop.
- `duplicatePenalty` vs existing non-RSS candidates by canonical URL/title/similarity.
- Freshness bonus from parsed publish times.
- Caps enforced:
  - max accepted per feed per run (`2` default)
  - max accepted per publisher per run (`3` default)
  - share cap from merged pool (`~35%` default, computed against existing candidates)

## RSS Isolation and Resilience
- One broken feed marks only that feed failed and applies backoff; provider continues.
- RSS provider returns partial success when possible.
- `runDiscovery()` continues even if RSS channel throws.
- Existing provider circuit state (`provider-circuit-state.json`) remains readable and unchanged in structure.

## Files Added
- `src/data/rss-feeds.json`
- `qwen-data/contracts/rss-feed-registry.json`
- `qwen-data/events/rss-provider-state.json`
- `qwen-scripts/compile-rss-feed-registry.js`
- `qwen-scripts/utils/rss-feed-registry.js`
- `qwen-scripts/rss-discovery.js`
- `qwen-project-governance/implementation-reports/2026-04-05-rss-parallel-discovery-provider.md`

## Files Modified
- `qwen-scripts/discovery.js`
  - import `discoverWithRss`
  - add `enableRss` toggle via `disableRss`
  - add RSS stats fields (`rss_feeds_polled`, `rss_items_seen`, `rss_items_accepted`, `rss_feed_failures`)
  - add `channels.rss`
  - add Channel 4 RSS execution/merge
  - add channel-level try/catch around Brave/Google/GDELT/RSS blocks
- `package.json`
  - add script `qwen:compile-rss-feeds`

## Path Adaptation Note
No path adaptation was required for missing source directories.
`src/data/` exists in this repo, so authoring registry was implemented exactly at `src/data/rss-feeds.json`.

## Verification Executed

### 1) RSS-only discovery path runs without crashing
Command:
- `node tmp/rss-verification.mjs`

Observed:
- RSS-only run completed
- `rss_feeds_polled=35`, `rss_items_seen=26`, `rss_items_accepted=6`, `rss_feed_failures=0`
- merged candidates included `provider="rss"`

### 2) Mixed discovery path runs without crashing
Command:
- `node tmp/rss-verification.mjs`

Observed:
- mixed run completed
- providers in merged candidates: `gdelt` + `rss`
- mixed stats included RSS counters and `channels.rss`

### 3) One intentionally broken feed does not fail run
Command:
- `node tmp/rss-verification.mjs`

Observed (broken feed `https://httpbin.org/status/500`):
- run completed
- `rss_feed_failures=1`
- skipped feed recorded with reason `poll_failed`
- feed backoff recorded with `reason=http_5xx`

### 4) RSS candidates appear in merged pool
Observed:
- mixed providers included `rss`
- merged candidate set contained `provider="rss"` entries

### 5) Existing downstream output path still produced
Command path used in verification script:
- `mergeDiscoveredNews(mixed.candidates)`

Observed:
- `qwen-data/events/discovered-news-pool.json` updated and readable

### 6) Coverage balancing improves section spread (controlled same-lane comparison)
Controlled comparison (same discovery lane state, `coreSectionLimit=1`, `gdeltLaneLimit=1`, Brave/Google disabled):
- Before (no RSS):
  - total: `9`
  - sections: `sports=4, news=4, health=1`
- After (with RSS):
  - total: `10`
  - sections: `sports=4, news=4, health=1, tech=1`

### 7) Dedupe works when RSS and existing candidate overlap
Command:
- `node tmp/rss-verification.mjs`

Observed:
- source accepted: `2`
- with existing candidate injected: `1`
- duplicate skip counter increased: `rss_items_skipped_duplicate=1`

### 8) State files readable and stable
Observed:
- `qwen-data/events/provider-circuit-state.json` parseable
- `qwen-data/events/rss-provider-state.json` parseable
- RSS state persisted per-feed metadata (`lastSuccessfulPollAt`, `consecutiveFailures`, `backoffUntil`, `seenItems`, optional `etag`/`lastModified`)

## Requested Printed Metrics

### Before/After section counts from merged candidate pool
Controlled same-lane run:
- Before: `sports=4, news=4, health=1`
- After: `sports=4, news=4, health=1, tech=1`

### Accepted RSS candidates by section/topic
Snapshot against baseline existing candidates:
- `tech::space-astronomy = 3`
- `culture::film-tv = 1`

### Skipped feeds and why
Broken-feed test:
- `broken-feed-http-500`: `poll_failed` (`HTTP 500 while polling https://httpbin.org/status/500`)

### Automatically backed-off feeds
Broken-feed test:
- `broken-feed-http-500` backed off with `consecutive_failures=1`, `reason=http_5xx`, and `backoff_until` timestamp.

### Final RSS share of merged candidates
- Mixed run (`tmp/rss-verification.mjs`): `0.182`
- Controlled same-lane comparison: `0.100`
