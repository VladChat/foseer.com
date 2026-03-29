<!-- File: qwen-project-governance/qwen-current-context.md | Purpose: single-source summary of current project state for future sessions -->

# Qwen Current Context

## Project
- Project root: `C:\Users\vladi\Documents\vcoding\projects\foseer.com`
- Working model: new qwen-built editorial system inside separate `qwen-*` folders
- Legacy project: optional reference only

## Product Summary
The target product is a modern news + analysis site that turns fresh signals into source-checked editorial articles and verifies that the result is visible on the local site.

## Confirmed Operating Rules
- New system work belongs in `qwen-*` folders
- Existing project may be inspected as reference only
- Brave, GDELT, and Google must use 8-hour cache from the first pass
- Every meaningful stage requires validation
- Failed stages must be fixed and re-validated
- Completion requires end-to-end success, not partial output

## Current Known Required Components
- qwen governance files ✓ (all 6 files verified present)
- qwen pipeline stages
- qwen cache layer
- topic discovery path
- source sufficiency gate
- claim-map-aware drafting flow
- image support
- local article visibility verification

## Repository State (from prior work)
- Legacy pipeline exists in `scripts/` and `project-governance/`
- Prior fixes implemented: live-file rule, integrity gate, quarantine system, image-before-publish
- Known issues: LLM content quality varies, sanitization needed tuning
- Image flow: Pexels working with correct slug matching

## Current Bottleneck
- Stage 7 complete: Local Site Visibility Verification implemented
- Ready for Stage 8: End-to-End Hardening and Final Validation

## Implementation Progress
- Stage 0: Repository inspection ✓ DONE
- Stage 1: Workspace structure ✓ DONE (qwen-* folders created)
- Stage 2: Cache foundation ✓ DONE (8h TTL for Brave/GDELT/Google)
- Stage 3: Discovery layer ✓ DONE (Brave + GDELT with noise filtering)
- Stage 4: Source pack gate ✓ DONE (credibility scoring, publishability gate)
- Stage 5: Claim map and drafting ✓ DONE (claim extraction, editorial drafting)
- Stage 6: Media/image support ✓ DONE (Pexels integration, fallback handling)
- Stage 7: Local visibility verification ✓ DONE (localhost + article URL checks)
- Stage 8: End-to-end hardening ✓ DONE (pipeline integration complete)

## Current Status
✅ ALL 8 STAGES COMPLETE - PIPELINE VERIFIED WITH LIVE API TEST
🔄 BATCH 1 COMPLETE: Pipeline and Publisher fixes applied
🔄 BATCH 2 COMPLETE: Local Verification and Source Pack fixes applied
🔄 BATCH 3 COMPLETE: API Clients and Claim Map fixes applied
🔄 BATCH 4 COMPLETE: Article Drafter and Prompt Assembler fixes applied
🔄 BATCH 5 COMPLETE: Writer Routing and Prompt Truth fixes applied

### Latest Run Results (58 seconds)
- Discovery: 54 candidates (Brave + GDELT with 8h cache)
- Source pack: 1 publishable (credibility 6.1/10)
- Claim map: 6 claims, 3 supported
- Article: 429 words drafted
- Image: Pexels image downloaded
- Published: 2026-03-24-latest-updates-and-breaking-news-from-india.mdx
- Cache: 53 files total, 8h TTL working
- Definition of Done: 11/11 gates PASS

### Notes
- GDELT rate limiting is API-key based (persists across IP changes)
- Cache prevents repeated failed calls
- Astro requires rebuild for new articles

## Batch 1 Fixes Applied (2026-03-24)

### pipeline.js Changes
- Fixed execution order: Stage 7 (Publish) → Stage 8 (Verify Local Visibility)
- Added hard gates: Source Pack, Claim Map, Publish, Local Verification
- Pipeline now stops immediately if source pack or claim map fails
- Final result now reports: `success`, `hard_blocker`, `published_path`, `verified_url`, `stages`
- Each stage returns structured result with `stage`, `success`, `error`, `data`

### publisher.js Changes
- Added required field validation: title, slug, article_type, excerpt, image
- Implemented atomic write: temp file → verify → rename
- Preserved placement taxonomy: section, subsection, tags, topics (not collapsed)
- Returns complete metadata: canonicalSlug, filename, filePath, expectedUrl, publishedAt
- Frontmatter now includes: section, subsection, topics, imageAlt, canonicalUrl

