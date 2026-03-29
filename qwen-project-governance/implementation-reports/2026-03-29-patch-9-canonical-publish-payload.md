<!-- File: qwen-project-governance/implementation-reports/2026-03-29-patch-9-canonical-publish-payload.md -->
<!-- Purpose: Record patch 9 that aligns source hygiene and publish/frontmatter metadata around one canonical payload. -->

# Patch 9 — Canonical Publish Payload

## Goal
Remove multiple competing sources of truth between source-pack, draft placement, publish manifest, and frontmatter.

## Files changed
- qwen-scripts/source-pack.js
- qwen-scripts/pipeline.js
- qwen-scripts/publisher.js
- qwen-scripts/validate-publish-graph.js

## What changed
- Added explicit `publicSources` / `canonicalPublicSources` to source packs.
- Built one canonical publish payload during pre-publish validation.
- Stored canonical placement, tags, topics, and sources on the candidate before publish.
- Made publisher frontmatter consume canonical placement/tags/sources first.
- Made publish manifests consume canonical placement/tags/sources first.
- Strengthened published artifact validation to compare subsection, tags, topics, and sources, not only title/section/topic.
