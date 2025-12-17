# Draft Post Generator (Step 4)

This script generates **draft blog posts** for each topic defined in:

- `src/data/taxonomy.json`

## What it does
- Creates `.mdx` files in `src/data/post/`
- Sets `draft: true`
- Automatically assigns `tags: [topic-id]`
- Safe to re-run (won't overwrite existing files)

## How to run

```bash
node scripts/generate-draft-posts.js
```

## Next steps
- Replace placeholder content manually **or**
- Connect this script to an AI content generator
