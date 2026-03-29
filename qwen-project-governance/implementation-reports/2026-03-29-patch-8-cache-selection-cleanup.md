<!-- File: qwen-project-governance/implementation-reports/2026-03-29-patch-8-cache-selection-cleanup.md -->
<!-- Purpose: Record the cleanup patch that makes routine pipeline runs cache-only and simplifies candidate selection. -->

# Patch 8 — Cache + Selection Cleanup

## Scope
- qwen-scripts/utils/api-clients.js
- qwen-scripts/pipeline.js
- qwen-scripts/source-pack.js

## What changed
- Default search mode changed from live refresh to cache-only.
- Expired cache entries now return stale cache results instead of forcing live requests.
- Routine pipeline runs no longer apply a second inventory-based recent duplicate cut in pipeline.js.
- Selection constraints were relaxed slightly so publishable candidates are less likely to collapse to a single article.

## Intention
Keep the system simpler:
- one provider cache policy for normal runs
- one main candidate selection path
- less accidental throughput loss from overlapping duplicate filters

## Expected effect
- Brave / Google / GDELT stay offline during normal cached runs
- expired cached provider responses still contribute signals
- more publishable candidates should reach drafting when backlog depth exists
