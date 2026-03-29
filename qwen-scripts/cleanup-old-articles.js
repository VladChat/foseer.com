// File: qwen-scripts/cleanup-old-articles.js
// Purpose: Remove all articles except the N most recent ones to free up space.

import fs from 'node:fs';
import path from 'node:path';

const POSTS_DIR = path.resolve(process.cwd(), 'src/data/post');
const KEEP_COUNT = parseInt(process.argv[2] || '5', 10);

function walkMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip quarantine folder
      if (entry.name === '_quarantine') continue;
      out.push(...walkMarkdownFiles(full));
      continue;
    }
    if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      out.push({
        path: full,
        name: entry.name,
        mtime: fs.statSync(full).mtime.getTime(),
      });
    }
  }
  return out;
}

function cleanupOldArticles() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error('[cleanup] Posts directory does not exist:', POSTS_DIR);
    return;
  }

  const files = walkMarkdownFiles(POSTS_DIR);
  console.log(`[cleanup] Found ${files.length} articles`);

  // Sort by modification time (newest first)
  files.sort((a, b) => b.mtime - a.mtime);

  // Keep the most recent N files
  const toKeep = files.slice(0, KEEP_COUNT);
  const toDelete = files.slice(KEEP_COUNT);

  console.log(`[cleanup] Keeping ${toKeep.length} most recent articles:`);
  toKeep.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}`));

  console.log(`\n[cleanup] Deleting ${toDelete.length} old articles...`);

  let deletedCount = 0;
  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.path);
      deletedCount++;
      console.log(`  ✓ Deleted: ${file.name}`);
    } catch (error) {
      console.error(`  ✗ Failed to delete ${file.name}: ${error.message}`);
    }
  }

  console.log(`\n[cleanup] Done! Deleted ${deletedCount} articles, kept ${toKeep.length} articles`);
}

cleanupOldArticles();