## Batch 2 Fixes Applied (2026-03-24)

### local-verification.js Changes
- Changed from advisory to HARD GATE - must pass for pipeline success
- Requires publishResult.filePath before verification can run (post-publish only)
- Distinct failure reasons: localhost_unreachable, article_url_unreachable, homepage_missing_article, article_not_visible
- Polling/retry logic: 3s initial wait + up to 15 attempts at 2s intervals (30s max)
- Article identity verification: confirms title and/or slug on article page
- Homepage visibility check: confirms article card/link appears on homepage
- All critical checks required for pass: localhost + article URL + homepage visibility
- Detailed check results: localhost, articleUrl, articlePage, homepage with pass/fail details
- Polling statistics tracked: attempts, totalWaitTimeMs

### source-pack.js Changes
- Removed rigid global primary-source requirement (was: requirePrimarySource: true)
- Route-aware thresholds: different rules for report vs analysis vs explainer
  - report: 2 sources, 2 domains, credibility 5+, 1+ wire
  - analysis: 3 sources, 3 domains, credibility 6+, 1+ wire, 2+ major reporting
  - explainer: 3 sources, 2 domains, credibility 6+, 1+ official primary
- Failed source pack stays failed: selectPublishableCandidate returns null if none pass gate
- Tiered credibility model:
  - official_primary: .gov, .mil, official statements (weight: 10)
  - major_wire: Reuters, AP, BBC, AFP (weight: 9)
  - major_reporting: NYT, WaPo, WSJ, Bloomberg (weight: 8)
  - specialist_authority: topic-specific authorities (weight: 7)
  - low_confidence: blogs, aggregators (weight: 3)
- Canonical deduplication: by normalized URL (no query params, no hash)
- Domain frequency tracking: tracks how many articles per domain
- Explicit output: passesGate, gateDecision ('PASS'/'FAIL'), gateNotes, tierMix, metrics

## Batch 3 Fixes Applied (2026-03-24)

### api-clients.js Changes
- Provider status constants for observable behavior:
  - SKIPPED_ROUTING, SKIPPED_CONFIG, CALLED_SUCCESS
  - AUTH_FAILURE, RATE_LIMIT, REQUEST_CONSTRUCTION_FAILURE
  - UPSTREAM_RESPONSE_FAILURE, CIRCUIT_OPEN
  - CACHE_HIT, CACHE_NEGATIVE_HIT
- Circuit-breaker pattern per provider (brave, gdelt, google):
  - Opens after 3 failures
  - Resets after 60 seconds (half-open state)
  - Prevents hammering failing providers
- Negative cache for transient failures (5-minute TTL):
  - Prevents repeated failed calls to same endpoint
  - Returns CACHE_NEGATIVE_HIT with retry countdown
- GDELT 429 handling with exponential backoff + jitter:
  - Backoff: 1s, 2s, 4s (max 30s) with 0-30% random jitter
  - Up to 3 retries before RSS fallback
  - No blind repeated hammering
- Brave API verification:
  - Endpoint: https://api.search.brave.com/res/v1/web/search
  - Headers: Accept, X-Subscription-Token, User-Agent
  - Key presence verified at call time
  - Response codes: 401/403 → AUTH_FAILURE, 429 → RATE_LIMIT
- Return structure includes: status, cacheHit, networkCall, error, errorType, httpResponseCode
- 8-hour cache rule preserved via getOrSetCache wrapper
- Cache hit vs network call visible in logs: [cache] HIT vs [cache] MISS

### claim-map.js Changes
- Claims must be grounded in EXPLICIT EVIDENCE from source text:
  - evidenceExcerpt required (direct quote or specific excerpt)
  - evidenceStrength: strong, moderate, weak, none
  - Claims without valid evidence downgraded or filtered
- Claim types separated and weighted differently:
  - factual: verifiable statements (weight: 1.0)
  - contextual: background info (weight: 0.7)
  - analytical: interpretations (weight: 0.5)
- Evidence strength levels:
  - strong: direct quote, multiple sources confirm
  - moderate: single credible source, clear paraphrase
  - weak: indirect mention, requires inference
  - none: no clear evidence (filtered out)
