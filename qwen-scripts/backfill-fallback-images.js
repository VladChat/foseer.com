// File: qwen-scripts/backfill-fallback-images.js
// Purpose: Safely replace fallback cover images in published posts using best matching already-downloaded local assets.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { resolveProjectRoot } from './utils/project-root.js';
import { loadImageRegistry, saveImageRegistry, recordImageUsage, assetFileExists } from './image-library/registry.js';
import { buildArticleSearchProfile, computeContextualEditorialFit } from './image-library/enrichment.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src', 'data', 'post');
const FALLBACK_IMAGE_PATH = '~/assets/images/posts/fallback/foseer-default-cover.svg';

function parseArgs(argv = []) {
  const options = {
    apply: false,
    limit: 0,
    minScore: 60,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      options.limit = Math.max(0, Number(arg.split('=')[1]) || 0);
      continue;
    }
    if (arg === '--limit') {
      options.limit = Math.max(0, Number(argv[index + 1]) || 0);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-score=')) {
      options.minScore = Math.max(0, Math.min(100, Number(arg.split('=')[1]) || options.minScore));
      continue;
    }
    if (arg === '--min-score') {
      options.minScore = Math.max(0, Math.min(100, Number(argv[index + 1]) || options.minScore));
      index += 1;
    }
  }

  return options;
}

function splitFrontmatter(raw) {
  const match = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  return {
    frontmatterRaw: match[1],
    bodyRaw: match[2],
  };
}

function walkMarkdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
      continue;
    }
    if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toSlugFromCanonicalUrl(value, filePath) {
  const canonical = String(value || '').trim();
  if (canonical.startsWith('/article/')) return canonical.slice('/article/'.length);
  return path.basename(filePath, path.extname(filePath));
}

function collectSourceHints(frontmatter = {}) {
  const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
  return sources
    .map((source) => normalizeText(source?.title))
    .filter(Boolean)
    .slice(0, 8);
}

