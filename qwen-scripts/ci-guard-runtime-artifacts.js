// File: qwen-scripts/ci-guard-runtime-artifacts.js
// Purpose: Fail CI when temporary/runtime-only artifacts are tracked or staged for commit.

import { execSync } from 'node:child_process';

const BLOCKED_PATTERNS = [
  /^tmp_run_[^/]+\/.+/i,
  /^\.tmp-[^/]*-logs\/.+/i,
  /^tmp-[^/]*-logs\/.+/i,
  /^qwen-project-governance\/qwen-runtime-reports\/.+/i,
  /^qwen-project-governance\/article-runtime\/run_outputs\/.+/i,
  /^project-governance\/article-runtime\/run_outputs\/.+/i,
  /^qwen-project-governance\/dry_run_artifacts\/.+/i,
  /^project-governance\/dry_run_artifacts\/.+/i,
];

const STAGED_ONLY_BLOCKED_PATTERNS = [
  /^qwen-data\/quality-audits\/.+\.json$/i,
  /^qwen-data\/questions\/.+\.json$/i,
  /^qwen-data\/events\/.+\.json$/i,
  /^qwen-data\/images\/image-registry\.json$/i,
  /^qwen-data\/writer-rotation-state\.json$/i,
];

function gitList(command) {
  try {
    const raw = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return raw.split('\0').map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function findViolations(paths) {
  const unique = Array.from(new Set(paths));
  return unique.filter((path) => BLOCKED_PATTERNS.some((pattern) => pattern.test(path)));
}

const trackedPaths = gitList('git ls-files -z');
const stagedPaths = gitList('git diff --cached --name-only --diff-filter=ACMR -z');

const trackedViolations = findViolations(trackedPaths);
const stagedViolations = findViolations(stagedPaths);
const stagedOnlyViolations = Array.from(new Set(stagedPaths))
  .filter((filePath) => STAGED_ONLY_BLOCKED_PATTERNS.some((pattern) => pattern.test(filePath)));

if (trackedViolations.length === 0 && stagedViolations.length === 0 && stagedOnlyViolations.length === 0) {
  console.log('[guard-runtime-artifacts] OK: no blocked runtime/temp artifacts tracked or staged.');
  process.exit(0);
}

console.error('[guard-runtime-artifacts] BLOCKED: runtime/temp artifacts detected.');

if (trackedViolations.length > 0) {
  console.error('[guard-runtime-artifacts] Tracked violations:');
  for (const filePath of trackedViolations) {
    console.error(`  - ${filePath}`);
  }
}

if (stagedViolations.length > 0) {
  console.error('[guard-runtime-artifacts] Staged violations:');
  for (const filePath of stagedViolations) {
    console.error(`  - ${filePath}`);
  }
}

if (stagedOnlyViolations.length > 0) {
  console.error('[guard-runtime-artifacts] Staged high-churn operational files (not for commit):');
  for (const filePath of stagedOnlyViolations) {
    console.error(`  - ${filePath}`);
  }
}

console.error('[guard-runtime-artifacts] Remove these paths from git tracking/staging before committing.');
process.exit(1);
