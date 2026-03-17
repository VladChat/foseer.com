// File: scripts/fetch-pexels-image.js
// Purpose: Fetch relevant cover images from Pexels API and normalize to 16:9 ratio.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { loadLocalEnv } from './utils/load-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT_DIR, 'src', 'data', 'post');
const IMAGES_DIR = path.join(ROOT_DIR, 'src', 'assets', 'images', 'posts');

loadLocalEnv();

const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
const PEXELS_API_BASE = 'https://api.pexels.com/v1';
const TARGET_WIDTH = 1600;
const TARGET_HEIGHT = 900;
const ASPECT_RATIO = 16 / 9;

async function discoverArticlesFromPosts() {
  const articles = [];

  try {
    const files = await fs.readdir(POSTS_DIR);
    const markdownFiles = files.filter((f) => f.endsWith('.mdx') || f.endsWith('.md'));

    for (const file of markdownFiles) {
      const filePath = path.join(POSTS_DIR, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatterMatch) continue;

      const frontmatter = frontmatterMatch[1];
      const slug = file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.(mdx|md)$/, '');
      const titleMatch = frontmatter.match(/title:\s*["']?(.+?)["']?\s*$/m);
      const title = titleMatch ? titleMatch[1].trim() : slug;
      const tagsMatch = frontmatter.match(/tags:\s*\[(.+?)\]/);
      const tags = tagsMatch
        ? tagsMatch[1].split(',').map((t) => t.trim().replace(/["']/g, ''))
        : [];
      const categoryMatch = frontmatter.match(/category:\s*(.+)/);
      const category = categoryMatch ? categoryMatch[1].trim() : '';

      const keywords = [...tags];
      if (category && !keywords.includes(category)) keywords.push(category);
      keywords.push('news', 'current events');

      articles.push({ slug, title, keywords });
    }

    console.log(`✓ Discovered ${articles.length} articles from src/data/post`);
    return articles;
  } catch (error) {
    console.error(`✗ Error discovering articles: ${error.message}`);
    return [];
  }
}

async function searchPexels(query, perPage = 5) {
  if (!PEXELS_API_KEY) {
    console.error('⚠️  PEXELS_API_KEY not set. Using demo mode.');
    return null;
  }

  const url = `${PEXELS_API_BASE}/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: PEXELS_API_KEY },
    });

    if (!response.ok) {
      throw new Error(`Pexels API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error searching Pexels: ${error.message}`);
    return null;
  }
}

async function downloadImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    console.error(`Error downloading image: ${error.message}`);
    return null;
  }
}

async function normalizeTo16x9(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;

  if (!originalWidth || !originalHeight) {
    throw new Error('Could not determine image dimensions');
  }

  const originalRatio = originalWidth / originalHeight;
  let cropWidth = originalWidth;
  let cropHeight = originalHeight;

  if (originalRatio > ASPECT_RATIO) {
    cropWidth = Math.floor(originalHeight * ASPECT_RATIO);
  } else if (originalRatio < ASPECT_RATIO) {
    cropHeight = Math.floor(originalWidth / ASPECT_RATIO);
  }

  const left = Math.floor((originalWidth - cropWidth) / 2);
  const top = Math.floor((originalHeight - cropHeight) / 2);

  const processedImage = await sharp(imageBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(TARGET_WIDTH, TARGET_HEIGHT, {
      fit: 'fill',
      kernel: 'lanczos3',
    })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();

  return {
    buffer: processedImage,
    originalDimensions: { width: originalWidth, height: originalHeight },
    croppedDimensions: { width: cropWidth, height: cropHeight },
  };
}

async function processArticle(article, options = {}) {
  const { dryRun = false, force = false } = options;
  const articleDir = path.join(IMAGES_DIR, article.slug);
  const coverPath = path.join(articleDir, 'cover.jpg');
  const metadataPath = path.join(articleDir, 'image-metadata.json');

  try {
    await fs.access(coverPath);
    if (!force) {
      console.log(`✓ ${article.slug}: Cover already exists, skipping`);
      return null;
    }
  } catch {
    // continue
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would fetch image for: ${article.title}`);
    console.log(`  Keywords: ${article.keywords.join(', ')}`);
    console.log(`  Target: ${coverPath} (${TARGET_WIDTH}x${TARGET_HEIGHT})`);
    return null;
  }

  await fs.mkdir(articleDir, { recursive: true });

  const query = article.keywords.join(' ');
  console.log(`🔍 Searching: ${article.title} (${query})`);

  let result = null;
  if (PEXELS_API_KEY) {
    const searchResult = await searchPexels(query);
    if (searchResult && searchResult.photos && searchResult.photos.length > 0) {
      result = searchResult.photos[0];
    }
  }

  if (!result) {
    console.log('  ⚠️  No Pexels result, using fallback');
    return { slug: article.slug, usedFallback: true, message: 'No API key or no results' };
  }

  const imageUrl = result.src.large2x || result.src.large;
  console.log(`  ↓ Downloading: ${result.photographer} / ${imageUrl}`);

  const imageBuffer = await downloadImage(imageUrl);
  if (!imageBuffer) return null;

  console.log(`  ✂️  Cropping and resizing to ${TARGET_WIDTH}x${TARGET_HEIGHT} (16:9)`);

  try {
    const processed = await normalizeTo16x9(imageBuffer);
    console.log(`     Original: ${processed.originalDimensions.width}x${processed.originalDimensions.height}`);
    console.log(`     Cropped:  ${processed.croppedDimensions.width}x${processed.croppedDimensions.height}`);
    await fs.writeFile(coverPath, processed.buffer);
  } catch (error) {
    console.error(`  ✗ Error processing image: ${error.message}`);
    return null;
  }

  const metadata = {
    slug: article.slug,
    title: article.title,
    source: {
      provider: 'Pexels',
      photographer: result.photographer,
      photographerUrl: result.photographer_url,
      sourcePage: result.url,
      originalUrl: imageUrl,
      searchQuery: query,
    },
    image: {
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      aspectRatio: '16:9',
      format: 'jpeg',
    },
    downloadedAt: new Date().toISOString(),
  };

  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`  ✓ Saved: ${coverPath}`);
  console.log(`  ✓ Metadata: ${metadataPath}`);

  return metadata;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run') || args.includes('-n'),
    force: args.includes('--force') || args.includes('-f'),
    all: args.includes('--all') || args.includes('-a'),
  };

  console.log('🖼️  Foseer Pexels Image Fetcher\n');
  console.log(`📐 Output: ${TARGET_WIDTH}x${TARGET_HEIGHT} (16:9 aspect ratio)\n`);

  if (!PEXELS_API_KEY) {
    console.log('⚠️  Set PEXELS_API_KEY environment variable for real image fetching');
    console.log('    Get your key at: https://www.pexels.com/api/\n');
  }

  let articlesToProcess = await discoverArticlesFromPosts();
  if (articlesToProcess.length === 0) {
    console.error('No articles discovered from src/data/post');
    process.exit(1);
  }

  if (args.length > 0 && !args[0].startsWith('-')) {
    const slug = args.find((a) => !a.startsWith('-'));
    if (slug) {
      articlesToProcess = articlesToProcess.filter((a) => a.slug === slug);
      if (articlesToProcess.length === 0) {
        console.error(`Article not found: ${slug}`);
        process.exit(1);
      }
    }
  }

  if (options.dryRun) {
    console.log('📋 DRY RUN MODE - No images will be downloaded\n');
  }

  const results = [];
  for (const article of articlesToProcess) {
    const result = await processArticle(article, options);
    if (result) results.push(result);
  }

  console.log('\n📊 Summary:');
  console.log(`  Processed: ${results.length}`);
  console.log(`  Fallbacks: ${results.filter((r) => r.usedFallback).length}`);
  console.log(`  Downloaded: ${results.filter((r) => !r.usedFallback).length}`);

  if (results.length === 0) {
    console.log('\n💡 Tip: Use --dry-run to preview, or provide article slug to process specific article');
  }
}

main().catch(console.error);
