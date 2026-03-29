// File: qwen-scripts/utils/public-image-paths.js
// Purpose: Derive production-safe public URLs for locally stored article images and mirror files into /public/images.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const SRC_IMAGES_PREFIX = 'src/assets/images/';
const TILDE_IMAGES_PREFIX = '~/assets/images/';
const PUBLIC_IMAGES_PREFIX = '/images/';
const PUBLIC_DIR_PREFIX = 'public/';

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function derivePublicUrlFromFileRelativePath(fileRelativePath) {
  const normalized = normalizeRelativePath(fileRelativePath);
  if (!normalized.startsWith(SRC_IMAGES_PREFIX)) return null;
  return `${PUBLIC_IMAGES_PREFIX}${normalized.slice(SRC_IMAGES_PREFIX.length)}`;
}

export function derivePublicFileRelativePathFromSource(fileRelativePath) {
  const publicUrl = derivePublicUrlFromFileRelativePath(fileRelativePath);
  if (!publicUrl) return null;
  return `${PUBLIC_DIR_PREFIX}${publicUrl.replace(/^\//, '')}`;
}

export function derivePublicUrlFromImagePath(imagePath) {
  const normalized = String(imagePath || '').replace(/\\/g, '/').trim();
  if (!normalized) return null;
  if (normalized.startsWith(PUBLIC_IMAGES_PREFIX)) return normalized;
  if (normalized.startsWith(TILDE_IMAGES_PREFIX)) {
    return `${PUBLIC_IMAGES_PREFIX}${normalized.slice(TILDE_IMAGES_PREFIX.length)}`;
  }
  if (normalized.startsWith(SRC_IMAGES_PREFIX)) {
    return `${PUBLIC_IMAGES_PREFIX}${normalized.slice(SRC_IMAGES_PREFIX.length)}`;
  }
  if (normalized.startsWith('/')) return normalized;
  return null;
}

export function deriveSourceFileRelativePathFromImagePath(imagePath) {
  const normalized = String(imagePath || '').replace(/\\/g, '/').trim();
  if (!normalized) return null;
  if (normalized.startsWith(SRC_IMAGES_PREFIX)) return normalized;
  if (normalized.startsWith(TILDE_IMAGES_PREFIX)) {
    return `${SRC_IMAGES_PREFIX}${normalized.slice(TILDE_IMAGES_PREFIX.length)}`;
  }
  if (normalized.startsWith(PUBLIC_IMAGES_PREFIX)) {
    return `${SRC_IMAGES_PREFIX}${normalized.slice(PUBLIC_IMAGES_PREFIX.length)}`;
  }
  return null;
}

export function ensurePublicImageMirrorFromFileRelativePath(fileRelativePath) {
  const sourceRelativePath = normalizeRelativePath(fileRelativePath);
  const publicRelativePath = derivePublicFileRelativePathFromSource(sourceRelativePath);
  const publicUrl = derivePublicUrlFromFileRelativePath(sourceRelativePath);
  if (!publicRelativePath || !publicUrl) return { publicUrl: null, publicFileRelativePath: null, mirrored: false };

  const sourceAbsolutePath = path.resolve(PROJECT_ROOT, sourceRelativePath);
  if (!fs.existsSync(sourceAbsolutePath)) {
    return { publicUrl: null, publicFileRelativePath: publicRelativePath, mirrored: false };
  }

  const publicAbsolutePath = path.resolve(PROJECT_ROOT, publicRelativePath);
  const publicDir = path.dirname(publicAbsolutePath);
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  let needsCopy = true;
  if (fs.existsSync(publicAbsolutePath)) {
    try {
      const sourceStat = fs.statSync(sourceAbsolutePath);
      const publicStat = fs.statSync(publicAbsolutePath);
      needsCopy = sourceStat.size !== publicStat.size || sourceStat.mtimeMs > publicStat.mtimeMs + 5;
    } catch {
      needsCopy = true;
    }
  }

  if (needsCopy) {
    fs.copyFileSync(sourceAbsolutePath, publicAbsolutePath);
  }

  return { publicUrl, publicFileRelativePath: publicRelativePath, mirrored: true };
}

export function ensurePublicImageMirrorFromImagePath(imagePath) {
  const sourceRelativePath = deriveSourceFileRelativePathFromImagePath(imagePath);
  if (!sourceRelativePath) {
    const publicUrl = derivePublicUrlFromImagePath(imagePath);
    return { publicUrl, publicFileRelativePath: null, mirrored: false };
  }
  return ensurePublicImageMirrorFromFileRelativePath(sourceRelativePath);
}
