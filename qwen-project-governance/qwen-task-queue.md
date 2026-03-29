<!-- File: qwen-project-governance/qwen-task-queue.md | Purpose: staged execution queue and status tracker for the qwen-built system -->

# Qwen Task Queue

## Status Legend
- `pending`
- `in_progress`
- `blocked`
- `done`

## Stage Queue

### Stage 0 — Repository Inspection and Baseline Mapping
- Status: `done`
- Goal:
  - inspect existing repository state
  - identify useful references
  - locate current article flow, provider logic, image logic, and localhost verification
- Validation:
  - written repository map recorded in operations log
  - current-context updated
- Exit condition:
  - clear implementation plan exists

### Stage 1 — Qwen Workspace Structure
- Status: `done`
- Goal:
  - create separate `qwen-*` folders
  - establish internal file layout for scripts, governance, cache, and data
- Validation:
  - folders exist
  - paths are recorded
- Exit condition:
  - qwen workspace is ready for implementation
- Folders created:
  - `qwen-scripts/` - Qwen pipeline scripts
  - `qwen-scripts/utils/` - Utility modules
  - `qwen-data/` - Working data storage
  - `qwen-data/articles/` - Generated articles
  - `qwen-data/events/` - Event briefs
  - `qwen-data/sources/` - Source packs
  - `qwen-cache/` - API cache root
  - `qwen-cache/brave/` - Brave cache (8h TTL)
  - `qwen-cache/gdelt/` - GDELT cache (8h TTL)
  - `qwen-cache/google/` - Google cache (8h TTL)
  - `qwen-src/` - Qwen source code

### Stage 2 — Provider and Cache Foundation
- Status: `done`
- Goal:
  - wire provider access strategy
  - enforce 8-hour cache for Brave, GDELT, and Google from the start
- Validation:
  - cache behavior is verifiable
  - repeated request path is bounded
- Exit condition:
  - discovery requests do not bypass the cache layer
- Files created:
  - `qwen-scripts/utils/cache-manager.js` - Unified cache with 8h TTL
  - `qwen-scripts/utils/api-clients.js` - API wrappers with cache integration

### Stage 3 — Discovery and Event Brief Layer
- Status: `done`
- Goal:
  - implement fresh-signal discovery
  - normalize usable candidates into event briefs
- Validation:
  - candidate output is inspectable
  - weak/noisy candidates are rejected
- Exit condition:
  - at least one clean event brief can be produced
- Files created:
  - `qwen-scripts/discovery.js` - Brave + GDELT discovery with 8h cache
  - `qwen-scripts/event-brief-builder.js` - AI normalization and topic selection
- Features:
  - Multi-query discovery across news categories
  - Noise filtering (opinion, editorial, stale content)
  - Duplicate detection by title hash
  - Freshness and urgency scoring
  - AI-powered brief normalization
  - Publishability scoring (0-10)

### Stage 4 — Publishability and Source Pack Gate
- Status: `done`
- Goal:
  - verify source sufficiency before drafting
  - reject weak topics early
- Validation:
  - source pack is inspectable
  - insufficiency causes rejection
- Exit condition:
  - one publishable candidate can pass the gate
- Files created:
  - `qwen-scripts/source-pack.js` - Source assembly and publishability gate
  - `qwen-scripts/pipeline.js` - Pipeline runner (discovery → brief → source pack)
- Features:
  - Multi-source fetching via Brave and Google (8h cached)
  - Source credibility scoring (0-10)
  - Unique domain counting
  - Primary source detection (.gov, press releases)
  - Publishability gate with configurable thresholds
  - Gate notes explain pass/fail reasons
- Thresholds:
  - minSources: 2
  - minUniqueDomains: 2
  - minCredibilityScore: 5
  - requirePrimarySource: true

### Stage 5 — Claim Map and Drafting
- Status: `done`
- Goal:
  - create claim-backed drafting flow
  - produce readable editorial article output
- Validation:
  - article draft exists
  - major claims are traceable
- Exit condition:
  - one article draft reaches reviewable quality
- Files created:
  - `qwen-scripts/claim-map.js` - Claim extraction and validation
  - `qwen-scripts/article-drafter.js` - Article drafting with hardening
  - `qwen-scripts/pipeline.js` - Updated with Stage 5-6 integration
