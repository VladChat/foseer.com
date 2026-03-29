<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-5-throughput-recovery.md -->
<!-- Purpose: Document the recovery patch that restores article throughput while preserving semantic publish protections. -->

# Patch 5 — Throughput recovery with placement/tag repair

## Goal
Restore article publication throughput without removing the semantic publish protections added earlier.

## Root cause
Patch 4 made Stage 3 treat all editorial issues as hard blockers. That stopped candidate flow too early.

At the same time, several otherwise usable stories were failing later because:
- topic placement was wrong upstream
- stale draft tags were being validated instead of the final publishable tag set

## Changes

### qwen-scripts/pipeline.js
- Stage 3 now hard-blocks only source-integrity failures.
- Placement-only failures are downgraded to advisory notes and deferred to placement repair.
- Pre-publish validation now writes repaired canonical tagging back into the draft before publish.

### qwen-scripts/validate-publish-graph.js
- Added evidence-based placement repair before semantic validation.
- Repaired topic/section selection from source and draft evidence.
- Added topic-specific alias expansion for common misroutes.
- Effective tagging now uses the final publishable tag set, not stale draft tags.
- Added synthesized primary-topic tagging fallback when repaired placement is valid but tag picker stays sparse.
- Primary-topic tag validation now respects repaired placement support.

## Intended behavior after patch
- Mixed-event source packs still fail early.
- Repairable topic drift no longer kills throughput.
- Final publish validation remains active.
- Cleaner stories can publish again.

## Smoke checks completed
- `mental-health` -> `climate-extreme-weather` repair path: passes
- `ai-big-tech` -> `economy-markets` repair path: passes
- `creators-platforms` social-media case: passes
- mixed Strategy/Fannie Mae case: still blocked