function collectEntityHints(frontmatter = {}) {
  const hints = [
    ...(Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
    ...(Array.isArray(frontmatter.topics) ? frontmatter.topics : []),
    ...(Array.isArray(frontmatter.entities) ? frontmatter.entities : []),
  ];
  return Array.from(new Set(hints.map((value) => normalizeText(value)).filter(Boolean))).slice(0, 10);
}

function canBackfillArticle(frontmatter = {}) {
  const image = normalizeText(frontmatter.image);
  if (image !== FALLBACK_IMAGE_PATH) return false;
  if (frontmatter.draft === true) return false;
  if (!normalizeText(frontmatter.title)) return false;
  return true;
}

function findBestLocalAsset(article, assets = [], options = {}) {
  const profile = buildArticleSearchProfile({
    title: article.title,
    excerpt: article.excerpt,
    queries: [article.title, article.topicId, article.section].filter(Boolean),
    section: article.section,
    topicId: article.topicId,
    entityHints: article.entityHints,
    sourceHints: article.sourceHints,
    sectionHints: [article.section].filter(Boolean),
    topicHints: [article.topicId].filter(Boolean),
  });

  const minScore = Number(options.minScore || 60);
  let best = null;

  for (const asset of assets) {
    if (!asset || !asset.localPath || !assetFileExists(asset)) continue;
    if (String(asset.provider || '').toLowerCase() === 'fallback') continue;

    const fit = computeContextualEditorialFit(asset, profile);
    const hasAnchor = Number(fit.titleOverlap || 0) >= 1
      || Number(fit.primaryEntityOverlap || 0) >= 1
      || Number(fit.sourceOverlap || 0) >= 2
      || Number(fit.contextOverlap || 0) >= 1
      || Number(fit.geoOverlap || 0) >= 1;

    if (!hasAnchor) continue;
    if (String(fit.tier || 'weak') === 'weak') continue;
    if (Number(fit.finalScore || 0) < minScore) continue;

    const score = (Number(fit.finalScore || 0) * 1000)
      + (Number(fit.confirmationScore || 0) * 10)
      + (Number(fit.primaryEntityOverlap || 0) * 40)
      + (Number(fit.sourceOverlap || 0) * 20)
      + (Number(fit.titleOverlap || 0) * 10)
      - (Number(asset.useCount || 0) * 5);

    if (!best || score > best.score) {
      best = { asset, fit, score };
    }
  }

  return best;
}

function ensureImageLine(frontmatterRaw, key, value, newline) {
  const escapedValue = key === 'imageAlt'
    ? `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : String(value || '');
  const line = `${key}: ${escapedValue}`;
  const regex = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (regex.test(frontmatterRaw)) {
    return frontmatterRaw.replace(regex, line);
  }

  const canonicalRegex = /^canonicalUrl:\s*.*$/m;
  if (canonicalRegex.test(frontmatterRaw)) {
    return frontmatterRaw.replace(canonicalRegex, `${line}${newline}$&`);
  }
  return `${frontmatterRaw}${newline}${line}`;
}

function buildSafeAltText(title) {
  return `Illustration related to ${normalizeText(title) || 'this article'}`;
}

function loadCandidates() {
  const files = walkMarkdownFiles(POSTS_DIR);
  const candidates = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const split = splitFrontmatter(raw);
    if (!split) continue;

    const frontmatter = yaml.load(split.frontmatterRaw) || {};
    if (!canBackfillArticle(frontmatter)) continue;

    candidates.push({
      filePath,
      raw,
      frontmatterRaw: split.frontmatterRaw,
      bodyRaw: split.bodyRaw,
      frontmatter,
      title: normalizeText(frontmatter.title),
      excerpt: normalizeText(frontmatter.excerpt),
      section: normalizeText(frontmatter.section) || 'News',
      topicId: normalizeText(frontmatter.topic_id) || null,
      sourceHints: collectSourceHints(frontmatter),
      entityHints: collectEntityHints(frontmatter),
      slug: toSlugFromCanonicalUrl(frontmatter.canonicalUrl, filePath),
    });
  }

  return candidates;
}

function getPreferredAssets(registry) {
  const allAssets = Array.isArray(registry?.assets) ? registry.assets : [];
  const libraryAssets = allAssets.filter((asset) => String(asset?.localPath || '').startsWith('~/assets/images/library/'));
  return libraryAssets.length > 0 ? libraryAssets : allAssets;
}

function backfillFallbackImages(options = {}) {
  const registry = loadImageRegistry();
  const assets = getPreferredAssets(registry);
  const candidates = loadCandidates();
  const limit = Number(options.limit || 0);
  const targetCandidates = limit > 0 ? candidates.slice(0, limit) : candidates;

  console.log(`[fallback-backfill] mode=${options.apply ? 'apply' : 'dry-run'} candidates=${targetCandidates.length} assets=${assets.length} min_score=${options.minScore}`);

  const results = [];
  let updated = 0;

  for (const candidate of targetCandidates) {
    const best = findBestLocalAsset(candidate, assets, options);
    if (!best) {
      console.log(`[fallback-backfill] skip slug=${candidate.slug} reason=no_strong_local_asset`);
      results.push({
        filePath: candidate.filePath,
        slug: candidate.slug,
        updated: false,
        reason: 'no_strong_local_asset',
      });
      continue;
    }

    console.log(`[fallback-backfill] match slug=${candidate.slug} provider=${best.asset.provider} asset=${best.asset.assetKey} score=${best.fit.finalScore} tier=${best.fit.tier}`);
    if (!options.apply) {
      results.push({
        filePath: candidate.filePath,
        slug: candidate.slug,
        updated: false,
        reason: 'dry_run',
        image: best.asset.localPath,
      });
      continue;
    }

    const newline = candidate.raw.includes('\r\n') ? '\r\n' : '\n';
    let nextFrontmatter = ensureImageLine(candidate.frontmatterRaw, 'image', best.asset.localPath, newline);
    if (!normalizeText(candidate.frontmatter.imageAlt)) {
      nextFrontmatter = ensureImageLine(nextFrontmatter, 'imageAlt', buildSafeAltText(candidate.title), newline);
    }

    const nextRaw = `---${newline}${nextFrontmatter}${newline}---${newline}${candidate.bodyRaw.replace(/^\r?\n/, '')}`;
    fs.writeFileSync(candidate.filePath, nextRaw, 'utf-8');

    recordImageUsage(registry, {
      asset: best.asset,
      articleSlug: candidate.slug,
      articleTitle: candidate.title,
      section: candidate.section,
      topicId: candidate.topicId,
      query: 'backfill:fallback',
      selectionMode: 'fallback_backfill_reuse',
    });

    updated += 1;
    results.push({
      filePath: candidate.filePath,
      slug: candidate.slug,
      updated: true,
      image: best.asset.localPath,
      score: best.fit.finalScore,
    });
  }

  if (options.apply && updated > 0) {
    saveImageRegistry(registry);
  }

  console.log(`[fallback-backfill] completed updated=${updated} scanned=${targetCandidates.length}`);
  return {
    success: true,
    apply: options.apply,
    scanned: targetCandidates.length,
    updated,
    results,
  };
}

const isMainModule = process.argv[1]?.endsWith('backfill-fallback-images.js');

if (isMainModule) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = backfillFallbackImages(options);
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error(`[fallback-backfill] fatal error: ${error.message}`);
    process.exit(1);
  }
}

export { backfillFallbackImages };
