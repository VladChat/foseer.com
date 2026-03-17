# Foseer Image System

**Purpose:** Guide for managing article cover images in Foseer.

---

## Quick Start (One Command)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1
```

This runs the full content pipeline:
1. Discovers articles from `src/data/post/`
2. Fetches images from Pexels (if API key set)
3. Normalizes images to 16:9 (1600x900)
4. Creates metadata JSON for each article
5. Verifies the project build

Articles without images automatically use the fallback.

---

## Overview

Foseer uses a local image pipeline for article cover images:

1. Images are stored locally in `src/assets/images/posts/`
2. All articles automatically get a cover image (real or fallback)
3. Images are normalized to 16:9 ratio (1600x900)
4. Pexels API can be used to auto-fetch relevant images with automatic crop/resize
5. The same pipeline works locally and in CI (GitHub Actions)

---

## File Structure

```
src/assets/images/posts/
├── fallback/
│   └── foseer-default-cover.svg    # Fallback for articles without images
└── <article-slug>/                 # Created by fetch script or manually
    ├── cover.jpg                   # Article cover image (1600x900, 16:9)
    └── image-metadata.json         # Source attribution metadata
```

**Note:** Article-specific folders (`<article-slug>/`) are NOT in the repository by default. They are created when you:
1. Run `node scripts/fetch-pexels-image.js <slug>` (auto-fetches and normalizes to 16:9)
2. Or manually add images to `src/assets/images/posts/<slug>/cover.jpg`

The fallback image (`foseer-default-cover.svg`) IS committed and ready to use.

---

## How It Works

### Image Resolution

The system resolves images in this order:

1. **Explicit frontmatter image** - If `image:` is set in article frontmatter
2. **Slug-based image** - `src/assets/images/posts/<slug>/cover.jpg`
3. **Fallback image** - `src/assets/images/posts/fallback/foseer-default-cover.svg`

### Components Using Image System

- `src/components/blog/GridItem.astro` - Article cards
- `src/components/blog/ListItem.astro` - List items
- `src/components/blog/SinglePost.astro` - Article pages
- `src/pages/article/[slug].astro` - Metadata/OG/Twitter images

All use `src/utils/post-image.ts` for resolution.

### Image Normalization

When fetching via Pexels script:
- Original image is downloaded
- Center-cropped to 16:9 aspect ratio
- Resized to 1600x900 pixels
- Saved as progressive JPEG (85% quality)
- Metadata JSON created with source attribution

---

## Adding Images to New Articles

### Option 1: Run the Content Pipeline (Recommended)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1
```

This automatically:
- Discovers all articles from `src/data/post/`
- Fetches images for articles without them
- Normalizes to 16:9 ratio
- Creates metadata files

### Option 2: Manual (For Control)

1. Create directory: `src/assets/images/posts/<article-slug>/`
2. Add cover image as `cover.jpg` (1600x900, 16:9 ratio recommended)
3. Image is automatically picked up by the system

**Note:** Manual images are NOT auto-normalized. Ensure they are already 16:9 ratio.

### Option 2: Pexels Auto-Fetch (With 16:9 Normalization)

```bash
# Set your Pexels API key
export PEXELS_API_KEY=your_api_key_here

# Fetch image for specific article (auto-crops to 16:9)
node scripts/fetch-pexels-image.js <article-slug>

# Fetch all articles without images
node scripts/fetch-pexels-image.js --all

# Preview what would be fetched (dry run)
node scripts/fetch-pexels-image.js --dry-run

# Force re-fetch existing
node scripts/fetch-pexels-image.js <slug> --force
```

Get your Pexels API key at: https://www.pexels.com/api/

### Option 3: Frontmatter Reference

Add to article frontmatter:

```yaml
---
title: "Article Title"
image: ~/assets/images/posts/<slug>/cover.jpg
---
```

---

## Fallback System

The fallback image (`foseer-default-cover.svg`) is shown when:

- No image is specified in frontmatter
- No slug-based image exists
- Image path is invalid

The fallback is:
- Styled to match Foseer's editorial aesthetic
- SVG format (scales to any size)
- Includes subtle Foseer branding
- Blue gradient with news-style abstract pattern

---

## Image Requirements

| Property | Value |
|----------|-------|
| Ratio | 16:9 (enforced by script) |
| Dimensions | 1600x900 pixels |
| Format | JPG (photos), PNG (graphics), SVG (fallback) |
| Color | Full color, editorial style |
| Content | News-appropriate, no AI mentions |

---

## Source Metadata

When using Pexels, metadata is saved to `image-metadata.json`:

```json
{
  "slug": "article-slug",
  "title": "Article Title",
  "source": {
    "provider": "Pexels",
    "photographer": "Photographer Name",
    "photographerUrl": "https://...",
    "sourcePage": "https://...",
    "originalUrl": "https://...",
    "searchQuery": "search terms"
  },
  "image": {
    "width": 1600,
    "height": 900,
    "aspectRatio": "16:9",
    "format": "jpeg"
  },
  "downloadedAt": "2025-01-08T12:00:00.000Z"
}
```

