// File: qwen-scripts/prune-runtime-artifacts.js
// Purpose: Safely prune ignored runtime cache entries and old runtime report directories.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TTL_HOURS, RUNTIME_CACHE_ROOT } from './utils/cache-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RUNTIME_REPORTS_ROOT = path.resolve(PROJECT_ROOT, 'qwen-project-governance', 'qwen-runtime-reports');
const SOURCE_PACK_CACHE_ROOT = path.resolve(RUNTIME_CACHE_ROOT, 'source-packs');
const CACHE_TTL_MS = DEFAULT_TTL_HOURS * 60 * 60 * 1000;
const SOURCE_PACK_TTL_MS = 8 * 60 * 60 * 1000;
const CACHE_PROVIDERS = ['brave', 'gdelt', 'google', 'unsplash', 'pixabay'];
const REPORT_RETENTION_DAYS = Math.max(1, Number(process.env.QWEN_RUNTIME_REPORT_RETENTION_DAYS || 7));
const REPORT_RETENTION_MS = REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RUN_DIR_NAME_RE = /^\d{4}-\d{2}-\d{2}T/;

function toRepoRelative(absolutePath) {
  return path.relative(PROJECT_ROOT, absolutePath).replace(/\\/g, '/');
}

function isInsideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadTrackedPaths() {
  try {
    const raw = execSync('git ls-files -z', { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(raw.split('\0').map((item) => item.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

const trackedPaths = loadTrackedPaths();

function isTrackedFile(absolutePath) {
  return trackedPaths.has(toRepoRelative(absolutePath));
}

function containsTrackedFiles(absoluteDirPath) {
  const prefix = `${toRepoRelative(absoluteDirPath).replace(/\/+$/, '')}/`;
  for (const trackedPath of trackedPaths) {
    if (trackedPath.startsWith(prefix)) return true;
  }
  return false;
}

function pruneCacheDirectory(cacheDirPath, ttlMs) {
  const summary = {
    dir: toRepoRelative(cacheDirPath),
    scanned: 0,
    deleted_expired: 0,
    deleted_corrupt: 0,
    skipped_tracked: 0,
  };

  if (!fs.existsSync(cacheDirPath)) return summary;
  if (!isInsideRoot(PROJECT_ROOT, cacheDirPath)) return summary;

  const entries = fs.readdirSync(cacheDirPath, { withFileTypes: true });
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(cacheDirPath, entry.name);
    summary.scanned += 1;

    if (isTrackedFile(filePath)) {
      summary.skipped_tracked += 1;
      continue;
    }

    let shouldDelete = false;
    let reason = 'expired';

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const timestamp = Number(parsed?.timestamp ?? NaN);
      const ageMs = now - timestamp;
      if (!Number.isFinite(timestamp) || !Number.isFinite(ageMs) || ageMs < 0) {
        shouldDelete = true;
        reason = 'corrupt';
      } else if (ageMs > ttlMs) {
        shouldDelete = true;
        reason = 'expired';
      }
    } catch {
      shouldDelete = true;
      reason = 'corrupt';
    }

    if (!shouldDelete) continue;

    fs.unlinkSync(filePath);
    if (reason === 'corrupt') summary.deleted_corrupt += 1;
    else summary.deleted_expired += 1;
  }

  return summary;
}

function walkDirectories(rootPath) {
  const dirs = [];
  if (!fs.existsSync(rootPath)) return dirs;
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    dirs.push(current);
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push(path.join(current, entry.name));
    }
  }

  return dirs;
}

function pruneRuntimeReports(rootPath) {
  const summary = {
    root: toRepoRelative(rootPath),
    scanned_dirs: 0,
    deleted_dirs: 0,
    skipped_tracked_dirs: 0,
  };

  if (!fs.existsSync(rootPath)) return summary;
  if (!isInsideRoot(PROJECT_ROOT, rootPath)) return summary;

  const now = Date.now();
  const dirs = walkDirectories(rootPath)
    .filter((dirPath) => dirPath !== rootPath)
    .sort((a, b) => b.length - a.length);

  for (const dirPath of dirs) {
    summary.scanned_dirs += 1;
    const relative = toRepoRelative(dirPath);
    const baseName = path.basename(dirPath);
    if (baseName === 'current-run') continue;
    if (!RUN_DIR_NAME_RE.test(baseName)) continue;

    let stat;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs <= REPORT_RETENTION_MS) continue;

    if (containsTrackedFiles(dirPath)) {
      summary.skipped_tracked_dirs += 1;
      continue;
    }

    fs.rmSync(dirPath, { recursive: true, force: true });
    summary.deleted_dirs += 1;
  }

  return summary;
}

function main() {
  const providerSummaries = CACHE_PROVIDERS.map((provider) =>
    pruneCacheDirectory(path.join(RUNTIME_CACHE_ROOT, provider), CACHE_TTL_MS)
  );
  const sourcePackSummary = pruneCacheDirectory(SOURCE_PACK_CACHE_ROOT, SOURCE_PACK_TTL_MS);
  const runtimeReportsSummary = pruneRuntimeReports(RUNTIME_REPORTS_ROOT);

  const summary = {
    cache_ttl_hours: DEFAULT_TTL_HOURS,
    runtime_reports_retention_days: REPORT_RETENTION_DAYS,
    cache_providers: providerSummaries,
    source_pack_cache: sourcePackSummary,
    runtime_reports: runtimeReportsSummary,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
