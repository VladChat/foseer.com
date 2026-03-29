// File: qwen-scripts/build-seed-cache.js
// Purpose: Copy fresh runtime cache entries into versioned seed-cache folders so online runs can start warm without committing the whole runtime cache.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TTL_HOURS, RUNTIME_CACHE_ROOT, SEED_CACHE_ROOT } from './utils/cache-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_PACK_RUNTIME_DIR = path.resolve(PROJECT_ROOT, 'qwen-cache/source-packs');
const SOURCE_PACK_SEED_DIR = path.resolve(PROJECT_ROOT, 'qwen-data/cache-seed/source-packs');
const MAX_FILES_PER_BUCKET = Math.max(1, Number(process.env.QWEN_SEED_CACHE_MAX_FILES || 25));
const TTL_MS = DEFAULT_TTL_HOURS * 60 * 60 * 1000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function listFreshJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filePath = path.join(dirPath, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const timestamp = Number(parsed.timestamp || 0);
        const ageMs = Date.now() - timestamp;
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TTL_MS) return null;
        return { file, filePath, timestamp };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.timestamp - left.timestamp);
}

function clearJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith('.json')) {
      fs.unlinkSync(path.join(dirPath, file));
    }
  }
}

function copyFreshEntries(runtimeDir, seedDir, maxFiles = MAX_FILES_PER_BUCKET) {
  ensureDir(seedDir);
  clearJsonFiles(seedDir);
  const freshFiles = listFreshJsonFiles(runtimeDir).slice(0, maxFiles);
  for (const entry of freshFiles) {
    fs.copyFileSync(entry.filePath, path.join(seedDir, entry.file));
  }
  return {
    copied_files: freshFiles.length,
    seed_dir: seedDir,
    runtime_dir: runtimeDir,
  };
}

function writeGitkeep(dirPath) {
  ensureDir(dirPath);
  const gitkeepPath = path.join(dirPath, '.gitkeep');
  if (!fs.existsSync(gitkeepPath)) {
    fs.writeFileSync(gitkeepPath, '', 'utf-8');
  }
}

const providers = ['brave', 'gdelt', 'google'];
const summary = {
  ttl_hours: DEFAULT_TTL_HOURS,
  max_files_per_bucket: MAX_FILES_PER_BUCKET,
  runtime_root: RUNTIME_CACHE_ROOT,
  seed_root: SEED_CACHE_ROOT,
  providers: {},
  source_packs: null,
};

for (const provider of providers) {
  const runtimeDir = path.join(RUNTIME_CACHE_ROOT, provider);
  const seedDir = path.join(SEED_CACHE_ROOT, provider);
  summary.providers[provider] = copyFreshEntries(runtimeDir, seedDir);
  writeGitkeep(seedDir);
}

summary.source_packs = copyFreshEntries(SOURCE_PACK_RUNTIME_DIR, SOURCE_PACK_SEED_DIR);
writeGitkeep(SOURCE_PACK_SEED_DIR);

console.log(JSON.stringify(summary, null, 2));
