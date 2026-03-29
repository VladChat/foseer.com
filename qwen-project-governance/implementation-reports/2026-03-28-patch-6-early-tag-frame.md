<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-6-early-tag-frame.md -->
<!-- Purpose: Document the minimal early tag-frame hardening patch and registry cleanup. -->

# Patch 6 — Early tag frame hardening

## Goal
Fix canonical tag selection without adding late-stage repair layers or extra pipeline complexity.

## What was wrong
- Canonical tags were allowed to drift because the picker still consumed noisy background signals and downstream classification hints.
- The same article could be tagged once during drafting and then effectively re-picked again later.
- `phraseScore()` had a broken regex escape pattern, so alias matching for allowed tags was unreliable.
- The controlled registry was a bit too sparse for recurring editorial cases like markets, social media, health coverage, and mortgages.

## What changed

### 1) `qwen-scripts/tag-picker.js`
- Fixed the regex escaping bug in `phraseScore()`.
- Reduced canonical tag target size to **2–4** instead of 3–6.
- Removed draft classification tags from entity inputs.
- Restricted evidence inputs to title + clean direct source titles.
- Added lightweight source filtering for tag evidence:
  - core/supporting only
  - no title/url mismatch
  - no generic page kinds
  - require same-event strength or title overlap
- Disabled secondary-topic stuffing.
- Limited normal picks to:
  - 1 primary topic
  - up to 2 themes
  - up to 1 entity
  - up to 1 geography
- Added `resolveCanonicalTagFrame()` so later stages can reuse the early canonical tag frame instead of rethinking tags.

### 2) `qwen-scripts/publisher.js`
- Uses the stored early canonical tag frame when available.
- Falls back to picking only when the stored frame is missing.

### 3) `qwen-scripts/validate-publish-graph.js`
- Uses the same early canonical tag frame as publish-time source of truth.
- Stops tag validation from drifting away from what drafting already approved.

### 4) `qwen-scripts/validate-tags.js`
- Updated bounds to match the intended simpler canonical set:
  - minimum target = 2
  - maximum = 4

### 5) `qwen-scripts/compile-tag-registry.js`
- Kept the existing controlled-vocabulary system.
- Added a small, common-sense registry expansion:
  - `Wall Street`
  - `Mortgages`
  - `Medicare`
  - `Health Insurance`
  - `Social Media`
- Added small alias enrichments for topic tags where the existing vocabulary was too sparse.

### 6) `qwen-data/contracts/tag-registry.json`
- Recompiled from the updated registry definitions.
- Total allowed tags is now **179**.

## Why this stays simple
- No late tag repair layer was added.
- No new publish-stage workaround was added.
- No second tagging system was introduced.
- The same controlled registry remains the source of truth.
- Tagging is now decided early and reused later.

## Smoke checks run
- Syntax checks on all edited JS files: passed.
- Market case now resolves to:
  - `Economy & Markets`
  - `Wall Street`
- Social media case now resolves to:
  - `Creators & Platforms`
  - `Social Media`
- Seniors coverage case now resolves to:
  - `Public Health`
  - `Health Insurance`

## Expected effect
- Fewer semantically wrong tags from clean articles.
- Fewer publish failures caused only by tag drift.
- Better alignment between early routing, drafting metadata, and publish validation.
