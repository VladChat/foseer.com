<!-- File: qwen-project-governance/implementation-reports/2026-03-28-patch-3-prepublish-kill-switch.md -->
<!-- Purpose: Record the scope and validation notes for patch 3 semantic pre-publish kill switch hardening. -->

# Patch 3 — Pre-publish kill switch

## Scope
- qwen-scripts/validate-publish-graph.js
- qwen-scripts/utils/quality-audit.js

## Goal
Block publication when semantic integrity is broken even though the pipeline is technically healthy.

## Added controls
- hard-fail on publish-ready source title/url mismatch
- hard-fail on generic/index-like publish-ready sources
- hard-fail on mixed-event publish-ready source titles
- hard-fail on unsupported primary topic/tag evidence
- hard-fail on placeholder image queries and inflated image relevance
- separate editorial validity from technical validity in pre-publish validation
- expose semantic validation details in publish manifests and quality audits

## Intended effect
This patch is the last gate. It should stop plausible-but-wrong articles from publishing even when upstream stages still leak contamination.

## Validation notes
- syntax/import checks should pass for both modified JS files
- known bad cases should now fail editorial validation:
  - social media teens + Bollywood URL mismatch
  - seniors coverage + mental-health topic contamination
  - Guardian Alexander Kluge title/url mismatch
  - generic search/index sources in publish-ready evidence

## Rollback
Restore the two modified JS files to the previous revision.
