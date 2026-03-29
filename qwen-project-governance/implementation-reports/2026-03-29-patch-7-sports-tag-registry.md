<!-- File: qwen-project-governance/implementation-reports/2026-03-29-patch-7-sports-tag-registry.md -->
<!-- Purpose: Record the small sports tag registry and alias alignment patch. -->

# Patch 7 — Sports tag registry cleanup

## Scope
- `qwen-scripts/compile-tag-registry.js`
- `qwen-scripts/validate-publish-graph.js`
- `qwen-data/contracts/tag-registry.json`

## Why
The system already had a controlled tag registry. The problem was narrow sports coverage around MLB/NBA and weak alias support for the existing `Major Leagues` topic at publish validation time.

## Changes
1. Added two common sports theme tags:
   - `Baseball`
   - `Basketball`
2. Mapped both tags to the existing `major-leagues` topic.
3. Enriched the `major-leagues` topic aliases in the compiled registry with:
   - `mlb`
   - `nba`
   - `major league baseball`
   - `national basketball association`
   - `baseball`
   - `basketball`
4. Aligned publish-time topic evidence aliases for `major-leagues` to the same sports terms.

## Intended effect
- Easier selection of precise sports tags from early evidence.
- Better support for the existing `Major Leagues` topic when the story is explicitly about MLB/NBA.
- No broad redesign and no late-stage tag repair layer.