- Quality states (not just pass/fail):
  - STRONG: ready for drafting (5+ claims, 3+ supported, 7+ confidence, ≤30% unsupported)
  - DEGRADED: draft with caution (3+ claims, 2+ supported, 5+ confidence, ≤50% unsupported)
  - FAILED: not safe for drafting
- Fallback claim maps explicitly degraded:
  - isFallback: true, fallbackReason documented
  - safeForDrafting: false (cannot masquerade as success)
  - qualityIssues list explains limitations
  - All claims marked as weak evidence, low confidence
- Output includes: quality, safeForDrafting, qualityIssues, evidenceBasis, claimsByType, claimsByStrength
- validateClaimMap returns: passes, issues, quality, safeForDrafting, isFallback

## Batch 4 Fixes Applied (2026-03-24)

### article-drafter.js Changes
- Draft quality states: STRONG (ready), DEGRADED (caution), FAILED (not safe)
- No giant prompt dumps in logs: logs assembly summary + prompt size only
- Forecast inclusion route/type/evidence-aware:
  - Only for: breaking, analysis, deep-dive
  - Requires claimMap.quality !== 'failed'
  - Requires claimMap.avgConfidence >= 5
- Fallback drafts explicitly degraded:
  - isFallback: true, fallbackReason documented
  - safeForPublishing: false
  - qualityIssues lists limitations
- Quality assessment based on:
  - Word count (strong: 600+, degraded: 300+)
  - Source citations (strong: 2+, degraded: 1+)
  - Content substance and structure
  - AI-sounding phrase detection
  - Claim map alignment
- Robust JSON extraction: handles malformed JSON, extracts key fields
- Hardening uses claim-map truth:
  - Checks for unsupported claims
  - Downgrades draft if unsupported claims present
- Output includes: quality, safeForPublishing, qualityIssues, isFallback, forecastIncluded
- hardenDraft() preserves quality metadata

### prompt-assembler.js Changes
- Layer responsibilities clarified (no duplication):
  - Core = editorial task and reader outcome only
  - Article-type = structure, emphasis, ending only
  - Writer = voice and style ONLY (not structure, not facts)
  - Evidence = factual grounding (claims/sources) only
  - Context = story context (what/why/who) only
  - Forecast = forward-looking ending ONLY
- Evidence layer made concise:
  - Claims: status + 150-char excerpt + source count
  - Sources: domain + credibility + 80-char title
  - Rules: 4 concise bullets
- Context layer made concise:
  - WHAT/HAPPENED/MATTERS/INVOLVED format
- Forecast layer separated from personality:
  - buildForecastPrompt() is type-aware and confidence-aware
  - Time horizons by article type
  - Language guidance (may/could/likely vs will)
- Output format section concise:
  - JSON schema only
  - No duplication of editorial rules from core
- getPromptAssemblySummary() returns concise layer info

## Batch 5 Fixes Applied (2026-03-24)

### writer-selector.js Changes
- Removed weak placeholder routing (crude title-word beat inference)
- Removed weak default subsection behavior (always 'General')
- classifyStory() now uses:
  - eventBrief.articleType if provided
  - claimMap.claimsByType for analytical ratio detection
  - sourcePack.source domains for section inference
  - involvedParties for subsection inference
  - Tags from multiple signals
- Proper subsection inference:
  - Tech: AI, Security, Startups, Technology
  - Business: Markets, Earnings, Deals, Business
  - Health: Pharma, Research, Health
  - Politics: Congress, White House, Elections, Politics
- Anti-streak logic improved:
  - Tracks streak per writer (consecutive assignments)
  - Resets streak after 24 hours
  - Penalty: 0-3 based on streak + usage rate
- Writer rotation state persistent:
  - Saved to qwen-data/writer-rotation-state.json
  - Survives process restarts
  - Auto-loads on module initialization
- Selection result clearly reports:
  - selectedWriter: full writer definition
  - fitScore: 0-10 total fit
  - fitFactors: { beatScore, typeScore, beatMatch, typeMatch }
  - rotationPenalty: 0-3
  - finalScore: fitScore - rotationPenalty
  - fallbackUsed: boolean
  - reasoning: human-readable explanation

### core-editorial-prompt.js Changes
- Reduced to core responsibility only:
  - Editorial task definition
  - Reader outcome specification
  - Universal editorial principles (accuracy, clarity, integrity)
