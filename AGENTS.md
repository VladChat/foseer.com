<!--
File: AGENTS.md
Purpose: Canonical instructions for AI agents working on the Foseer editorial system and website.
-->

# Foseer Agent Instructions

## 1. Mission

Foseer is a **news and analysis website**.

Externally, it must feel like a credible editorial product with clear sections, topic pages, article pages, and a consistent newsroom-style experience.

Internally, it may use automation, AI, scoring, ranking, clustering, caching, and multi-step editorial pipelines. These internal mechanisms must stay invisible in public-facing content unless the user explicitly wants them exposed.

This is **not** an AI product website.
This is a **news and analysis website** that uses AI internally as a workflow tool.

## 2. Project Reality

### Active system paths
Treat these as the current live system:

- `qwen-scripts/`
- `qwen-project-governance/`
- `qwen-data/`
- `qwen-cache/`
- `src/`

### Legacy paths
Treat non-`qwen` legacy paths as secondary unless explicitly needed.
Do not build new dependencies on legacy paths.
If a file from an old path is required, copy its logic into the current `qwen-*` system instead of creating new live dependencies outside the active layer.

### Website engine
- Framework: Astro
- Public site should stay stable and renderable without fragile runtime dependencies whenever possible
- Public output should behave like a normal editorial site, not a debug dashboard

## 3. Operating Principles

### 3.1 Contract-based architecture
Every node in the system must work like this:

**input contract → processing → output contract**

Each node must:
- accept standardized input
- perform its own task
- return standardized output
- avoid depending on other nodes' internal implementation details

### 3.2 Registry-driven architecture
Canonical registries are upstream sources of truth.
Downstream nodes must read registries/contracts, not recreate their own hardcoded versions.

### 3.3 No silent reclassification
If upstream already determined canonical placement, downstream nodes must not casually override it.
Any override must be explicit, justified, and compatible with the registry.

### 3.4 Keep useful material
Do not solve quality problems by throwing everything away.
Classify materials by role and keep useful signals for later.
Reject only clear garbage.

## 4. Core Registries

## 4.1 Taxonomy registry
The canonical structural source of truth.

Source:
- `src/data/taxonomy.json`

Compiler:
- `qwen-scripts/compile-taxonomy-registry.js`

Compiled output:
- `qwen-data/contracts/taxonomy-registry.json`

This registry defines:
- sections
- topics
- section → topic mapping
- topic → section mapping
- aliases
- navigation data
- discovery hints
- writer hints
- image hints
- validation rules

### Canonical rule
If `topic_id` is known, `section_id` must be derived from the taxonomy registry.

`topic_id` is authoritative.

## 4.2 Tag registry
The canonical source of approved article tags.

Compiler:
- `qwen-scripts/compile-tag-registry.js`

Compiled output:
- `qwen-data/contracts/tag-registry.json`

The tag registry contains:
- primary topic tags
- theme tags
- entity tags
- geography tags
- format tags
- dedupe rules
- indexability rules

Tags must come from the registry, not from random title fragments.

## 5. Trusted Source Layer

## 5.1 Trusted / whitelist files
Trusted and official domains are defined in:

- `qwen-scripts/config/trusted-publishers.js`

Important lists include:
- `TRUSTED_PUBLISHER_DOMAINS`
- `OFFICIAL_PRIMARY_DOMAINS`
- `DISCOVERY_WHITELIST_DOMAINS`

## 5.2 What whitelist does
Whitelist is a **trust layer**, not a separate crawler.
It affects the system in three ways:

### A. Google trusted discovery
Google runs as a trusted-source discovery channel using whitelisted and official domains.

### B. Trusted boost
Materials from Brave, Google, or GDELT get a trust boost when their domains belong to trusted or official lists.

### C. Source-pack quality
Final publishable source-packs should contain:
- at least one trusted reporting source
  **or**
- at least one official primary source

Best case:
- 1 trusted reporting source
- 1 official/source-of-record source
- 1 additional supporting source

## 5.3 What whitelist does not do
A trusted domain is **not automatically a publishable source**.
Relevance still matters.
A generic page on a trusted domain can still be weak or unusable.

## 6. Cache Policy

Cache exists for:
- Brave
- Google
- GDELT

Cache directories:
- `qwen-cache/brave/`
- `qwen-cache/google/`
- `qwen-cache/gdelt/`

Canonical rule:
- **Cache TTL = 8 hours**

This 8-hour TTL is the single source of truth.
Do not reintroduce 12-hour wording in docs or code.

## 7. Discovery Channels

There are three parallel signal channels:

1. **Brave**
2. **Google trusted**
3. **GDELT**

GDELT is **not** a fallback-only source.
It must run as a normal parallel signal channel alongside Brave and Google.

Brave expansion may still be used later as a secondary widening pass if candidate coverage is too small.

Discovery output should include normalized signal candidates with fields such as:
- `url`
- `canonical_url`
- `title`
- `normalized_title`
- `provider`
- `domain`
- `trustedSource`
- `freshness`
- `entities`
- `section/topic candidates`
- `signal score`

## 8. Node Order

The editorial system should operate in this order:

1. `taxonomy.json`
2. `taxonomy-registry`
3. `discovery`
4. `source normalization`
5. `source role classification`
6. `event clustering`
7. `selection`
8. `source-pack`
9. `writer assignment`
10. `article draft`
11. `tag picker`
12. `image node`
13. `publisher`
14. `publish manifest`
15. `local verification`

## 9. What Each Node Does

## 9.1 Discovery node
Collects external signals from Brave, Google trusted, and GDELT.
Writes and reads cache.
Outputs discovery candidates.

## 9.2 Source normalization node
Normalizes each discovered item before editorial classification.
Tasks include:
- canonical URL cleanup
- normalized title
- domain normalization
- page kind detection