This preserves attribution information for Pexels license compliance.

**Note:** `image-metadata.json` is created only when using the Pexels fetch script. Manual image additions do not create this file automatically.

---

## Alt Text

Alt text is auto-generated as:

```
Cover image for: {Article Title}
```

This ensures:
- Consistent accessibility
- SEO-friendly descriptions
- No manual alt text required

---

## Metadata/OG Images

Article pages (`src/pages/article/[slug].astro`) use the same resolver for:
- Open Graph images
- Twitter card images
- Social share previews

This ensures the fallback system works consistently across UI and metadata.

---

## Troubleshooting

### Images Not Showing

1. Check image exists at `src/assets/images/posts/<slug>/cover.jpg`
2. Verify image is in `src/` (not `public/`)
3. Restart dev server: `npm run dev`
4. Clear Astro cache: `rm -rf .astro/`

### Build Errors

1. Ensure image format is supported (jpg, png, webp, svg)
2. Check file permissions
3. Verify image is not corrupted

### Pexels Fetch Fails

1. Verify API key: `echo $PEXELS_API_KEY`
2. Check API quota at pexels.com
3. Try different keywords in article metadata

---

## Commands

### Full Pipeline (Recommended)

```powershell
# Run full content pipeline
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1

# Dry run (preview only)
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1 --dry-run

# Images only
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1 --images-only

# Verify only
powershell -ExecutionPolicy Bypass -File .\scripts\run-content-pipeline.ps1 --verify-only
```

### Direct Node.js Scripts

```bash
# Fetch single article image (auto 16:9 crop/resize)
node scripts/fetch-pexels-image.js bitcoin-hits-new-high

# Fetch all articles
node scripts/fetch-pexels-image.js --all

# Run pipeline directly
node scripts/run-content-pipeline.js
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/utils/post-image.ts` | Unified image resolver with fallback |
| `src/assets/images/posts/fallback/foseer-default-cover.svg` | Fallback image |
| `scripts/fetch-pexels-image.js` | Pexels fetch with 16:9 normalization |
| `src/components/blog/GridItem.astro` | Card component |
| `src/components/blog/ListItem.astro` | List component |
| `src/components/blog/SinglePost.astro` | Article page |
| `src/pages/article/[slug].astro` | Article page with metadata |

---

## Best Practices

1. **Use descriptive keywords** - Better Pexels results
2. **Check attribution** - Some photos require credit
3. **Consistent style** - Editorial, news-appropriate images
4. **16:9 ratio enforced** - Script normalizes all fetched images
5. **Local storage** - Always store images locally, never hotlink
6. **Metadata file** - Keep `image-metadata.json` for attribution

---

## What's Committed vs Generated

### Committed to Repository

- `src/utils/post-image.ts` - Image resolver
- `src/assets/images/posts/fallback/foseer-default-cover.svg` - Fallback image
- `scripts/fetch-pexels-image.js` - Pexels fetch script
- `scripts/run-content-pipeline.js` - Pipeline orchestrator (Node.js)
- `scripts/run-content-pipeline.ps1` - PowerShell wrapper
- `docs/IMAGE-SYSTEM.md` - This documentation
- All blog components updated to use resolver

### Generated by Script (NOT in repo by default)

After running the pipeline:

- `src/assets/images/posts/<slug>/cover.jpg` - Normalized 16:9 cover image
- `src/assets/images/posts/<slug>/image-metadata.json` - Source attribution

These files are created per-article and should be committed after generation.

### Current State

**Fallback system:** ✅ Ready to use (committed)
**Article-specific images:** ⚠️ Not yet generated - run pipeline to create

---

## Pipeline Architecture

### Local Pipeline (This Project)

```
┌─────────────────────────────────────────────────────────────┐
│  powershell -ExecutionPolicy Bypass                         │
│    -File .\scripts\run-content-pipeline.ps1                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  scripts/run-content-pipeline.js (Node.js orchestrator)     │
│  1. Discover articles from src/data/post/                   │
│  2. Run draft generation (stub)                             │
│  3. Run AI fill (stub)                                      │
│  4. Run image fetch for each article                        │
│  5. Verify project/build                                    │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Generated Files:                                           │
│  - src/assets/images/posts/<slug>/cover.jpg                 │
│  - src/assets/images/posts/<slug>/image-metadata.json       │
└─────────────────────────────────────────────────────────────┘
```

### Future GitHub Actions Pipeline

The same Node.js orchestrator can be called from GitHub Actions:

```yaml
- name: Run content pipeline
  run: node scripts/run-content-pipeline.js
  env:
    PEXELS_API_KEY: ${{ secrets.PEXELS_API_KEY }}
```

No logic changes needed - the core pipeline is portable.