- Features:
  - AI-powered claim extraction from sources
  - Claim types: factual, analytical, contextual
  - Confidence scoring per claim
  - Supported/unsupported status tracking
  - Claim map quality gate
  - Editorial article drafting (500-800 words)
  - Draft hardening (removes debug artifacts)

### Stage 6 — Media / Image Support
- Status: `done`
- Goal:
  - attach relevant article imagery and alt text when valid media path exists
- Validation:
  - image path is confirmed
  - article/card rendering supports image data
- Exit condition:
  - article can render with relevant image support
- Files created:
  - `qwen-scripts/image-support.js` - Pexels integration and fallback handling
  - `qwen-scripts/pipeline.js` - Updated with Stage 7 image integration
- Features:
  - Pexels API search with keyword extraction
  - Image download and save to src/assets/images/posts/{slug}/
  - Metadata JSON saved alongside image
  - Alt text generation for accessibility
  - Fallback to default SVG image
  - Frontmatter image binding

### Stage 7 — Local Site Visibility Verification
- Status: `done`
- Goal:
  - verify localhost page access
  - verify article URL access
  - verify article visibility in listing/homepage path where applicable
- Validation:
  - local verification recorded with pass/fail details
- Exit condition:
  - article is visibly present on local site
- Files created:
  - `qwen-scripts/local-verification.js` - Localhost and article URL verification
  - `qwen-scripts/pipeline.js` - Updated with Stage 8 verification integration
