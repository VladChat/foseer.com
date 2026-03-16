<!--
File: AGENTS.md
Purpose: Global instructions for AI agents working on the Foseer project.
-->

# Foseer Agent Instructions

## 1. Project Philosophy

Foseer is a news and analysis website.

Externally, it should feel like a normal editorial product with sections, articles, trending topics, analysis, topic pages, and a credible newsroom-style experience.

Internally, it may use automation, AI, trend detection, analytics, ranking, forecasting, and editorial pipelines — but these mechanisms must remain invisible in the public-facing experience unless the user explicitly asks to expose them.

This is **not** an AI product website.
This is a **news and analysis website** that may use AI internally as an editorial tool.

## 2. Core Architecture

### Public site
- Framework: Astro
- Current starter/theme base: AstroWind
- Rendering model: static site by default
- Runtime database: **do not require one** unless explicitly approved
- Public pages should work without a live database dependency whenever possible

### Internal newsroom system
- May exist separately from the public site
- May use ingestion, ranking, analytics, forecasting, trend scoring, and optional database storage
- Must not make the public site fragile or DB-dependent unless explicitly approved

### Preferred architecture rule
Use this model by default:

1. External/internal pipeline collects and analyzes news
2. Pipeline exports ready content files or safe static build inputs
3. Astro renders the public site from files
4. Public site remains fast, simple, and static

## 3. Product Direction

The public site should move toward a minimal, clean editorial structure such as:

- Home
- Latest
- Trending
- Analysis
- Topics
- Article pages

Avoid keeping demo pages, template routes, placeholder widgets, or SaaS/marketing leftovers that are not part of the real Foseer product.

If a route has no real content or no real purpose, remove it or disable links to it.

## 4. Repository Reality

This repository is currently an Astro 5.x project built on AstroWind.

Important existing engine points:

- Global site/blog configuration lives in `src/config.yaml`
- Content collections are defined in `src/content/config.ts`
- Posts currently load from `src/data/post`
- Blog logic lives in `src/utils/blog.ts`
- Permalink logic lives in `src/utils/permalinks.ts`
- Navigation lives in `src/navigation.ts`
- Layouts live in `src/layouts`
- Components live in `src/components`
- Static public assets live in `public/`
- Bundled project assets live in `src/assets/`

Treat AstroWind as the current engine layer, but shape the product toward Foseer’s editorial/news use case.

## 5. Source-of-Truth Files

Before changing structure, routing, or content behavior, check the relevant source-of-truth files first.

### Site and blog configuration
- `src/config.yaml`

### Content collections and schema
- `src/content/config.ts`

### Blog/content normalization and related-post logic
- `src/utils/blog.ts`

### Permalink and canonical URL helpers
- `src/utils/permalinks.ts`

### Navigation
- `src/navigation.ts`

### Main route layer
- `src/pages/`

### Layout layer
- `src/layouts/`

### Blog components
- `src/components/blog/`

### Common/site-wide components
- `src/components/common/`
- `src/components/ui/`
- `src/components/widgets/`

## 6. Non-Negotiable Rules

### 6.1 File header convention
Every new file must begin with a short header.

Examples:

For TS/JS files:
```ts
// File: src/utils/example.ts
// Purpose: Short one-line purpose.