Page kinds may include:
- `article`
- `analysis`
- `official_release`
- `roundup`
- `live`
- `section`
- `topic`
- `homepage`
- `unknown`

## 9.3 Source role node
Assigns one of these roles:
- `core`
- `supporting`
- `background`
- `signal_only`
- `reject`

Definitions:
- `core` = directly about the same event/story
- `supporting` = strengthens the same story
- `background` = useful context only
- `signal_only` = keep in pool, not for this article
- `reject` = obvious garbage

Important rule:
Do not over-delete. Correctly classify first.

## 9.4 Event clustering node
Groups materials into events using:
- shared entities
- action similarity
- place
- time window
- headline similarity
- topic fit
- genericity penalty

Outputs event clusters with:
- cluster id
- canonical title
- role-grouped materials
- placement candidates
- region
- angle

## 9.5 Selection node
Chooses which cluster to publish now.
Should consider:
- freshness
- publishability
- section/topic coverage
- cooldown
- entity repetition
- region repetition
- angle repetition
- core/supporting density
- cluster quality

Selection should support:
- publish now
- defer
- keep in pool

## 9.6 Source-pack node
Builds the final article source package.

Publishable pack should include only:
- `core`
- `supporting`

Keep separately:
- `background`
- `signal_only`
- `excluded`

Frontmatter `sources` must come from publish-ready sources only.

Source-pack may also refine canonical placement using the strongest core/supporting evidence.

## 9.7 Writer assignment node
Receives canonical editorial inputs and decides:
- article type
- structure
- tone
- writer persona/assignment

It should not re-invent taxonomy.

## 9.8 Article drafter node
Writes the actual article using:
- canonical section/topic
- source-pack
- claim map
- article type

It should stay anchored to source-backed facts and avoid puffed policy drift.

## 9.9 Tag node
Assigns tags from the tag registry.

Per article target:
- 1 primary topic tag
- 1–2 theme tags
- 0–2 entity tags
- 0–1 geography tag
- 0–1 format tag

Target total:
- **3–6 tags max**

Do not allow:
- duplicates
- near-duplicates
- title fragments
- clipped junk tags
- random publisher-name tags unless truly central as entities

## 9.10 Image node
Selects imagery using:
- section/topic
- title
- core entities
- theme hints
- recent image history

Do not use vague stock imagery just because it roughly matches the section.
Prefer editorial fit.

## 9.11 Publisher node
Creates the final article artifact:
- slug
- frontmatter
- tags
- sources
- image
- published path
- manifest

Rules:
- do not silently overwrite an existing slug for a different article
- preserve immutable publish output per run
- use cleaned publish-ready sources only

## 9.12 Local verification node
Confirms that the article is actually visible locally.
Should check:
- home page availability
- article URL availability
- article visibility where expected

If verification passes, final pipeline status must not return false.

## 10. Current Known Rules

### 10.1 Topic beats section
If `topic_id` is known, it controls canonical placement.

### 10.2 Source relevance beats trust alone
Trusted domain helps, but does not override event relevance.

### 10.3 Core sources drive routing
Canonical topic/section should be decided primarily from `core` and strong `supporting` sources, not from background noise.

### 10.4 Background is not garbage
Useful background should remain stored for future use even if it is excluded from the current source-pack.

### 10.5 Final article quality beats pipeline convenience
Do not preserve a bad source or bad tag merely because it passed a weak earlier step.

## 11. Validators

Important validation layers include:
- taxonomy registry validator
- tag validator
- publish graph validator
- local verification validator

Validators should enforce contracts, not invent editorial meaning.

## 12. Common Failure Modes to Avoid

Avoid these recurring problems:
- section/topic mismatch
- cross-desk cluster contamination
- generic or roundup pages entering final sources
- duplicated or meaningless tags
- random stock images unrelated to the actual story
- silent slug overwrites
- successful publication reported as final failure
- documentation drifting away from active code

## 13. Editorial Quality Rules

### Sources
Final article sources should be:
- directly relevant to the story
- role-classified correctly
- deduplicated
- not generic container pages unless truly necessary

### Tags
Tags must support:
- clean internal classification
- strong topical hubs
- better related-content logic
- future tag pages when justified

They are **not** old-style keyword stuffing.

### Images
Images must make editorial sense to a reader at a glance.
If the image weakens trust, the image node failed.

### Article text
Articles should:
- stay specific
- keep strong factual anchors
- avoid over-inflated analysis unsupported by the source-pack
- feel like credible newsroom copy, not AI filler

## 14. File and Writing Conventions

### 14.1 File headers
Every new file should start with a short header comment containing:
- file path
- brief purpose

### 14.2 User-facing language
All user-facing text in the website and generated site output must be in **English only**.
Comments may be in Russian.

### 14.3 Keep changes clean
When fixing a node, prefer fixing the contract or registry flow rather than scattering new hardcoded exceptions everywhere.

## 15. Practical Working Rules for Agents

When changing the system:
1. identify the node you are changing
2. identify its input contract
3. identify its output contract
4. verify downstream consumers
5. avoid changing unrelated nodes without reason
6. update docs if you change canonical behavior

When in doubt:
- prefer registry-driven logic
- prefer contract compatibility
- prefer preserving useful signals over deleting them
- prefer clear editorial relevance over brute-force filtering

## 16. Short System Formula

Foseer is a **registry-driven, contract-based, multi-node editorial pipeline**.

Its most important truths are:
- taxonomy is the structural source of truth
- whitelist is the trust layer
- Brave, Google, and GDELT are parallel discovery channels
- source roles and source-pack determine what becomes an article
- tags come from a controlled registry
- publisher and validators finalize the artifact

If a proposed change breaks these principles, it is probably the wrong change.
