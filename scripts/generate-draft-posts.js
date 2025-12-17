// File: scripts/generate-draft-posts.js
// Purpose: Generate draft blog posts from topic taxonomy (manual / AI-ready stub)

import fs from 'fs';
import path from 'path';

const POSTS_DIR = path.resolve(process.cwd(), 'src/data/post');
const TOPICS_PATH = path.resolve(process.cwd(), 'src/data/taxonomy.json');

const taxonomy = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf-8'));

function slugToTitle(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

for (const topic of taxonomy.topics || []) {
  const filename = `${today()}-${topic.id}.mdx`;
  const filePath = path.join(POSTS_DIR, filename);

  if (fs.existsSync(filePath)) continue;

  const content = `---
title: ${slugToTitle(topic.id)}
publishDate: ${today()}
draft: true
tags:
  - ${topic.id}
excerpt: >
  Coverage and analysis on ${slugToTitle(topic.id)}.
---

## ${slugToTitle(topic.id)}

This is a draft placeholder for editorial coverage on **${slugToTitle(topic.id)}**.

- Why this topic matters now
- What is changing
- What to watch next
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('Created draft:', filename);
}
