// File: scripts/ai-fill-draft-posts.js
// Purpose: Fill existing draft posts with AI-generated content (safe, draft-only)

/*
IMPORTANT:
- This script ONLY works on draft posts (draft: true)
- It NEVER publishes content
- AI integration is stubbed and must be connected manually
*/

import fs from 'fs';
import path from 'path';

const POSTS_DIR = path.resolve(process.cwd(), 'src/data/post');

function isDraft(frontmatter) {
  return /draft:\s*true/.test(frontmatter);
}

function extractFrontmatter(content) {
  const match = content.match(/^---[\s\S]*?---/);
  return match ? match[0] : '';
}

function extractBody(content) {
  return content.replace(/^---[\s\S]*?---/, '').trim();
}

// ---- AI STUB (replace later) ----
function generateAIContent(title, topic) {
  return `## Overview

${title} is drawing increasing attention due to recent developments and broader implications.

## What is happening

This section should explain the current situation in clear, neutral terms.

## Why it matters

Here you explain the impact on people, markets, or society.

## What to watch next

List the key signals and developments to monitor.
`;
}
// --------------------------------

const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.mdx'));

for (const file of files) {
  const filePath = path.join(POSTS_DIR, file);
  const raw = fs.readFileSync(filePath, 'utf-8');

  const frontmatter = extractFrontmatter(raw);
  if (!isDraft(frontmatter)) continue;

  const body = extractBody(raw);
  if (body.length > 200) continue; // already filled

  const titleMatch = frontmatter.match(/title:\s*(.+)/);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  const tagMatch = frontmatter.match(/tags:[\s\S]*?-\s*(.+)/);
  const topic = tagMatch ? tagMatch[1].trim() : '';

  const aiContent = generateAIContent(title, topic);

  const updated = `${frontmatter}

${aiContent}
`;

  fs.writeFileSync(filePath, updated, 'utf-8');
  console.log('AI-filled draft:', file);
}
