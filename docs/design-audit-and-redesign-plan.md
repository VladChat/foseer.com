<!--
path: docs/design-audit-and-redesign-plan.md
purpose: Record a verified design and structure audit of the restored Foseer baseline and define a phased redesign plan without changing the stack
-->

# Foseer Design Audit and Redesign Plan

## Scope and verification basis

This document records a verified audit of the restored Foseer website baseline at:

- Project root: `C:\Users\vladi\Documents\vcoding\projects\foseer.com`
- Repository source of truth: `https://github.com/VladChat/foseer.com`
- Verified baseline stack: Astro 5, Tailwind CSS, AstroWind-based codebase, npm, static-first direction

The audit is based on inspection of the actual local codebase and the running baseline, including:

- homepage: `src/pages/index.astro`
- header/footer/navigation: `src/navigation.ts`, `src/components/widgets/Header.astro`, `src/components/widgets/Footer.astro`
- page shell: `src/layouts/PageLayout.astro`
- article and archive templates: `src/pages/[...blog]/index.astro`, `src/pages/[...blog]/[...page].astro`, `src/components/blog/SinglePost.astro`, `src/components/blog/List.astro`, `src/components/blog/ListItem.astro`
- taxonomy-driven section/topic pages: `src/pages/sections/[section]/index.astro`, `src/pages/sections/[section]/[topic]/index.astro`
- Foseer-specific homepage modules: `src/components/TrendingTopics.astro`, `src/components/TopSections.astro`
- visual system files: `src/components/CustomStyles.astro`, `src/assets/styles/tailwind.css`, `tailwind.config.js`

The running baseline was also verified locally through the Astro dev server with successful responses for:

- `/`
- `/blog`
- `/news`

And a verified issue for:

- `/sections/technology/ai-big-tech/` returning `404`

## Executive audit summary

The current Foseer baseline has a solid technical foundation and a usable editorial starting point, but the design language and information architecture are still split between:

1. an AstroWind product/marketing template,
2. an emerging editorial/news identity,
3. partially integrated taxonomy-driven content structures.

The result is a site that can run successfully and already contains promising editorial building blocks, but does not yet feel consistently like a trustworthy news and analysis publication.

## What should be kept

### 1. Technical baseline

- Astro 5 + Tailwind CSS + AstroWind base
- npm workflow
- static-first delivery model
- reusable layout/component system already in place

### 2. Useful editorial structure already present

- `PageLayout.astro` with shared header/footer shell
- article template metadata in `SinglePost.astro` (date, author, category, reading time, tags)
- Foseer-specific homepage modules:
  - `TrendingTopics.astro`
  - `TopSections.astro`
- taxonomy-driven section/topic direction

### 3. Current visual strengths

- clean baseline spacing and responsive grid behavior
- readable default typography and strong utility-based styling system
- reusable card/list patterns that can be refined instead of replaced
- restrained overall visual noise compared with heavier news templates

## What should be cleaned up

### 1. Brand and copy consistency

Verified issues:

- homepage title and messaging still read like a product/strategy site:
  - `Where Insight Becomes Opportunity`
  - `Smart news, trends, tools, and ideas translated into action`
- `/blog` still uses template copy:
  - `The Blog`
  - `A statically generated blog example with news, tutorials, resources and other interesting content related to AstroWind`

These weaken trust and do not match the target of a real editorial publication.

### 2. Visual tone

Verified issues:

- hero scale and CTA styling feel startup/SaaS-oriented rather than editorial
- Inter is used for all roles, including headings and serif slots, producing a clean but generic tone
- accent usage and pill/badge styling feel product-template driven more than newsroom-driven

### 3. Information architecture clarity

Verified issues:

- navigation presents a news-style structure, but the codebase still contains legacy template routes such as:
  - `homes/*`
  - `landing/*`
  - `pricing.astro`
  - `services.astro`
- the site structure therefore still mixes editorial and template-marketing concepts

### 4. Editorial trust and hierarchy

Verified issues:

- article templates include useful metadata, but there is not yet enough publication-style hierarchy or trust framing
- footer is structurally sound but light on newsroom identity and credibility cues
- section and topic pages are promising but still feel like early taxonomy scaffolding rather than finished editorial indexes

### 5. Baseline polish issues

Verified issues:

- Astro warns about `src/pages/index.astro-bak`
- page title composition is inconsistent, including `News — Foseer — Foseer`
- at least one taxonomy route tested during audit returned `404`

## What should be removed or deprioritized

The following should not remain prominent in the public-facing IA unless given a specific editorial purpose:

- legacy AstroWind marketing/template routes and concepts
- startup/product-style framing in homepage and archive copy
- generic template phrasing that references AstroWind or tutorial/resource-blog framing
- overly promotional CTA patterns that compete with editorial hierarchy

This does **not** require a stack rewrite. It requires content, IA, and template cleanup on top of the current Astro baseline.

## What should be redesigned first

Priority order:

1. visual foundation and editorial brand language
2. homepage editorial hierarchy
3. article/archive presentation system
4. trust signals and content normalization
5. only then optional lightweight dynamic features if clearly justified

