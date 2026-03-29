<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-2-taxonomy-image-hardening.md -->
<!-- Purpose: Summarize patch 2 taxonomy and image hardening changes. -->

# Patch 2 — Taxonomy + Image Hardening

## Scope
- qwen-scripts/tag-picker.js
- qwen-scripts/utils/classification-sanity.js
- qwen-scripts/utils/image-query-builder.js
- qwen-scripts/image-support.js

## Intent
Reduce semantically wrong topic/tag/image outputs without touching stable publish orchestration.

## Main changes
- Removed sparse primary-topic fallback in canonical tag picking.
- Tightened cross-section and fallback tag admission, especially for topic/entity tags.
- Reduced confidence in upstream classification when title/source evidence does not confirm it.
- Limited image query building to cleaner title/source-supported entities.
- Switched image search flow to the safer image query planner.
- Downgraded or rejected image candidates lacking semantic confirmation.

## Expected effect
- Fewer contaminated topic/tag labels such as unrelated sports/security/mental-health tags.
- Fewer image queries with leaked entities like NFL/NBA/Unspecified when not validated.
- Lower chance of assigning strong image relevance to semantically weak matches.
