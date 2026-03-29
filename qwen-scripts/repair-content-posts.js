// File: qwen-scripts/repair-content-posts.js
// Purpose: Sanitize existing post frontmatter so invalid legacy sources do not break Astro content collection loading.

import fs from 'node:fs';
import path from 'node:path';

const POSTS_DIR = path.resolve(process.cwd(), 'src/data/post');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export function repairContentPosts() {
  if (!fs.existsSync(POSTS_DIR)) {
    return { scanned: 0, changed: 0, removedSources: 0, files: [] };
  }

  const files = walkMarkdownFiles(POSTS_DIR).filter((file) => !file.includes(`${path.sep}_quarantine${path.sep}`));
  let changed = 0;
  let removedSources = 0;
  const changedFiles = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const repaired = repairSingleFile(raw);
    if (!repaired.changed) continue;

    fs.writeFileSync(filePath, repaired.content, 'utf8');
    changed += 1;
    removedSources += repaired.removedSources;
    changedFiles.push(path.relative(process.cwd(), filePath));
    console.log(`[repair-posts] Sanitized ${path.basename(filePath)} removed_sources=${repaired.removedSources}`);
  }

  return { scanned: files.length, changed, removedSources, files: changedFiles };
}

function repairSingleFile(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { changed: false, removedSources: 0, content: raw };

  const frontmatter = match[1];
  const body = raw.slice(match[0].length);
  const lines = frontmatter.split('\n');
  const sourceStart = lines.findIndex((line) => /^sources:\s*$/.test(line));
  if (sourceStart === -1) return { changed: false, removedSources: 0, content: raw };

  let sourceEnd = sourceStart + 1;
  while (sourceEnd < lines.length && (/^  /.test(lines[sourceEnd]) || /^\s*$/.test(lines[sourceEnd]))) {
    sourceEnd += 1;
  }

  const before = lines.slice(0, sourceStart);
  const sourceLines = lines.slice(sourceStart + 1, sourceEnd);
  const after = lines.slice(sourceEnd);

  const parsed = parseSourcesBlock(sourceLines);
  const sanitized = sanitizeSources(parsed.sources);
  const removedSources = parsed.sources.length - sanitized.length;
  if (removedSources <= 0) return { changed: false, removedSources: 0, content: raw };

  const rebuilt = [...before];
  if (sanitized.length > 0) {
    rebuilt.push('sources:');
    for (const source of sanitized) {
      rebuilt.push(`  - title: "${escapeDoubleQuotes(source.title)}"`);
      rebuilt.push(`    url: "${source.url}"`);
    }
  }
  if (after.length > 0) rebuilt.push(...after);

  const next = `---\n${rebuilt.join('\n')}\n---\n${body}`;
  return { changed: true, removedSources, content: next };
}

function parseSourcesBlock(lines) {
  const sources = [];
  let current = null;

  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;

    const itemMatch = line.match(/^  -\s*title:\s*(.*)$/);
    if (itemMatch) {
      if (current) sources.push(current);
      current = { title: stripYamlString(itemMatch[1]), url: '', domain: '' };
      continue;
    }

    if (!current) continue;

    const urlMatch = line.match(/^    url:\s*(.*)$/);
    if (urlMatch) {
      current.url = stripYamlString(urlMatch[1]);
      continue;
    }

    const domainMatch = line.match(/^    domain:\s*(.*)$/);
    if (domainMatch) {
      current.domain = stripYamlString(domainMatch[1]);
    }
  }

  if (current) sources.push(current);
  return { sources };
}

function sanitizeSources(sources) {
  const seen = new Set();
  const sanitized = [];

  for (const source of sources) {
    const url = normalizeUrl(source?.url);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push({
      title: String(source?.title || '').trim() || deriveTitleFromUrl(url),
      url,
    });
  }

  return sanitized;
}

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

function stripYamlString(value) {
  const v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value || value === 'undefined' || value === 'null') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function deriveTitleFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}

function escapeDoubleQuotes(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = repairContentPosts();
  console.log(`[repair-posts] scanned=${result.scanned} changed=${result.changed} removed_sources=${result.removedSources}`);
}
