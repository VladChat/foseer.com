<!--
File: AGENTS.md
Purpose: Global instructions for AI agents working on the Foseer project.
-->

# Foseer Agent Instructions

## 1. Project Philosophy

Foseer is a news and analysis website.

Externally, it should feel like a normal editorial product with sections, articles, trending topics, analysis, and topic pages.

Internally, it may use automation, AI, trend detection, analytics, and editorial pipelines — but these mechanisms must remain invisible in the public-facing experience.

This is **not** an AI product website.
This is a **news and analysis website** that may use AI internally as an editorial tool.

## 2. Core Architecture

### Public site
- Framework: Astro
- Rendering model: static site
- Runtime database: **do not require one**
- Public pages should work without a live database dependency

### Internal newsroom system
- May exist separately from the public site
- May use ingestion, ranking, analytics, forecasting, and optional database storage
- Must not make the public site fragile or DB-dependent unless explicitly approved

### Architecture rule
Prefer this model:

1. External/internal pipeline collects and analyzes news
2. Pipeline exports ready content files
3. Astro renders the public site from files
4. Public site remains fast, simple, and static

## 3. Current Product Direction

The public site should focus on a minimal, clean editorial structure:

- Home
- Latest
- Trending
- Analysis
- Topics
- Article pages

Avoid keeping template pages or placeholder routes that are not part of the real Foseer product.

If a route has no real content or no real purpose, remove it or disable links to it.

## 4. Non-Negotiable Rules

### 4.1 File header convention
Every new file must begin with a short header.

Examples:

For TS/JS files:
```ts
// File: src/utils/example.ts
// Purpose: Short one-line purpose.