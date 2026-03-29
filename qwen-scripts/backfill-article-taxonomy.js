// File: qwen-scripts/backfill-article-taxonomy.js
// Purpose: Backfill missing section/subsection and canonical taxonomy fields for published posts in the active qwen system.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

import { classifyStory } from './writers/writer-selector.js';
import { resolvePlacementMetadata } from '../qwen-project-governance/shared/article-placement.js';

const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src', 'data', 'post');

function splitFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1], body: match[2] };
}

function dumpFrontmatter(data) {
  return yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
    sortKeys: false,
  }).trim();
}

function getFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...getFiles(full));
      continue;
    }
    if (full.endsWith('.md') || full.endsWith('.mdx')) out.push(full);
  }
  return out;
}

function isRecognizedSection(value) {
  return ['News', 'Business', 'Tech', 'Health', 'Sports', 'Culture'].includes(String(value || '').trim());
}

function shouldApplyDerivedSection(currentSection, resolved) {
  const current = String(currentSection || '').trim();
  if (!current) return true;
  if (!isRecognizedSection(current)) return true;
  if (!resolved?.subsection) return false;
  return current === 'News' && resolved.section && resolved.section !== 'News';
}

function buildClassification(frontmatter, body) {
  return classifyStory(
    {
      title: frontmatter.title || '',
      whatHappened: frontmatter.excerpt || '',
      whyItMatters: '',
      involvedParties: [],
      tags: frontmatter.tags || [],
      articleType: frontmatter.article_type || 'report',
    },
    null,
    { sources: frontmatter.sources || [] }
  );
}

let changed = 0;

for (const filePath of getFiles(POSTS_DIR)) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parts = splitFrontmatter(raw);
  if (!parts) continue;

  const frontmatter = yaml.load(parts.frontmatter) || {};
  const classification = buildClassification(frontmatter, parts.body);
  const sectionInput = (!frontmatter.subsection && (!frontmatter.section || frontmatter.section === 'News' || frontmatter.section === 'Analysis' || frontmatter.section === 'Explainers' || frontmatter.section === 'Editorial Picks'))
    ? classification.section
    : frontmatter.section;

  const resolved = resolvePlacementMetadata({
    title: frontmatter.title,
    excerpt: frontmatter.excerpt,
    content: parts.body,
    section: sectionInput,
    subsection: frontmatter.subsection,
    section_id: frontmatter.section_id,
    topic_id: frontmatter.topic_id,
    article_type: frontmatter.article_type,
    tags: frontmatter.tags,
    topics: frontmatter.topics,
    classification,
    sources: frontmatter.sources,
  });

  let dirty = false;

  if (shouldApplyDerivedSection(frontmatter.section, resolved) && resolved.section && frontmatter.section !== resolved.section) {
    frontmatter.section = resolved.section;
    dirty = true;
  }

  if (!frontmatter.subsection && resolved.subsection) {
    frontmatter.subsection = resolved.subsection;
    dirty = true;
  }

  if (resolved.section_id && frontmatter.section_id !== resolved.section_id) {
    frontmatter.section_id = resolved.section_id;
    dirty = true;
  }

  if (resolved.topic_id && frontmatter.topic_id !== resolved.topic_id) {
    frontmatter.topic_id = resolved.topic_id;
    dirty = true;
  }

  if (dirty) {
    const next = `---\n${dumpFrontmatter(frontmatter)}\n---\n${parts.body.replace(/^\n/, '')}`;
    fs.writeFileSync(filePath, next, 'utf-8');
    changed += 1;
    console.log(`[backfill] updated ${path.relative(PROJECT_ROOT, filePath)}`);
  }
}

console.log(`[backfill] completed. files_changed=${changed}`);