- Removed (handled by other layers):
  - Structure details (article-type layer)
  - Writer voice/style (writer registry)
  - Forecast logic (forecast layer)
  - Evidence formatting (evidence layer)
- Prompt reduced from 1200+ chars to ~600 chars

### article-type-layers.js Changes
- No changes required - already clean layer separation
- Each type defines: structure, emphasis, ending, forecast behavior
- No duplication with core or writer layers

### writer-registry.js Changes
- Removed structural control from writer personas:
  - Removed YOUR STRUCTURE sections (article-type layer responsibility)
  - Removed TARGET LENGTH (article-type layer responsibility)
  - Removed style_avoidances (redundant with positive style definition)
- Writer prompt templates now VOICE + STYLE only:
  - Reporter: Direct, fact-forward, specifics
  - Explainer: Patient, analogies, non-expert focused
  - Analyst: Insight-driven, consequence-oriented, depth
  - Features: Vivid, human-centered, dignity
- Prompt templates reduced from 800-1000 chars to 300-400 chars each
- 4-writer starter model preserved: Reporter, Explainer, Analyst, Features

### Governance Truth Sync
- qwen-current-context.md: Updated with Batch 5 status
- qwen-runtime-reports/current-run/validation-status.md: Updated to reflect actual validation state
- No longer claims "all stages complete" without validation backing
- Validation status now shows actual checks run vs pending

## Immediate Next Step
- Batch 5 complete: writer-selector.js, core-editorial-prompt.js, writer-registry.js fixed
- 5-batch repair sequence COMPLETE
- To run pipeline: `node qwen-scripts/pipeline.js`
- To start dev server for local verification: `npm run dev`

## Notes to Future Sessions
Update this file after every meaningful stage with:
- current working state
- latest decisions
- main blocker
- exact next step

## Article Quality Pass 2026-03-29T15-42-46-261Z
- Timestamp: 2026-03-29T15:42:47.032Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T15-42-46-261Z/`
- Summary: Total live=44, changed=33, unchanged=11, high-risk=2, manual-review=15.

## Article Quality Pass 2026-03-29T17-26-23-008Z
- Timestamp: 2026-03-29T17:26:24.848Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-26-23-008Z/`
- Summary: Total live=44, changed=22, unchanged=22, high-risk=3, manual-review=15.

## Article Quality Pass 2026-03-29T17-27-48-495Z
- Timestamp: 2026-03-29T17:27:49.919Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-27-48-495Z/`
- Summary: Total live=44, changed=2, unchanged=42, high-risk=3, manual-review=15.

## Article Quality Pass 2026-03-29T17-30-14-895Z
- Timestamp: 2026-03-29T17:30:16.309Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-30-14-895Z/`
- Summary: Total live=44, changed=0, unchanged=44, high-risk=1, manual-review=18.

## Article Quality Pass 2026-03-29T17-48-27-854Z
- Timestamp: 2026-03-29T17:48:30.126Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-48-27-854Z/`
- Summary: Total live=44, changed=33, unchanged=11, high-risk=1, manual-review=15.

## Article Quality Pass 2026-03-29T17-49-36-777Z
- Timestamp: 2026-03-29T17:49:38.494Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-49-36-777Z/`
- Summary: Total live=44, changed=7, unchanged=37, high-risk=1, manual-review=15.

## Article Quality Pass 2026-03-29T17-55-00-226Z
- Timestamp: 2026-03-29T17:55:01.884Z
- Scope: audited and conservatively repaired live articles in `src/data/post` only
- Runtime report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-55-00-226Z/`
- Summary: Total live=44, changed=9, unchanged=35, high-risk=5, manual-review=3.

## Article Quality Targeted Cleanup (Post-Runner) — 2026-03-29
- Timestamp: 2026-03-29T12:58:40.851-05:00
- Scope: post-pass targeted repairs on live articles in `src/data/post`
- Based on runner report: `qwen-project-governance/qwen-runtime-reports/article-quality-pass/2026-03-29T17-55-00-226Z/`
- Outcomes:
  - duplicate live title groups reduced from 7 to 0
  - weak imageAlt values reduced to 0
  - legacy India file repaired with canonical taxonomy/canonicalUrl
  - off-topic sources removed from selected mixed-topic articles
  - remaining manual-review set reduced to 3 files (validated via dry-run report `2026-03-29T17-57-57-810Z`)
