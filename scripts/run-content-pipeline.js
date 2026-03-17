// File: scripts/run-content-pipeline.js
// Purpose: Unified content pipeline orchestrator for Foseer (local + CI portable)

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadLocalEnv } from './utils/load-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT_DIR, 'src', 'data', 'post');
const IMAGES_DIR = path.join(ROOT_DIR, 'src', 'assets', 'images', 'posts');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const execAsync = promisify(exec);

loadLocalEnv();

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run') || args.includes('-n'),
    imagesOnly: args.includes('--images-only'),
    verifyOnly: args.includes('--verify-only'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function showHelp() {
  console.log(`
🖼️  Foseer Content Pipeline

Usage:
  node scripts/run-content-pipeline.js [options]

Options:
  --dry-run, -n      Show what would run without making changes
  --images-only      Only run image generation for articles
  --verify-only      Only verify project/build health
  --help, -h         Show this help message

Examples:
  node scripts/run-content-pipeline.js --dry-run
  node scripts/run-content-pipeline.js --images-only
  node scripts/run-content-pipeline.js --verify-only
`);
}

async function commandExists(command) {
  try {
    await execAsync(`${command} --version`, { cwd: ROOT_DIR, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function projectDependenciesAvailable() {
  const npmAvailable = await commandExists('npm');
  if (!npmAvailable) {
    return { ok: false, reason: 'npm is not available in this environment' };
  }

  const astroBin = path.join(ROOT_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'astro.cmd' : 'astro');
  try {
    await fs.access(astroBin);
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'project dependencies are not installed (run npm install)' };
  }
}

async function imageDependenciesAvailable() {
  const sharpDir = path.join(ROOT_DIR, 'node_modules', 'sharp');
  try {
    await fs.access(sharpDir);
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'image dependencies are not installed (run npm install)' };
  }
}

async function runScript(scriptName, label, { dryRun = false } = {}) {
  console.log(`\n${label}`);

  if (dryRun) {
    console.log(`[DRY RUN] Would run scripts/${scriptName}`);
    return null;
  }

  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  try {
    const { stdout, stderr } = await execAsync(`node "${scriptPath}"`, { cwd: ROOT_DIR });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log('✓ Completed');
    return true;
  } catch (error) {
    console.error(`✗ ${scriptName} failed: ${error.message}`);
    return false;
  }
}

async function discoverArticles() {
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
      const tags = tagsMatch ? tagsMatch[1].split(',').map((t) => t.trim().replace(/["']/g, '')) : [];
      const categoryMatch = frontmatter.match(/category:\s*(.+)/);
      const category = categoryMatch ? categoryMatch[1].trim() : '';

      articles.push({ slug, title, tags, category, path: filePath, file });
    }

    console.log(`✓ Discovered ${articles.length} articles in src/data/post`);
    return articles;
  } catch (error) {
    console.error(`✗ Error discovering articles: ${error.message}`);
    return [];
  }
}

async function hasGeneratedImage(slug) {
  const coverPath = path.join(IMAGES_DIR, slug, 'cover.jpg');
  try {
    await fs.access(coverPath);
    return true;
  } catch {
    return false;
  }
}

async function runImageFetch(articles, options = {}) {
  const { dryRun = false, force = false } = options;
  console.log('\n📸 Running image generation...');

  const dependencyCheck = await imageDependenciesAvailable();
  if (!dependencyCheck.ok) {
    console.log(`⚠️  Image generation skipped: ${dependencyCheck.reason}`);
    return { success: 0, skipped: 0, failed: 0, skippedReason: dependencyCheck.reason };
  }

  const articlesWithoutImages = [];
  for (const article of articles) {
    const hasImage = await hasGeneratedImage(article.slug);
    if (!hasImage || force) articlesWithoutImages.push(article);
  }

  if (articlesWithoutImages.length === 0) {
    console.log('✓ All articles already have images');
    return { success: 0, skipped: articles.length, failed: 0, skippedReason: '' };
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would fetch images for ${articlesWithoutImages.length} articles:`);
    articlesWithoutImages.forEach((a) => console.log(`  - ${a.slug}`));
    return { success: 0, skipped: 0, failed: 0, skippedReason: '' };
  }

  if (!process.env.PEXELS_API_KEY) {
    console.log('⚠️  PEXELS_API_KEY not set - skipping image fetch');
    console.log('   Articles will use fallback images');
    return { success: 0, skipped: articlesWithoutImages.length, failed: 0, skippedReason: 'PEXELS_API_KEY is not set' };
  }

  let success = 0;
  let failed = 0;
  const scriptPath = path.join(ROOT_DIR, 'scripts', 'fetch-pexels-image.js');

  for (const article of articlesWithoutImages) {
    try {
      const { stdout, stderr } = await execAsync(`node "${scriptPath}" "${article.slug}"`, { cwd: ROOT_DIR });
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
      success++;
    } catch (error) {
      console.error(`✗ Failed to fetch image for ${article.slug}: ${error.message}`);
      failed++;
    }
  }

  return { success, skipped: articles.length - articlesWithoutImages.length, failed, skippedReason: '' };
}

async function verifyProject() {
  console.log('\n🔍 Verifying project health...');

  const results = {
    issues: [],
    buildSkipped: false,
    buildSkipReason: '',
    buildFailed: false,
    buildPassed: false,
  };

  const requiredDirs = [POSTS_DIR, IMAGES_DIR, path.join(IMAGES_DIR, 'fallback')];
  for (const dir of requiredDirs) {
    try {
      await fs.access(dir);
    } catch {
      results.issues.push(`Missing directory: ${dir}`);
    }
  }

  const fallbackPath = path.join(IMAGES_DIR, 'fallback', 'foseer-default-cover.svg');
  try {
    await fs.access(fallbackPath);
    console.log('✓ Fallback image exists');
  } catch {
    results.issues.push('Fallback image missing');
  }

  const articles = await discoverArticles();
  if (articles.length === 0) {
    results.issues.push('No articles found in src/data/post');
  }

  let withImage = 0;
  for (const article of articles) {
    if (await hasGeneratedImage(article.slug)) withImage++;
  }

  const coverage = articles.length > 0 ? Math.round((withImage / articles.length) * 100) : 0;
  console.log(`✓ Image coverage: ${withImage}/${articles.length} (${coverage}%)`);
  console.log(`✓ Fallback will cover ${articles.length - withImage} articles without images`);

  console.log('\n🔨 Running build verification...');
  const dependencyCheck = await projectDependenciesAvailable();
  if (!dependencyCheck.ok) {
    console.log(`⚠️  Build verification SKIPPED: ${dependencyCheck.reason}`);
    results.buildSkipped = true;
    results.buildSkipReason = dependencyCheck.reason;
    return results;
  }

  try {
    const { stdout, stderr } = await execAsync('npm run build', { cwd: ROOT_DIR, timeout: 120000 });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log('✓ Build successful');
    results.buildPassed = true;
  } catch (error) {
    if (error.killed || `${error.message}`.toLowerCase().includes('timeout')) {
      console.log('⚠️  Build verification TIMEOUT: build took too long');
      results.issues.push('Build timeout');
      results.buildFailed = true;
    } else {
      console.log('✗ Build verification FAILED');
      const stdout = error.stdout ? `\n${error.stdout}` : '';
      const stderr = error.stderr ? `\n${error.stderr}` : '';
      results.issues.push(`Build failed: ${error.message}${stdout}${stderr}`.trim());
      results.buildFailed = true;
    }
  }

  return results;
}

function printSummary(results) {
  console.log('\n' + '='.repeat(50));
  console.log('📊 PIPELINE SUMMARY');
  console.log('='.repeat(50));

  if (results.draftGeneration === true) console.log('✓ Draft generation: completed');
  if (results.aiFill === true) console.log('✓ AI fill: completed');
  if (Array.isArray(results.articles)) console.log(`Articles discovered: ${results.articles.length}`);

  if (results.images) {
    console.log(`Images generated: ${results.images.success}`);
    console.log(`Images skipped: ${results.images.skipped}`);
    console.log(`Images failed: ${results.images.failed}`);
    if (results.images.skippedReason) console.log(`Image step note: ${results.images.skippedReason}`);
  }

  if (results.buildSkipped) {
    console.log(`\n⚠️  Build verification: SKIPPED (${results.buildSkipReason || 'dependencies not available'})`);
  } else if (results.buildFailed) {
    console.log('\n✗ Build verification: FAILED');
  } else if (results.buildPassed) {
    console.log('\n✓ Build verification: PASSED');
  }

  if (
    results.issues &&
    results.issues.length === 0 &&
    !results.buildFailed &&
    !results.buildSkipped &&
    !(results.images && results.images.skippedReason)
  ) {
    console.log('\n✅ All checks passed!');
  } else if (results.issues && results.issues.length > 0) {
    console.log('\n⚠️  Issues found:');
    results.issues.forEach((issue) => console.log(`  - ${issue}`));
  }

  console.log('='.repeat(50));
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  console.log('🚀 Foseer Content Pipeline');
  console.log('='.repeat(50));
  if (options.dryRun) console.log('📋 DRY RUN MODE - No changes will be made\n');

  const results = {
    draftGeneration: false,
    aiFill: false,
    images: null,
    articles: [],
    issues: [],
    buildSkipped: false,
    buildSkipReason: '',
    buildFailed: false,
    buildPassed: false,
  };

  if (options.verifyOnly) {
    const verifyResults = await verifyProject();
    results.issues = verifyResults.issues;
    results.buildSkipped = verifyResults.buildSkipped;
    results.buildSkipReason = verifyResults.buildSkipReason || '';
    results.buildFailed = verifyResults.buildFailed;
    results.buildPassed = verifyResults.buildPassed;
    results.articles = await discoverArticles();
    printSummary(results);
    process.exit(results.issues.length > 0 && !results.buildSkipped ? 1 : 0);
  }

  if (!options.imagesOnly) {
    results.draftGeneration = await runScript('generate-draft-posts.js', '📝 Running draft generation...', { dryRun: options.dryRun });
    results.aiFill = await runScript('ai-fill-draft-posts.js', '🤖 Running AI content fill for drafts...', { dryRun: options.dryRun });
  }

  console.log('\n📁 Discovering articles...');
  const articles = await discoverArticles();
  results.articles = articles;

  if (articles.length === 0) {
    console.log('⚠️  No articles found - nothing to process');
    process.exit(0);
  }

  results.images = await runImageFetch(articles, { dryRun: options.dryRun, force: false });

  if (!options.dryRun) {
    const verifyResults = await verifyProject();
    results.issues = verifyResults.issues;
    results.buildSkipped = verifyResults.buildSkipped;
    results.buildSkipReason = verifyResults.buildSkipReason || '';
    results.buildFailed = verifyResults.buildFailed;
    results.buildPassed = verifyResults.buildPassed;
  }

  printSummary(results);

  if (results.issues && results.issues.length > 0 && !results.buildSkipped) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ Pipeline failed:');
  console.error(error);
  process.exit(1);
});
