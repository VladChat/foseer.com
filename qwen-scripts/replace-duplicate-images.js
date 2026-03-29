// File: qwen-scripts/replace-duplicate-images.js
// Purpose: Find duplicate images across articles and replace them with fresh Pexels images.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchPexelsImageCandidates } from './image-library/providers/pexels.js';
import { loadImageRegistry, saveImageRegistry, registerAssetRecord, recordImageUsage, assetFileExists } from './image-library/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.resolve(process.cwd(), 'src/data/post');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

const IMAGE_CONFIG = {
  libraryBase: '~/assets/images/library',
  maxRetriesPerImage: 3,
};

/**
 * Walk through all markdown/mdx files in the posts directory
 */
function walkMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
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

/**
 * Extract image path from frontmatter
 */
function extractImageFromFrontmatter(frontmatter) {
  const match = frontmatter.match(/^image:\s*(.+)$/m);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Extract image alt text from frontmatter
 */
function extractImageAltFromFrontmatter(frontmatter) {
  const match = frontmatter.match(/^imageAlt:\s*(.+)$/m);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Extract article metadata from frontmatter
 */
function extractArticleMetadata(frontmatter) {
  const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?$/m);
  const excerptMatch = frontmatter.match(/^excerpt:\s*["']?(.+?)["']?$/m);
  const sectionMatch = frontmatter.match(/^section:\s*["']?(.+?)["']?$/m);
  
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    excerpt: excerptMatch ? excerptMatch[1].trim() : '',
    section: sectionMatch ? sectionMatch[1].trim() : 'News',
  };
}

/**
 * Scan all articles and find duplicates by image path
 */
function findDuplicateImages() {
  const files = walkMarkdownFiles(POSTS_DIR).filter((file) => !file.includes(`${path.sep}_quarantine${path.sep}`));
  const imageMap = new Map(); // imagePath -> [{ filePath, imageAlt, metadata }]
  
  console.log(`[duplicate-finder] Scanning ${files.length} articles...`);
  
  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const match = raw.match(FRONTMATTER_RE);
    if (!match) continue;
    
    const frontmatter = match[1];
    const imagePath = extractImageFromFrontmatter(frontmatter);
    if (!imagePath) continue;
    
    const articleSlug = path.basename(filePath, path.extname(filePath));
    const metadata = extractArticleMetadata(frontmatter);
    
    if (!imageMap.has(imagePath)) {
      imageMap.set(imagePath, []);
    }
    imageMap.get(imagePath).push({
      filePath,
      articleSlug,
      imageAlt: extractImageAltFromFrontmatter(frontmatter),
      metadata,
    });
  }
  
  // Filter to only duplicates
  const duplicates = new Map();
  for (const [imagePath, articles] of imageMap.entries()) {
    if (articles.length > 1) {
      duplicates.set(imagePath, articles);
      console.log(`[duplicate-finder] Found ${articles.length} articles sharing image: ${imagePath}`);
    }
  }
  
  console.log(`[duplicate-finder] Total duplicate images: ${duplicates.size}`);
  return { duplicates, totalArticles: files.length };
}

/**
 * Generate search query based on article metadata
 */
function buildSearchQuery(metadata, index) {
  const keywords = [
    metadata.section.toLowerCase(),
    'editorial',
    'news',
  ];
  
  // Add topical keywords based on section
  const sectionKeywords = {
    politics: ['government', 'politics', 'capitol', 'diplomacy'],
    tech: ['technology', 'digital', 'innovation', 'software'],
    business: ['business', 'finance', 'market', 'economy'],
    health: ['health', 'medical', 'healthcare', 'wellness'],
    sports: ['sports', 'athletics', 'competition', 'stadium'],
    news: ['news', 'breaking', 'current events'],
  };
  
  const sectionKws = sectionKeywords[metadata.section?.toLowerCase()] || sectionKeywords.news;
  
  // Rotate keywords based on index to get variety
  const keywordIndex = index % sectionKws.length;
  keywords.unshift(sectionKws[keywordIndex]);
  
  return keywords.join(' ');
}

/**
 * Fetch a new image from Pexels for the given article
 */
async function fetchReplacementImage(metadata, pexelsApiKey, index = 0, usedImageIds = new Set()) {
  const query = buildSearchQuery(metadata, index);
  
  try {
    const candidates = await searchPexelsImageCandidates({
      query,
      apiKey: pexelsApiKey,
      perPage: 15,
      orientation: 'landscape',
    });
    
    if (!candidates || candidates.length === 0) {
      console.log(`[pexels] No candidates found for query: "${query}"`);
      return null;
    }
    
    // Filter out already used images and find the best unused one
    for (const candidate of candidates) {
      if (candidate.providerAssetId && !usedImageIds.has(candidate.providerAssetId)) {
        return candidate;
      }
    }
    
    // If all candidates are used, return the first one anyway
    console.log(`[pexels] All ${candidates.length} candidates already used, picking first`);
    return candidates[0];
  } catch (error) {
    console.error(`[pexels] Error fetching image for query "${query}": ${error.message}`);
    return null;
  }
}

/**
 * Persist a new image asset to the library
 */
async function persistNewImageAsset(candidate, section, query) {
  try {
    const crypto = await import('node:crypto');
    const providerSegment = sanitizePathSegment(candidate.provider || 'pexels');
    const folderSegment = deriveAssetFolderName(candidate);
    const extension = normalizeFormat(candidate.format);
    
    const assetDir = path.resolve(process.cwd(), 'src/assets/images/library', providerSegment, folderSegment);
    const fileRelativePath = path.posix.join('src/assets/images/library', providerSegment, folderSegment, `cover.${extension}`);
    const localPath = `${IMAGE_CONFIG.libraryBase}/${providerSegment}/${folderSegment}/cover.${extension}`;
    const metadataRelativePath = path.posix.join('src/assets/images/library', providerSegment, folderSegment, 'metadata.json');
    const localFilePath = path.resolve(process.cwd(), fileRelativePath);
    const metadataFilePath = path.resolve(process.cwd(), metadataRelativePath);
    
    if (!fs.existsSync(assetDir)) {
      fs.mkdirSync(assetDir, { recursive: true });
    }
    
    // Download the image
    if (!fs.existsSync(localFilePath)) {
      const response = await fetch(candidate.sourceDownloadUrl);
      if (!response.ok) {
        console.warn(`[image] Failed to download candidate: ${response.status} ${response.statusText}`);
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localFilePath, buffer);
    }
    
    // Save metadata
    const metadataPayload = {
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId || null,
      sourcePageUrl: candidate.sourcePageUrl || null,
      sourceDownloadUrl: candidate.sourceDownloadUrl || null,
      authorName: candidate.authorName || null,
      authorUrl: candidate.authorUrl || null,
      license: candidate.license || null,
      altText: candidate.altText || null,
      width: candidate.width || null,
      height: candidate.height || null,
      format: extension,
      sectionHint: section || null,
      query: query || null,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metadataFilePath, JSON.stringify(metadataPayload, null, 2), 'utf-8');
    
    return {
      assetKey: candidate.assetKey || `${candidate.provider}:${folderSegment}`,
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId || null,
      sourcePageUrl: candidate.sourcePageUrl || null,
      sourceDownloadUrl: candidate.sourceDownloadUrl || null,
      authorName: candidate.authorName || null,
      authorUrl: candidate.authorUrl || null,
      license: candidate.license || null,
      altText: candidate.altText || null,
      width: candidate.width || 1600,
      height: candidate.height || 900,
      format: extension,
      localPath,
      fileRelativePath,
      metadataRelativePath,
      sectionHints: [section].filter(Boolean),
      queryHistory: [query, candidate.searchQuery].filter(Boolean),
      tags: [],
      firstSeenAt: new Date().toISOString(),
      lastFetchedAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      status: 'ready',
      provenance: 'provider_download',
    };
  } catch (error) {
    console.warn(`[image] Failed to persist provider candidate: ${error.message}`);
    return null;
  }
}

/**
 * Update article frontmatter with new image
 */
function updateArticleImage(filePath, newImagePath, newImageAlt) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    console.warn(`[update] No frontmatter found in ${filePath}`);
    return false;
  }
  
  const frontmatter = match[1];
  const body = raw.slice(match[0].length);
  const lines = frontmatter.split('\n');
  
  let hasImage = false;
  let hasImageAlt = false;
  const updatedLines = lines.map((line) => {
    if (line.trim().startsWith('image:')) {
      hasImage = true;
      return `image: ${newImagePath}`;
    }
    if (line.trim().startsWith('imageAlt:')) {
      hasImageAlt = true;
      return `imageAlt: "${newImageAlt}"`;
    }
    return line;
  });
  
  // Add image lines if they don't exist
  if (!hasImage) {
    updatedLines.push(`image: ${newImagePath}`);
  }
  if (!hasImageAlt) {
    updatedLines.push(`imageAlt: "${newImageAlt}"`);
  }
  
  const newContent = `---\n${updatedLines.join('\n')}\n---\n${body}`;
  fs.writeFileSync(filePath, newContent, 'utf8');
  return true;
}

/**
 * Sanitize path segment for filesystem
 */
function sanitizePathSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'asset';
}

