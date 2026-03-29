<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-1-evidence-hardening.md -->
<!-- Purpose: Record the scope and validation notes for Patch 1 evidence hardening. -->

# Patch 1 — Evidence hardening

## Scope
- qwen-scripts/source-pack.js
- qwen-scripts/utils/source-normalization.js
- qwen-scripts/discovery.js
- qwen-scripts/nodes/event-clustering-node.js

## What changed
- Added title↔URL coherence signals during source normalization.
- Added strict publishable-evidence filtering for title/url mismatch, high-genericity pages, and thin article signals.
- Tightened source-pack gate to fail dirty evidence before publish-ready selection.
- Replaced substring-based entity/region/angle matching in discovery with boundary-aware matching.
- Replaced substring-based action/place matching in event clustering with boundary-aware matching.
- Added stronger cluster penalties for conflicting action/place when titles and entities do not overlap.

## Expected effect
- Fewer mixed-event source packs.
- Fewer leaked entities such as NFL/NBA/US/signing from substring matches.
- Better rejection of generic or mismatched pages before they can become publish-ready evidence.

## Validation performed
- Node import check for modified modules.
- Targeted sanity checks for title/url mismatch and boundary-aware entity matching.
- Zip patch artifact created with only Patch 1 files.

## Notes
- This patch intentionally avoids publisher/retry/network/image changes.
- Patch 2 should focus on taxonomy and image hardening.
- Patch 3 should add the pre-publish semantic kill switch.
