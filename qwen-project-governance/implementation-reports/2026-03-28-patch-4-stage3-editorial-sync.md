<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-4-stage3-editorial-sync.md -->
<!-- Purpose: Record patch 4 that synchronizes the Stage 3 source-pack gate with the later editorial gate. -->

# Patch 4 — Stage 3 editorial gate sync

## Request
Align the Stage 3 source-pack gate with the later pre-publish editorial gate so semantically broken candidates are blocked earlier instead of appearing as `SOURCE PACK GATE: PASS` and then dying only at publish time.

## Changed files
- `qwen-scripts/validate-publish-graph.js`
- `qwen-scripts/pipeline.js`

## What changed
- Added `evaluateSourcePackEditorialIntegrity()` for Stage 3 candidate validation using only signals that already exist before drafting:
  - publish-ready source integrity
  - source title/event overlap
  - source-pack topic support in source evidence
- Added a Stage 3 alignment pass in `pipeline.js` immediately after `assembleSourcePack()`.
- When the aligned editorial check fails, the candidate is downgraded to `passesGate = false`, its gate notes are updated, and the pipeline logs the exact block reason.
- Stage 3 selected-topic telemetry now includes aligned gate details.

## Why
Before this patch, the pipeline could show:
- `SOURCE PACK GATE: PASS`
- later `publishing: FAIL`

That made the pipeline look healthy even when the source pack was already semantically broken.

## Intended effect
Block bad candidates earlier, especially cases like:
- mixed-event publish-ready packs
- source-pack topic unsupported by the publish-ready evidence

## Not changed
- No changes to drafting logic
- No changes to tag selection logic
- No changes to image selection logic
- No changes to publisher implementation

## Validation
- `node --check qwen-scripts/validate-publish-graph.js`
- `node --check qwen-scripts/pipeline.js`
- smoke test of `evaluateSourcePackEditorialIntegrity()` against a mixed-event Strategy audit candidate

## Expected runtime difference
The pipeline may now select fewer Stage 3 candidates, but the Stage 3 `PASS` list should better match what can realistically survive the final editorial gate.