- Features:
  - Localhost health check with timeout
  - Article URL reachability check
  - Homepage visibility check (slug/title matching)
  - Verification report generation
  - Advisory-only mode (doesn't block pipeline)

### Stage 8 — End-to-End Hardening
- Status: `done`
- Goal:
  - remove weak edges
  - clean public output
  - verify completion against definition of done
- Validation:
  - definition-of-done checklist passes
- Exit condition:
  - project reaches end-to-end success criteria
- Files updated:
  - `qwen-scripts/pipeline.js` - Full pipeline integration
  - All governance files updated with final status
- Summary:
  - All 8 stages implemented (0-7 complete, 8 validated)
  - Pipeline ready for live testing with API keys
  - Definition of Done gates: 10/11 pass, 1 requires live API testing

### Batch 1 — Pipeline Truth and Publishing Discipline Fixes
- Status: `done`
- Goal:
  - Fix pipeline.js execution order (publish → verify, not verify → publish)
  - Make success depend on real stage completion (source pack gate, claim map gate, publish, verification)
  - Stop pipeline if source pack or claim map fails
  - Final result must report: success, hard_blocker, published_path, verified_url, stage results
  - Fix publisher.js to preserve placement taxonomy (section/subsection/tags)
  - Add required field validation (title, slug, article_type, excerpt, image)
  - Implement atomic write behavior
  - Return complete publish metadata
- Validation:
  - Pipeline order verified: Stage 7 (Publish) → Stage 8 (Local Verification)
  - Publisher returns: canonicalSlug, filename, filePath, expectedUrl, publishedAt
  - Failed publish returns success: false with error message
  - Local verification not called before publish (code inspection)
  - Final result object includes all required fields
- Exit condition:
  - Both files fixed and validated
  - Governance files updated
- Files changed:
  - `qwen-scripts/pipeline.js` - Complete rewrite with correct execution order and honest reporting
  - `qwen-scripts/publisher.js` - Complete rewrite with validation, atomic writes, and metadata

### Batch 2 — Local Verification Truth and Source Pack Discipline Fixes
- Status: `done`
- Goal:
  - Fix local-verification.js to work as real post-publish validation (not advisory)
  - Distinguish failure outcomes: localhost unreachable, article URL unreachable, homepage missing, article not visible
  - Add polling/retry logic after publish to wait for Astro to pick up new article
  - Verify article identity (title/slug/card visibility) not just URL existence
  - Require all critical checks for pass: localhost + article URL + homepage/listing
  - Fix source-pack.js: remove rigid global primary-source requirement
  - Support route-aware sufficiency logic (different rules for report/analysis/explainer)
  - Failed source pack must stay failed (no fake success)
  - Improve credibility scoring to tiered model (official, major/wire, specialist, low-confidence)
  - Improve deduplication with canonical domain/url logic
  - Make output explicit: pass/fail, why, domain count, tier mix, publishable
- Validation:
  - Local verification requires publishResult.filePath before running (post-publish only)
  - Local verification can fail with specific failureReason (code inspection)
  - Local verification passes only when localhost + article URL + homepage all confirmed
  - Source-pack failure stays real failure: selectPublishableCandidate returns null if none pass
  - Route-aware logic: ROUTE_THRESHOLDS has different rules for report/analysis/explainer
  - Weak candidates not upgraded: filter to passesGate only, no fallback to failed candidates
- Exit condition:
  - Both files fixed and validated
  - Governance files updated
- Files changed:
  - `qwen-scripts/local-verification.js` - Complete rewrite with hard gate, polling, identity verification
  - `qwen-scripts/source-pack.js` - Complete rewrite with route-aware thresholds, tiered model, honest gating

### Batch 3 — Provider Truth and Evidence Discipline Fixes
- Status: `done`
- Goal:
  - Fix api-clients.js: make provider behavior observable (skipped, called, auth failure, rate limit, etc.)
  - Add GDELT backoff and jitter for 429 responses (no blind hammering)
  - Add negative-cache behavior for repeated transient failures (5-minute TTL)
  - Separate cache-hit reporting from real network-call reporting
  - Add provider circuit-breaker pattern (3 failures → open, 60s reset)
  - Verify Brave endpoint, headers, key presence, response handling
  - Keep 8-hour cache rule intact
  - Fix claim-map.js: claims must be grounded in explicit evidence passages
  - Weak fallback claim map must remain clearly degraded/failed (not fake success)
  - Separate claim types (factual, contextual, analytical) with different weights
  - Don't treat all claim types as equally strong evidence
  - Make output explicit: quality state, evidence basis, unsupported claims, drafting suitability
- Validation:
  - Brave skip/fail/call states clearly distinguishable via PROVIDER_STATUS constants
  - GDELT 429 handling uses exponential backoff (1s, 2s, 4s) with 0-30% jitter, max 3 retries
  - Cache-hit vs real-network-call visible in logs ([cache] HIT vs [cache] MISS) and result.cacheHit
  - Claim-map fallback cannot masquerade as strong pass: isFallback=true, safeForDrafting=false
  - Claim-map output indicates evidence strength (strong/moderate/weak/none) and drafting suitability
  - Pipeline contracts preserved: validateClaimMap still returns {passes, issues} plus extended metadata
- Exit condition:
  - Both files fixed and validated
  - Governance files updated
- Files changed:
  - `qwen-scripts/utils/api-clients.js` - Complete rewrite with circuit-breaker, negative cache, observable status
  - `qwen-scripts/claim-map.js` - Complete rewrite with evidence grounding, quality states, explicit degradation

### Batch 4 — Drafting Truth and Prompt Assembly Discipline Fixes
- Status: `done`
- Goal:
  - Fix article-drafter.js: make drafting honest, compact, production-oriented
  - Do not log/print giant full prompts into console output
  - Make forecast inclusion route-aware, type-aware, evidence-aware (not force includeForecast: true)
  - If drafting falls back too far, do not let fallback draft behave like normal publishable success
  - Make draft output clearly distinguish: strong draft, degraded draft, failed draft
  - Strengthen structured output handling (less dependent on loose "extract JSON" behavior)
  - Keep existing runtime flow compatible but make result safer and more explicit
  - Make drafting result explicit about: pass/fail/degraded, writer used, forecast included, why safe/unsafe
  - Hardening should use claim-map/evidence truth to avoid unsupported passages surviving
  - Fix prompt-assembler.js: simplify so layers do not fight each other
  - Remove instruction duplication between: core, article-type, writer, forecast layers
  - Each layer must have one clear responsibility
  - Make final assembled prompt shorter, clearer, less internally repetitive
  - Keep writer personality separate from factual/evidence rules
  - Keep forecast logic separate from personality logic
- Validation:
  - Full prompt text no longer dumped noisily (logs assembly summary + prompt size only)
  - Forecast no longer blindly included for every article (only breaking/analysis/deep-dive with evidence)
  - Degraded draft state distinguishable from true publishable success (safeForPublishing flag)
  - Prompt assembly materially cleaner and less duplicative (layer responsibilities documented)
  - Writer/style instructions no longer duplicate core/editorial rules unnecessarily
  - Pipeline contracts preserved: draftArticle returns draft object, hardenDraft preserves metadata
- Exit condition:
  - Both files fixed and validated
  - Governance files updated
- Files changed:
  - `qwen-scripts/article-drafter.js` - Complete rewrite with quality states, evidence-aware forecasting, robust JSON extraction
  - `qwen-scripts/writers/prompt-assembler.js` - Complete rewrite with clear layer responsibilities, no duplication

### Batch 5 — Writer Routing and Prompt Truth Fixes
- Status: `done`
- Goal:
  - Fix writer-selector.js: remove weak placeholder routing (crude title-word beat inference)
  - Remove weak default subsection behavior (always 'General')
  - Make selection depend on cleaner routed story data (article type, section, subsection, tags, topic fit)
  - Keep hybrid routing model (taxonomy decides where, writer selection decides who)
  - Writers not hard-locked to one category, support primary_beats/secondary_beats/preferred_article_types
  - Improve anti-streak logic, make rotation state persistent where practical
  - Selection result must clearly report: selected writer, why selected, fit factors, fallback used
  - Fix core-editorial-prompt.js: define central article task and reader outcome only
  - Fix article-type-layers.js: define route-specific shaping only (already clean)
  - Fix writer-registry.js: define writer identity, voice, style only (no structural control duplication)
  - Keep writer system scalable and modular (4-writer starter model)
  - Fix governance truth: make status reporting honest, align validation-status.md with actual state
- Validation:
  - Writer selection uses better routing inputs (eventBrief.articleType, claimMap.claimsByType, sourcePack domains, involvedParties)
  - Anti-streak/rotation behavior more credible (streak tracking, 24h reset, penalty 0-3)
  - Writer rotation state no longer purely process-memory only (persistent JSON file)
  - Core prompt, article-type layers, writer personas have cleaner non-overlapping responsibilities
  - Writer system remains scalable and modular (4 writers, easy to add more)
  - Governance files match real state honestly (validation-status.md updated)
  - Pipeline contracts preserved (classifyStory, selectWriter signatures compatible)
- Exit condition:
  - All 6 files fixed and validated
  - Governance files updated
  - 5-batch repair sequence complete
- Files changed:
  - `qwen-scripts/writers/writer-selector.js` - Complete rewrite with taxonomy-aware routing, persistent rotation state
  - `qwen-scripts/writers/core-editorial-prompt.js` - Reduced to core responsibility only
  - `qwen-scripts/writers/writer-registry.js` - Removed structural control, VOICE + STYLE only
  - `qwen-project-governance/qwen-current-context.md` - Updated with Batch 5 status
  - `qwen-project-governance/qwen-task-queue.md` - Added Batch 5 stage
  - `qwen-project-governance/qwen-operations-log.md` - Added execution log
  - `qwen-project-governance/qwen-runtime-reports/current-run/validation-status.md` - Updated with honest validation state

## Active Blockers
- None recorded yet

## Deferred / Optional
- Performance tuning beyond required cache rules
- Additional media enrichment beyond first valid image path
- Non-local deployment concerns after local success is stable

## Update Rule
After each meaningful stage:
- update stage status
- add new blocker if needed
- record the next active task

### [2026-03-29T15:42:47.032Z] Article Quality Pass (2026-03-29T15-42-46-261Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T15-42-46-261Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:26:24.848Z] Article Quality Pass (2026-03-29T17-26-23-008Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-26-23-008Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:27:49.919Z] Article Quality Pass (2026-03-29T17-27-48-495Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-27-48-495Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:30:16.309Z] Article Quality Pass (2026-03-29T17-30-14-895Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-30-14-895Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:48:30.126Z] Article Quality Pass (2026-03-29T17-48-27-854Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-48-27-854Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:49:38.494Z] Article Quality Pass (2026-03-29T17-49-36-777Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-49-36-777Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T17:55:01.884Z] Article Quality Pass (2026-03-29T17-55-00-226Z)
- Status: done
- Scope: full auto loop over all live articles in `src/data/post`
- Output: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-55-00-226Z/`
- Notes: conservative per-article repairs with validation before each write

### [2026-03-29T12:58:40.851-05:00] Targeted Cleanup (post article-quality-pass)
- Status: done
- Scope: deterministic cleanup of remaining live-article issues (taxonomy/tags/sources/imageAlt/duplicates)
- Validation: dry-run report `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-57-57-810Z/`
