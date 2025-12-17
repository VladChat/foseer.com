# AI Draft Filler (Step 5)

This script **fills existing draft posts** with structured content.

## Key rules
- Works ONLY on posts with `draft: true`
- Skips posts that already contain real content
- Safe to run multiple times

## How it works
1. Reads `.mdx` files in `src/data/post`
2. Detects drafts
3. Generates structured sections:
   - Overview
   - What is happening
   - Why it matters
   - What to watch next

## How to run

```bash
node scripts/ai-fill-draft-posts.js
```

## AI integration
Replace `generateAIContent()` with:
- OpenAI
- Claude
- Local LLM
- API pipeline

Keep output **editorial, neutral, non-promotional**.