## Concrete phased redesign plan

## Phase 1 — Visual foundation and branding cleanup

### Goal

Make the site immediately read as a real editorial publication rather than a repurposed startup template.

### Priorities

- replace remaining product/strategy phrasing with publication-grade editorial language
- remove or rewrite visible AstroWind/template carryover in public pages
- normalize title patterns and metadata composition
- refine typography scale so homepage and archive headings feel editorial, not SaaS-marketing driven
- tighten accent usage so color supports hierarchy instead of branding theatrics

### Expected outcomes

- clearer editorial identity
- more serious and trustworthy first impression
- less template carryover in visible UI

## Phase 2 — Homepage editorial restructuring

### Goal

Turn the homepage into a newsroom-style front page built from the current component system.

### Priorities

- restructure the homepage around editorial hierarchy rather than landing-page persuasion flow
- elevate the lead story / lead package concept above generic hero marketing energy
- keep `TrendingTopics` and `TopSections`, but reposition them as editorial modules within a stronger homepage narrative
- rewrite or replace the current `How we cover the stories that matter` block so it functions as editorial mission/trust framing rather than product explainer content
- strengthen ranking clarity between top stories, trending topics, sections, and latest analysis

### Expected outcomes

- homepage feels like a publication front page
- better scannability and story hierarchy
- stronger alignment with a news/analysis product identity

## Phase 3 — Article/archive/template refinement

### Goal

Make content consumption pages feel deliberate, credible, and publication-grade.

### Priorities

- rename and rewrite the `/blog` archive to match editorial/news language
- remove AstroWind tutorial/resource framing from archive pages
- improve archive card hierarchy in `ListItem.astro`:
  - section/category prominence
  - metadata rhythm
  - excerpt discipline
- refine `SinglePost.astro` presentation:
  - stronger article header composition
  - cleaner deck/excerpt treatment
  - better headline width and vertical rhythm
- bring section/topic pages closer to real editorial landing pages instead of placeholder taxonomy views

### Expected outcomes

- archive experience feels intentional and news-like
- article templates better support authority and readability
- taxonomy pages become part of a coherent public IA

## Phase 4 — Content normalization and trust signals

### Goal

Make the public site feel credible, consistent, and publication-ready without adding backend complexity.

### Priorities

- normalize all public-facing labels to editorial/news terminology
- remove any visible AI framing from user-facing copy
- strengthen trust signals using static-first methods:
  - clearer section labels
  - consistent author/date/category display
  - stronger about/editorial framing
  - better footer publication identity
- review which existing routes belong in the public publication IA and which should be retired from navigation
- resolve baseline polish issues such as duplicated page titles and the `index.astro-bak` warning source

### Expected outcomes

- stronger editorial trust
- cleaner public-facing information architecture
- more consistent publication voice

## Phase 5 — Optional minimal dynamic features only if justified

### Goal

Add only lightweight enhancements that improve usability without changing the stack or pushing the project toward backend-first architecture.

### Acceptable direction

- static-build-friendly archive filtering/search if justified
- lightweight reading or discovery enhancements that remain compatible with static-first delivery
- minimal client-side behaviors only where they clearly improve editorial usability

### Explicit non-goals for this phase

- no backend rewrite
- no stack rewrite
- no database dependency unless future verified needs justify a separate decision
- no reframing of the frontend around Node/Supabase as the primary base

## Highest-priority weaknesses to address first

These are the most important verified issues revealed by the audit:

1. visible AstroWind/template carryover on archive and supporting pages
2. homepage language that feels like a product/insight startup instead of an editorial publication
3. mixed IA caused by coexistence of editorial routes and leftover marketing-template routes
4. insufficient editorial trust signals and publication hierarchy
5. baseline polish issues such as duplicate titles, unsupported backup file warning, and broken/404 taxonomy experience

## Final planning note

This redesign plan intentionally builds on the verified Astro/AstroWind baseline.

It does **not** require changing the stack, introducing backend architecture, or adding database dependencies. The strongest path forward is to clean and focus the existing static-first system until the site feels unmistakably like a credible editorial news and analysis publication.

## Responsive Design Validation Rule

### Mandatory Responsive Verification

All future UI work on the Foseer project must automatically verify mobile and tablet layouts without requiring reminders in prompts. Responsive validation is now a mandatory requirement for every design phase and implementation.

### Required Breakpoints

Every UI change must be validated at minimum breakpoints:
- Mobile: 375px
- Large Mobile: 428px
- Tablet Portrait: 768px
- Tablet Landscape (iPad): 1024px
- Desktop: 1280px+

### Required Responsive Checks

Each responsive validation must verify:
- Layout does not overflow horizontally
- Text remains readable
- Navigation works on small screens
- Card grids collapse correctly
- Hero sections scale properly
- Spacing and typography remain balanced
- No clipped elements

### Implementation Requirement

Responsive validation is mandatory for every design phase. All future design implementations must verify responsive behavior before reporting completion. This rule is now part of the persistent project memory and must be followed by all future agents working on the Foseer project.