/**
 * Derive asset folder name from candidate
 */
function deriveAssetFolderName(candidate) {
  if (candidate.providerAssetId) {
    return sanitizePathSegment(candidate.providerAssetId);
  }
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(candidate.sourceDownloadUrl || candidate.sourcePageUrl || candidate.altText || 'asset')).digest('hex').slice(0, 16);
}

/**
 * Normalize image format
 */
function normalizeFormat(format) {
  const lowered = String(format || 'jpg').toLowerCase();
  if (lowered === 'jpeg') return 'jpg';
  if (['jpg', 'png', 'webp'].includes(lowered)) return lowered;
  return 'jpg';
}

/**
 * Main function to replace duplicate images
 */
export async function replaceDuplicateImages() {
  const pexelsApiKey = process.env.PEXELS_API_KEY;
  
  if (!pexelsApiKey) {
    console.error('[replace-duplicates] PEXELS_API_KEY environment variable is not set');
    console.error('Please set it and run again: set PEXELS_API_KEY=your_key && npm run qwen:replace-duplicate-images');
    return { success: false, error: 'Missing PEXELS_API_KEY' };
  }
  
  console.log('[replace-duplicates] Starting duplicate image replacement...');
  console.log(`[replace-duplicates] Using Pexels API key: ${pexelsApiKey.slice(0, 4)}...${pexelsApiKey.slice(-4)}`);
  
  // Find all duplicates
  const { duplicates, totalArticles } = findDuplicateImages();
  
  if (duplicates.size === 0) {
    console.log('[replace-duplicates] No duplicate images found. Nothing to replace.');
    return { success: true, replaced: 0, duplicates: 0 };
  }
  
  const registry = loadImageRegistry();
  let replacedCount = 0;
  let failedCount = 0;
  const results = [];
  
  // Process each duplicate group
  for (const [imagePath, articles] of duplicates.entries()) {
    console.log(`\n[replace-duplicates] Processing duplicate image: ${imagePath}`);
    console.log(`  Articles affected: ${articles.length}`);
    
    // Keep the first article with the original image
    // Replace images for the rest
    const articlesToReplace = articles.slice(1);
    
    for (let i = 0; i < articlesToReplace.length; i++) {
      const article = articlesToReplace[i];
      console.log(`\n  Replacing image for: ${article.articleSlug}`);
      
      let newAsset = null;
      let attempts = 0;
      
      // Try to fetch a new image with different queries
      while (!newAsset && attempts < IMAGE_CONFIG.maxRetriesPerImage) {
        const candidate = await fetchReplacementImage(article.metadata, pexelsApiKey, i + attempts);
        
        if (candidate) {
          newAsset = await persistNewImageAsset(candidate, article.metadata.section, buildSearchQuery(article.metadata, i + attempts));
        }
        
        attempts++;
      }
      
      if (!newAsset) {
        console.error(`  ❌ Failed to fetch replacement image after ${IMAGE_CONFIG.maxRetriesPerImage} attempts`);
        failedCount++;
        results.push({
          articleSlug: article.articleSlug,
          success: false,
          reason: 'Failed to fetch replacement',
        });
        continue;
      }
      
      // Register in registry
      const assetRecord = registerAssetRecord(registry, newAsset);
      recordImageUsage(registry, {
        asset: assetRecord,
        articleSlug: article.articleSlug,
        articleTitle: article.metadata.title,
        section: article.metadata.section,
        query: buildSearchQuery(article.metadata, i),
        selectionMode: 'duplicate_replacement',
      });
      
      // Update the article
      const updated = updateArticleImage(article.filePath, newAsset.localPath, newAsset.altText || `Cover image for ${article.metadata.title}`);
      
      if (updated) {
        console.log(`  ✅ Replaced with: ${newAsset.localPath}`);
        replacedCount++;
        results.push({
          articleSlug: article.articleSlug,
          success: true,
          oldImage: imagePath,
          newImage: newAsset.localPath,
        });
      } else {
        console.error(`  ❌ Failed to update article file`);
        failedCount++;
        results.push({
          articleSlug: article.articleSlug,
          success: false,
          reason: 'Failed to update file',
        });
      }
    }
  }
  
  // Save registry
  saveImageRegistry(registry);
  
  console.log('\n[replace-duplicates] === Summary ===');
  console.log(`  Total duplicate images found: ${duplicates.size}`);
  console.log(`  Successfully replaced: ${replacedCount}`);
  console.log(`  Failed: ${failedCount}`);
  
  return {
    success: true,
    replaced: replacedCount,
    failed: failedCount,
    duplicates: duplicates.size,
    results,
  };
}

// Run as CLI - dry run by default
const isMainModule = process.argv[1]?.endsWith('replace-duplicate-images.js');

if (isMainModule) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--force');
  
  if (dryRun) {
    console.log('[replace-duplicates] DRY RUN MODE - Use --force to actually replace images');
    console.log('[replace-duplicates] Scanning for duplicates...\n');
    const { duplicates } = findDuplicateImages();
    console.log('\n[replace-duplicates] === Duplicate Summary ===');
    for (const [imagePath, articles] of duplicates.entries()) {
      console.log(`\n  Image: ${imagePath}`);
      for (const article of articles) {
        console.log(`    - ${article.articleSlug} (${article.metadata.section})`);
      }
    }
    console.log(`\nTotal duplicate images: ${duplicates.size}`);
    console.log('Run with --force to replace duplicates with new Pexels images');
    process.exit(0);
  } else {
    replaceDuplicateImages()
      .then((result) => {
        console.log('\n[replace-duplicates] Done!');
        process.exit(result.success ? 0 : 1);
      })
      .catch((error) => {
        console.error('[replace-duplicates] Fatal error:', error);
        process.exit(1);
      });
  }
}
