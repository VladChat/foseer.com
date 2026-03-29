// File: qwen-scripts/utils/project-root.js
// Purpose: Resolve the foseer project root from script location instead of process.cwd().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function hasProjectMarkers(dir) {
  return fs.existsSync(path.join(dir, 'qwen-scripts'))
    && fs.existsSync(path.join(dir, 'src'))
    && fs.existsSync(path.join(dir, 'package.json'));
}

export function resolveProjectRoot(metaUrl = import.meta.url) {
  const startFile = fileURLToPath(metaUrl);
  let current = path.dirname(startFile);

  while (true) {
    if (hasProjectMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve project root from ${startFile}`);
    }
    current = parent;
  }
}
