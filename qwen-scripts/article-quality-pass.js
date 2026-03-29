// File: qwen-scripts/article-quality-pass.js
// Purpose: Audit and conservatively repair all live articles in src/data/post using canonical qwen taxonomy/tag registries with per-article validation and runtime reporting.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const PROJECT_ROOT = process.cwd();
const POSTS_DIR = path.resolve(PROJECT_ROOT, 'src', 'data', 'post');
const PREVIEW_DIR = path.resolve(PROJECT_ROOT, 'src', 'data', 'preview-post');
const MANIFESTS_DIR = path.resolve(PROJECT_ROOT, 'qwen-data', 'publish-manifests');
const TAXONOMY_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');
const TAG_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'tag-registry.json');
const GOVERNANCE_DIR = path.resolve(PROJECT_ROOT, 'qwen-project-governance');
const CURRENT_CONTEXT_PATH = path.resolve(GOVERNANCE_DIR, 'qwen-current-context.md');
const TASK_QUEUE_PATH = path.resolve(GOVERNANCE_DIR, 'qwen-task-queue.md');
const OPS_LOG_PATH = path.resolve(GOVERNANCE_DIR, 'qwen-operations-log.md');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const IS_DRY_RUN = process.argv.includes('--dry-run');
const RUNTIME_DIR = path.resolve(
  GOVERNANCE_DIR,
  'qwen-runtime-reports',
  'article-quality-pass',
  RUN_ID
);
const PER_ARTICLE_DIR = path.resolve(RUNTIME_DIR, 'per-article');
const BACKUP_DIR = path.resolve(RUNTIME_DIR, 'backups');
const INVENTORY_PATH = path.resolve(RUNTIME_DIR, 'inventory.json');
const FIX_LOG_PATH = path.resolve(RUNTIME_DIR, 'article-fix-log.md');

const ARTICLE_TYPE_SET = new Set(['report', 'analysis', 'explainer']);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DEBUG_ARTIFACT_PATTERNS = [
  /\[pipeline\]/i,
  /PUBLISH_BLOCKED_/i,
  /PROVIDER_STATUS/i,
  /qwen-runtime-reports/i,
  /quality_audit_path/i,
  /source_role_results/i,
  /event_id:\s*evt-/i,
  /\[STAGE\s+\d+\]/i,
];

const GENERIC_SOURCE_TITLE_PATTERNS = [
  /latest updates/i,
  /news at a glance/i,
  /live updates?/i,
  /homepage/i,
  /topic page/i,
  /section page/i,
  /in brief/i,
];

const WEAK_TAG_TEXT = new Set([
  'news',
  'article',
  'update',
  'updates',
  'breaking',
  'coverage',
  'general',
  'misc',
]);

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'by', 'after', 'as', 'is', 'are', 'at', 'from', 'into', 'this', 'that', 'what', 'why', 'how', 'new', 'latest', 'says', 'say', 'over', 'under', 'more', 'less'
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function splitFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;
  return {
    frontmatterRaw: match[1],
    body: match[2],
  };
}

function parseFrontmatter(frontmatterRaw) {
  return yaml.load(frontmatterRaw) || {};
}

function dumpFrontmatter(data) {
  return yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
    sortKeys: false,
  }).trim();
}

function listMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const out = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_quarantine') continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeArrayStrings(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = normalizeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function parseDateSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function slugFromFilePath(filePath) {
  return path.basename(filePath).replace(/\.(md|mdx)$/i, '');
}

function removeDatePrefix(slug) {
  return String(slug || '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function sectionLabelFromId(taxonomy, sectionId) {
  return taxonomy.sectionById?.[sectionId]?.label || sectionId || null;
}

function topicLabelFromId(taxonomy, topicId) {
  return taxonomy.topicById?.[topicId]?.label || topicId || null;
}

function resolveSectionId(taxonomy, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (taxonomy.sectionById?.[raw]) return raw;
  if (taxonomy.legacyMappings?.sections?.[raw]) {
    const mapped = taxonomy.legacyMappings.sections[raw];
    if (taxonomy.sectionById?.[mapped]) return mapped;
  }
  const normalized = normalizeKey(raw);
  for (const section of taxonomy.sections || []) {
    if (normalizeKey(section.id) === normalized || normalizeKey(section.slug) === normalized || normalizeKey(section.label) === normalized) {
      return section.id;
    }
  }
  const aliasTarget = taxonomy.aliases?.sections?.[raw] || taxonomy.aliases?.sections?.[normalized];
  if (aliasTarget && taxonomy.sectionById?.[aliasTarget]) return aliasTarget;
  return null;
}

function buildTopicLookup(taxonomy) {
  const labelMap = new Map();
  for (const topic of taxonomy.topics || []) {
    labelMap.set(normalizeKey(topic.id), topic.id);
    labelMap.set(normalizeKey(topic.slug), topic.id);
    labelMap.set(normalizeKey(topic.label), topic.id);
    for (const alias of topic.aliases || []) {
      labelMap.set(normalizeKey(alias), topic.id);
    }
  }
  for (const [alias, topicId] of Object.entries(taxonomy.aliases?.topics || {})) {
    labelMap.set(normalizeKey(alias), topicId);
  }
  for (const [legacy, topicId] of Object.entries(taxonomy.legacyMappings?.topics || {})) {
    labelMap.set(normalizeKey(legacy), topicId);
  }
  return labelMap;
}

function resolveTopicId(taxonomy, topicLookup, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (taxonomy.topicById?.[raw]) return raw;
  const legacy = taxonomy.legacyMappings?.topics?.[raw];
  if (legacy && taxonomy.topicById?.[legacy]) return legacy;
  const normalized = normalizeKey(raw);
  const fromLookup = topicLookup.get(normalized);
  if (fromLookup && taxonomy.topicById?.[fromLookup]) return fromLookup;
  return null;
}

function buildTagAliasIndex(tagRegistry) {
  const index = new Map();
  for (const tag of Object.values(tagRegistry.bySlug || {})) {
    const keys = new Set([
      normalizeKey(tag.slug),
      normalizeKey(tag.label),
      ...((tag.aliases || []).map((alias) => normalizeKey(alias))),
    ]);
    for (const key of keys) {
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(tag);
    }
  }
  return index;
}

function chooseCanonicalTag(rawTag, tagRegistry, tagAliasIndex, { sectionId, topicId }) {
  const tagText = String(rawTag || '').trim();
  if (!tagText) return null;

  if (tagRegistry.bySlug?.[tagText]) {
    return tagRegistry.bySlug[tagText];
  }

  const normalized = normalizeKey(tagText);
  const candidates = tagAliasIndex.get(normalized) || [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const ranked = [...candidates].sort((a, b) => {
    const scoreA = scoreTagCandidate(a, sectionId, topicId);
    const scoreB = scoreTagCandidate(b, sectionId, topicId);
    return scoreB - scoreA;
  });

  return ranked[0] || null;
}

function scoreTagCandidate(tag, sectionId, topicId) {
  let score = Number(tag.priority || 0) / 10;
  if (topicId && Array.isArray(tag.topic_ids) && tag.topic_ids.includes(topicId)) score += 50;
  if (sectionId && Array.isArray(tag.section_ids) && tag.section_ids.includes(sectionId)) score += 20;
  if (tag.type === 'topic') score += 5;
  if (tag.type === 'theme') score += 2;
  return score;
}

function tagClearlyMismatched(tag, sectionId, topicId) {
  if (!tag) return false;
  const sectionIds = Array.isArray(tag.section_ids) ? tag.section_ids : [];
  const topicIds = Array.isArray(tag.topic_ids) ? tag.topic_ids : [];

  if (tag.type === 'geography' || tag.type === 'format') return false;

  if (tag.type === 'topic' && topicId && topicIds.length > 0 && !topicIds.includes(topicId)) return true;

  if (tag.type === 'theme') {
    if (topicId && topicIds.length > 0 && !topicIds.includes(topicId)) return true;
    if (sectionId && sectionIds.length > 0 && !sectionIds.includes(sectionId)) return true;
    return false;
  }

  if (tag.type === 'entity') {
    if (
      topicId && topicIds.length > 0 && !topicIds.includes(topicId)
      && sectionId && sectionIds.length > 0 && !sectionIds.includes(sectionId)
    ) {
      return true;
    }
    return false;
  }

  if (sectionId && sectionIds.length > 0 && !sectionIds.includes(sectionId)) return true;
  return false;
}

function hasWeakTagText(tagText) {
  const normalized = normalizeKey(tagText);
  if (!normalized) return true;
  if (WEAK_TAG_TEXT.has(normalized)) return true;
  if (normalized.length < 2) return true;
  return false;
}

function tokenize(value) {
  return normalizeKey(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function titleTokenOverlap(left, right) {
  const leftSet = new Set(tokenize(left));
  if (leftSet.size === 0) return 0;
  let overlap = 0;
  for (const token of tokenize(right)) {
    if (leftSet.has(token)) overlap += 1;
  }
  return overlap;
}

function sourceLooksGeneric(title) {
  const text = String(title || '');
  return GENERIC_SOURCE_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

function sourceMatchesTopicAlias(sourceTitle, topicRecord) {
  if (!topicRecord) return false;
  const haystack = normalizeKey(sourceTitle);
  if (!haystack) return false;
  const aliases = [
    topicRecord.label,
    topicRecord.slug,
    topicRecord.id,
    ...(topicRecord.aliases || []),
  ]
    .map((value) => normalizeKey(value))
    .filter(Boolean);

  for (const alias of aliases) {
    if (!alias) continue;
    if (haystack.includes(alias)) return true;
  }
  return false;
}

function topicAliasList(topicRecord) {
  if (!topicRecord) return [];
  return dedupeStrings([
    topicRecord.label,
    topicRecord.slug,
    topicRecord.id,
    ...(topicRecord.aliases || []),
  ])
    .map((value) => normalizeKey(value))
    .filter(Boolean);
}

function countAliasHits(text, aliases) {
  const haystack = normalizeKey(text);
  if (!haystack || aliases.length === 0) return 0;
  let hits = 0;
  for (const alias of aliases) {
    if (!alias) continue;
    if (haystack.includes(alias)) hits += 1;
  }
  return hits;
}

function evaluateTopicSemanticFit({ topicRecord, title, subsection, topics, tags, sources }) {
  if (!topicRecord) {
    return {
      score: 0,
      direct_score: 0,
      title_hits: 0,
      subsection_hits: 0,
      topic_hits: 0,
      tag_hits: 0,
      source_hits: 0,
      confidence: 'low',
      semantically_consistent: false,
    };
  }

  const aliases = topicAliasList(topicRecord);
  const titleHits = countAliasHits(title, aliases);
  const subsectionHits = countAliasHits(subsection, aliases);
  const topicHits = normalizeArrayStrings(topics).reduce(
    (sum, value) => sum + countAliasHits(value, aliases),
    0
  );
  const tagHits = normalizeArrayStrings(tags).reduce(
    (sum, value) => sum + countAliasHits(value, aliases),
    0
  );
  const sourceHits = normalizeArrayStrings(sources).reduce(
    (sum, value) => sum + countAliasHits(value, aliases),
    0
  );

  const directScore = (titleHits * 12) + (sourceHits * 6);
  const score = directScore + (subsectionHits * 5) + (topicHits * 4) + (tagHits * 3);
  const confidence = score >= 24 ? 'high' : score >= 10 ? 'medium' : 'low';
  const semanticallyConsistent = score >= 10 || titleHits > 0 || (topicHits > 0 && sourceHits > 0);

  return {
    score,
    direct_score: directScore,
    title_hits: titleHits,
    subsection_hits: subsectionHits,
    topic_hits: topicHits,
    tag_hits: tagHits,
    source_hits: sourceHits,
    confidence,
    semantically_consistent: semanticallyConsistent,
  };
}

function topicCandidatesFromMetadata({ frontmatter, taxonomy, topicLookup, tagRegistry, tagAliasIndex }) {
  const candidates = new Map();
  const add = (topicId, reason) => {
    if (!topicId) return;
    if (!taxonomy.topicById?.[topicId]) return;
    if (!candidates.has(topicId)) candidates.set(topicId, new Set());
    candidates.get(topicId).add(reason);
  };

  add(resolveTopicId(taxonomy, topicLookup, frontmatter.topic_id), 'frontmatter.topic_id');
  add(resolveTopicId(taxonomy, topicLookup, frontmatter.subsection), 'frontmatter.subsection');

  for (const value of normalizeArrayStrings(frontmatter.topics)) {
    add(resolveTopicId(taxonomy, topicLookup, value), 'frontmatter.topics');
  }

  for (const tagText of normalizeArrayStrings(frontmatter.tags)) {
    const canonicalTag = chooseCanonicalTag(tagText, tagRegistry, tagAliasIndex, { sectionId: null, topicId: null });
    if (canonicalTag?.type === 'topic' && Array.isArray(canonicalTag.topic_ids)) {
      for (const topicId of canonicalTag.topic_ids) {
        add(resolveTopicId(taxonomy, topicLookup, topicId), 'frontmatter.tags(topic)');
      }
    }
  }

  return Array.from(candidates.entries()).map(([topicId, reasons]) => ({
    topic_id: topicId,
    reasons: Array.from(reasons),
  }));
}

function isBrokenImageAlt(altText) {
  const text = String(altText || '').trim();
  if (!text) return true;
  const commaCount = (text.match(/,/g) || []).length;
  if (commaCount >= 8) return true;

  const words = normalizeKey(text).split(' ').filter(Boolean);
  if (words.length === 0) return true;

  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  const maxRepeat = Math.max(...counts.values());
  if (maxRepeat >= 4) return true;
  if (text.length > 260) return true;
  if (/lorem ipsum/i.test(text)) return true;
  if (/illustration for /i.test(text)) return true;
  if (/beautiful|stunning|detailed view|conceptual image|ideal for/i.test(text)) return true;
  return false;
}

function detectDebugArtifacts(body) {
  const lines = String(body || '').split(/\r?\n/);
  const hits = [];
  for (const line of lines) {
    if (DEBUG_ARTIFACT_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.push(line.trim());
    }
  }
  return hits;
}

function cleanBody(body) {
  const lines = String(body || '').split(/\r?\n/);
  const kept = [];
  const removed = [];

  for (const line of lines) {
    if (DEBUG_ARTIFACT_PATTERNS.some((pattern) => pattern.test(line))) {
      removed.push(line);
      continue;
    }
    kept.push(line.replace(/\uFFFD/g, ''));
  }

  const nextBody = kept.join('\n');
  return { body: nextBody, removedLines: removed };
}

function reorderFrontmatter(data) {
  const preferred = [
    'publishDate',
    'updateDate',
    'title',
    'excerpt',
    'description',
    'author',
    'authorTitle',
    'section',
    'article_type',
    'draft',
    'section_id',
    'topic_id',
    'subsection',
    'tags',
    'topics',
    'sources',
    'image',
    'imageAlt',
    'canonicalUrl',
    'category',
    'metadata',
  ];

  const out = {};
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      out[key] = data[key];
    }
  }
  for (const key of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = data[key];
    }
  }
  return out;
}

function buildManifestIndex(manifestsDir) {
  const files = fs.existsSync(manifestsDir)
    ? fs.readdirSync(manifestsDir).filter((name) => name.toLowerCase().endsWith('.json'))
    : [];

  const manifests = [];
  for (const name of files) {
    const full = path.join(manifestsDir, name);
    const parsed = readJson(full, null);
    if (!parsed || typeof parsed !== 'object') continue;
    manifests.push({
      filePath: full,
      fileName: name,
      manifestNameNoExt: name.replace(/\.json$/i, ''),
      data: parsed,
    });
  }
  return manifests;
}

function scoreManifestMatch(manifestEntry, articleSlug, articleFilePath, articleTitle = '') {
  const data = manifestEntry.data || {};
  const expectedUrl = `/article/${articleSlug}`;
  const articleBase = path.basename(articleFilePath).replace(/\.(md|mdx)$/i, '');
  const noDate = removeDatePrefix(articleSlug);
  const articleTitleKey = normalizeKey(articleTitle);
  const manifestTitleKey = normalizeKey(data.title);

  let score = 0;
  if (data.canonical_slug && String(data.canonical_slug) === articleSlug) score += 100;
  if (data.expected_url && String(data.expected_url) === expectedUrl) score += 90;

  const manifestFilePathBase = data.file_path
    ? path.basename(String(data.file_path)).replace(/\.(md|mdx)$/i, '')
    : '';
  if (manifestFilePathBase && manifestFilePathBase === articleBase) score += 80;

  if (data.slug && String(data.slug) === articleSlug) score += 70;
  if (manifestEntry.manifestNameNoExt === articleSlug) score += 60;

  if (data.slug && String(data.slug) === noDate) score += 55;
  if (manifestEntry.manifestNameNoExt === noDate) score += 50;
  if (articleTitleKey && manifestTitleKey && articleTitleKey === manifestTitleKey) score += 65;

  return score;
}

function findMatchingManifest(manifests, articleSlug, articleFilePath, articleTitle = '') {
  let best = null;
  let bestScore = 0;
  for (const manifest of manifests) {
    const score = scoreManifestMatch(manifest, articleSlug, articleFilePath, articleTitle);
    if (score > bestScore) {
      best = manifest;
      bestScore = score;
    }
  }
  if (!best || bestScore <= 0) return null;

  const data = best.data || {};
  const expectedUrl = `/article/${articleSlug}`;
  const articleBase = path.basename(articleFilePath).replace(/\.(md|mdx)$/i, '');
  const noDate = removeDatePrefix(articleSlug);
  const titleMatch = normalizeKey(articleTitle) && normalizeKey(articleTitle) === normalizeKey(data.title);

  const deterministicSignals = {
    canonical_slug_exact: String(data.canonical_slug || '') === articleSlug,
    expected_url_exact: String(data.expected_url || '') === expectedUrl,
    file_path_basename_exact:
      path.basename(String(data.file_path || '')).replace(/\.(md|mdx)$/i, '') === articleBase,
    slug_exact: String(data.slug || '') === articleSlug,
    slug_nodate_plus_title_exact: String(data.slug || '') === noDate && Boolean(titleMatch),
  };

  const deterministic = Object.values(deterministicSignals).some(Boolean);
  const topicId = String(data.topic_id || '').trim();
  const sectionId = String(data.section_id || '').trim();
  const hasTaxonomy = Boolean(topicId && sectionId);

  return {
    ...best,
    match_score: bestScore,
    match_meta: {
      deterministic,
      deterministic_signals: deterministicSignals,
      strong: deterministic && hasTaxonomy,
      has_taxonomy: hasTaxonomy,
    },
  };
}

function collectPreviewDuplicates() {
  const files = listMarkdownFiles(PREVIEW_DIR);
  const byTitle = new Map();
  const bySlug = new Set();

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const split = splitFrontmatter(raw);
    if (!split) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(split.frontmatterRaw);
    } catch {
      continue;
    }

    const title = String(fm.title || '').trim();
    if (title) {
      const key = normalizeKey(title);
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(filePath);
    }

    bySlug.add(slugFromFilePath(filePath));
  }

  return { byTitle, bySlug };
}

function validateArticleState({ filePath, frontmatter, body, taxonomy, tagRegistry, tagAliasIndex, topicLookup }) {
  const errors = [];
  const warnings = [];
  const slug = slugFromFilePath(filePath);
  const expectedCanonical = `/article/${slug}`;

  if (!String(frontmatter.title || '').trim()) errors.push('Missing title');

  const publishDate = parseDateSafe(frontmatter.publishDate);
  if (!publishDate) errors.push('Missing or invalid publishDate');

  const articleType = String(frontmatter.article_type || '').trim().toLowerCase();
  if (!ARTICLE_TYPE_SET.has(articleType)) errors.push('Invalid article_type');

  const sectionId = resolveSectionId(taxonomy, frontmatter.section_id || frontmatter.section);
  if (!sectionId) errors.push('Missing or invalid section_id');

  const topicId = resolveTopicId(taxonomy, topicLookup, frontmatter.topic_id || frontmatter.subsection);
  if (!topicId) errors.push('Missing or invalid topic_id');

  if (sectionId && topicId) {
    const canonicalSection = taxonomy.sectionByTopic?.[topicId] || null;
    if (canonicalSection && canonicalSection !== sectionId) errors.push('section_id does not match topic_id canonical section');
  }

  const canonicalUrl = String(frontmatter.canonicalUrl || '').trim();
  if (!canonicalUrl) {
    errors.push('Missing canonicalUrl');
  } else if (canonicalUrl !== expectedCanonical) {
    errors.push('canonicalUrl mismatch');
  }

  if (!String(frontmatter.image || '').trim()) errors.push('Missing image');
  if (!String(frontmatter.imageAlt || '').trim()) warnings.push('Missing imageAlt');

  const tags = normalizeArrayStrings(frontmatter.tags);
  if (tags.length === 0) warnings.push('Missing tags');

  for (const tagText of tags) {
    const canonicalTag = chooseCanonicalTag(tagText, tagRegistry, tagAliasIndex, { sectionId, topicId });
    if (!canonicalTag) {
      warnings.push(`Non-canonical tag remains: ${tagText}`);
    }
  }

  const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      errors.push('Malformed source item');
      continue;
    }
    if (!String(source.title || '').trim()) errors.push('Source missing title');
    const normalizedUrl = normalizeUrl(source.url);
    if (!normalizedUrl) errors.push('Source missing/invalid URL');
  }

  if (!String(body || '').trim()) errors.push('Empty body');

  return { valid: errors.length === 0, errors, warnings };
}

function ensureTopicSection({
  frontmatter,
  taxonomy,
  topicLookup,
  manifest,
  tagRegistry,
  tagAliasIndex,
}) {
  const attemptedFixes = [];
  const withheldFixes = [];
  const unresolved = [];

  const metadataCandidates = topicCandidatesFromMetadata({
    frontmatter,
    taxonomy,
    topicLookup,
    tagRegistry,
    tagAliasIndex,
  });

  const existingTopicId = resolveTopicId(taxonomy, topicLookup, frontmatter.topic_id);
  const sourceTitles = Array.isArray(frontmatter.sources)
    ? frontmatter.sources.map((source) => String(source?.title || ''))
    : [];

  const semanticContext = {
    title: String(frontmatter.title || ''),
    subsection: String(frontmatter.subsection || ''),
    topics: normalizeArrayStrings(frontmatter.topics),
    tags: normalizeArrayStrings(frontmatter.tags),
    sources: sourceTitles,
  };

  const manifestTopicId = resolveTopicId(taxonomy, topicLookup, manifest?.data?.topic_id);
  const manifestSectionId = resolveSectionId(taxonomy, manifest?.data?.section_id);
  const manifestStrong = Boolean(manifest?.match_meta?.strong);
  const manifestDeterministic = Boolean(manifest?.match_meta?.deterministic);

  const candidates = new Map();
  for (const candidate of metadataCandidates) {
    const topicId = candidate.topic_id;
    if (!candidates.has(topicId)) candidates.set(topicId, new Set());
    for (const reason of candidate.reasons) candidates.get(topicId).add(reason);
  }

  if (manifestTopicId) {
    if (!candidates.has(manifestTopicId)) candidates.set(manifestTopicId, new Set());
    candidates.get(manifestTopicId).add(
      manifestStrong ? 'manifest.topic_id(strong)' : 'manifest.topic_id'
    );
  }

  const scoredCandidates = Array.from(candidates.entries()).map(([topicId, reasons]) => {
    const topicRecord = taxonomy.topicById?.[topicId] || null;
    const semantic = evaluateTopicSemanticFit({
      topicRecord,
      ...semanticContext,
    });
    let score = semantic.score;
    if (topicId === manifestTopicId && manifestStrong) score += 120;
    else if (topicId === manifestTopicId && manifestDeterministic) score += 40;
    if (topicId === existingTopicId) score += 4;

    return {
      topic_id: topicId,
      reasons: Array.from(reasons),
      semantic,
      score,
    };
  });

  scoredCandidates.sort((a, b) => b.score - a.score);
  const best = scoredCandidates[0] || null;
  const bestAlt = scoredCandidates.find((item) => item.topic_id !== manifestTopicId) || null;

  let chosenTopicId = null;
  let placementConfidence = 'low';
  let resolverPath = 'unresolved';

  if (manifestStrong && manifestTopicId) {
    const manifestCandidate = scoredCandidates.find((item) => item.topic_id === manifestTopicId) || null;
    if (
      manifestCandidate
      && manifestCandidate.semantic.direct_score === 0
      && bestAlt
      && bestAlt.semantic.direct_score >= 18
      && bestAlt.semantic.confidence !== 'low'
      && bestAlt.semantic.direct_score >= manifestCandidate.semantic.direct_score + 12
    ) {
      withheldFixes.push(
        `withheld manifest taxonomy override due semantic conflict: manifest=${manifestTopicId}, semantic_candidate=${bestAlt.topic_id}`
      );
      chosenTopicId = bestAlt.topic_id;
      placementConfidence = bestAlt.semantic.confidence;
      resolverPath = 'semantic_override_manifest_conflict';
      unresolved.push('manifest taxonomy conflicted with article semantics; verify manually');
    } else {
      chosenTopicId = manifestTopicId;
      placementConfidence = manifestCandidate?.semantic.confidence === 'low' ? 'high' : manifestCandidate.semantic.confidence;
      resolverPath = 'manifest_strong';
    }
  } else if (best) {
    chosenTopicId = best.topic_id;
    placementConfidence = best.semantic.confidence;
    resolverPath = best.reasons.includes('manifest.topic_id') ? 'manifest_weak_plus_semantic' : 'semantic_metadata';
  }

  if (!chosenTopicId || placementConfidence === 'low') {
    unresolved.push('topic_id unresolved_with_high_confidence');
    if (best && !manifestStrong) {
      withheldFixes.push(
        `withheld topic_id change to ${best.topic_id} (low semantic confidence)`
      );
    }
    const sectionIdCurrent = resolveSectionId(taxonomy, frontmatter.section_id || frontmatter.section);
    return {
      attemptedFixes,
      withheldFixes,
      unresolved,
      topicId: existingTopicId || null,
      sectionId: sectionIdCurrent || null,
      placement_confidence: 'low',
      resolver_path: resolverPath,
      semantic_candidates: scoredCandidates,
    };
  }

  const canonicalSectionId = taxonomy.sectionByTopic?.[chosenTopicId] || null;
  const sectionId = canonicalSectionId || resolveSectionId(taxonomy, frontmatter.section_id || frontmatter.section) || manifestSectionId || null;

  if (!sectionId) unresolved.push('section_id unresolved');
  if (!canonicalSectionId && sectionId) unresolved.push('section_id derived_noncanonical');

  if (String(frontmatter.topic_id || '').trim() !== chosenTopicId) {
    frontmatter.topic_id = chosenTopicId;
    attemptedFixes.push({
      code: 'topic_id_aligned',
      description: `topic_id -> ${chosenTopicId}`,
      kind: 'frontmatter',
      field: 'topic_id',
      expected: chosenTopicId,
    });
  }

  if (sectionId && String(frontmatter.section_id || '').trim() !== sectionId) {
    frontmatter.section_id = sectionId;
    attemptedFixes.push({
      code: 'section_id_aligned',
      description: `section_id -> ${sectionId}`,
      kind: 'frontmatter',
      field: 'section_id',
      expected: sectionId,
    });
  }

  if (sectionId) {
    const sectionLabel = sectionLabelFromId(taxonomy, sectionId);
    if (sectionLabel && String(frontmatter.section || '').trim() !== sectionLabel) {
      frontmatter.section = sectionLabel;
      attemptedFixes.push({
        code: 'section_label_aligned',
        description: `section label aligned -> ${sectionLabel}`,
        kind: 'frontmatter',
        field: 'section',
        expected: sectionLabel,
      });
    }
  }

  const topicLabel = topicLabelFromId(taxonomy, chosenTopicId);
  if (topicLabel && String(frontmatter.subsection || '').trim() !== topicLabel) {
    frontmatter.subsection = topicLabel;
    attemptedFixes.push({
      code: 'subsection_aligned',
      description: `subsection aligned -> ${topicLabel}`,
      kind: 'frontmatter',
      field: 'subsection',
      expected: topicLabel,
    });
  }

  const normalizedTopics = dedupeStrings(normalizeArrayStrings(frontmatter.topics));
  const hasCanonicalTopic = normalizedTopics.some(
    (item) => resolveTopicId(taxonomy, topicLookup, item) === chosenTopicId
  );
  if (!hasCanonicalTopic) {
    const nextTopics = topicLabel ? [topicLabel] : [chosenTopicId];
    frontmatter.topics = nextTopics;
    attemptedFixes.push({
      code: 'topics_aligned',
      description: 'topics aligned to canonical topic',
      kind: 'frontmatter',
      field: 'topics',
      expected: nextTopics,
    });
  } else if (stableJson(normalizedTopics) !== stableJson(frontmatter.topics)) {
    frontmatter.topics = normalizedTopics;
    attemptedFixes.push({
      code: 'topics_deduped',
      description: 'deduped topics',
      kind: 'frontmatter',
      field: 'topics',
      expected: normalizedTopics,
    });
  }

  if (canonicalSectionId && sectionId && canonicalSectionId !== sectionId) {
    unresolved.push('section_id does not match canonical topic mapping');
  }

  return {
    attemptedFixes,
    withheldFixes,
    unresolved,
    topicId: chosenTopicId,
    sectionId,
    placement_confidence: placementConfidence,
    resolver_path: resolverPath,
    semantic_candidates: scoredCandidates,
  };
}

function ensureArticleType(frontmatter, sectionId, taxonomy, manifest) {
  const attemptedFixes = [];
  const current = String(frontmatter.article_type || '').trim().toLowerCase();
  if (ARTICLE_TYPE_SET.has(current)) {
    return { attemptedFixes, value: current };
  }

  const manifestType = String(manifest?.data?.article_type || '').trim().toLowerCase();
  const defaultBySection = taxonomy.writerHints?.defaultArticleTypeBySection?.[sectionId || ''] || 'report';
  const nextType = ARTICLE_TYPE_SET.has(manifestType)
    ? manifestType
    : ARTICLE_TYPE_SET.has(defaultBySection)
      ? defaultBySection
      : 'report';

  frontmatter.article_type = nextType;
  attemptedFixes.push({
    code: 'article_type_aligned',
    description: `article_type -> ${nextType}`,
    kind: 'frontmatter',
    field: 'article_type',
    expected: nextType,
  });
  return { attemptedFixes, value: nextType };
}

function ensureCanonicalUrl(frontmatter, slug) {
  const expected = `/article/${slug}`;
  const current = String(frontmatter.canonicalUrl || '').trim();
  if (current === expected) return { attemptedFixes: [], value: expected };
  frontmatter.canonicalUrl = expected;
  return {
    attemptedFixes: [{
      code: 'canonical_url_aligned',
      description: 'canonicalUrl aligned to route',
      kind: 'frontmatter',
      field: 'canonicalUrl',
      expected,
    }],
    value: expected,
  };
}

function ensureImageAlt(frontmatter, title, manifest) {
  const attemptedFixes = [];
  const withheldFixes = [];
  const unresolved = [];
  const current = String(frontmatter.imageAlt || '').trim();
  if (!isBrokenImageAlt(current)) {
    return { attemptedFixes, withheldFixes, unresolved, value: current };
  }

  const manifestAlt = String(manifest?.data?.image?.alt_text || '').trim();
  const titleText = String(title || '').trim();
  const titleFallback = titleText ? `Image related to: ${titleText}` : '';
  const manifestAltUsable = manifestAlt && !isBrokenImageAlt(manifestAlt);
  const fallback = manifestAltUsable ? manifestAlt : titleFallback;
  if (!fallback.trim()) {
    unresolved.push('imageAlt unresolved');
    withheldFixes.push('withheld imageAlt repair (no deterministic manifest alt or safe fallback)');
    return { attemptedFixes, withheldFixes, unresolved, value: current };
  }
  if (String(fallback).trim() === String(current).trim()) {
    unresolved.push('imageAlt remains low-quality; deterministic replacement unavailable');
    withheldFixes.push('withheld imageAlt repair (manifest/fallback equals current value)');
    return { attemptedFixes, withheldFixes, unresolved, value: current };
  }

  frontmatter.imageAlt = fallback;
  attemptedFixes.push({
    code: 'image_alt_repaired',
    description: manifestAltUsable ? 'imageAlt repaired from manifest' : 'imageAlt repaired with neutral title-based fallback',
    kind: 'frontmatter',
    field: 'imageAlt',
    expected: fallback,
  });
  return { attemptedFixes, withheldFixes, unresolved, value: fallback };
}

function sanitizeTags({
  frontmatter,
  topicId,
  sectionId,
  tagRegistry,
  tagAliasIndex,
  articleType,
  placementConfidence,
}) {
  const attemptedFixes = [];
  const withheldFixes = [];
  const unresolved = [];
  const issues = [];

  const rawTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  if (!Array.isArray(frontmatter.tags) && frontmatter.tags !== undefined) {
    issues.push('tags_not_array');
  }

  const normalizedRaw = normalizeArrayStrings(rawTags);
  const duplicateRaw = [];
  const seenRaw = new Set();
  for (const value of normalizedRaw) {
    const key = normalizeKey(value);
    if (!key) continue;
    if (seenRaw.has(key)) duplicateRaw.push(value);
    seenRaw.add(key);
  }
  if (duplicateRaw.length > 0) issues.push('duplicate_tags');

  if (placementConfidence === 'low' || !topicId || !sectionId) {
    const conservative = dedupeStrings(normalizedRaw).slice(0, 6);
    if (stableJson(conservative) !== stableJson(rawTags)) {
      frontmatter.tags = conservative;
      attemptedFixes.push({
        code: 'tags_conservative_cleanup',
        description: 'deduped/trimmed tags conservatively (placement low confidence)',
        kind: 'frontmatter',
        field: 'tags',
        expected: conservative,
      });
    }
    withheldFixes.push('withheld canonical tag normalization due low placement confidence');
    if (!topicId || !sectionId) unresolved.push('tag normalization withheld: unresolved taxonomy placement');
    return {
      attemptedFixes,
      withheldFixes,
      unresolved,
      issues,
      unknownTags: [],
      weakTags: [],
      duplicateRaw,
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : conservative,
    };
  }

  const canonicalEntries = [];
  const unknownTags = [];
  const weakTags = [];

  for (const raw of normalizedRaw) {
    const canonicalTag = chooseCanonicalTag(raw, tagRegistry, tagAliasIndex, { sectionId, topicId });
    if (!canonicalTag) {
      unknownTags.push(raw);
      if (hasWeakTagText(raw)) weakTags.push(raw);
      continue;
    }

    if (tagClearlyMismatched(canonicalTag, sectionId, topicId)) {
      issues.push(`section_topic_tag_mismatch:${canonicalTag.slug}`);
      continue;
    }

    canonicalEntries.push(canonicalTag);
  }

  const dedupedBySlug = [];
  const seenSlug = new Set();
  for (const tag of canonicalEntries) {
    if (!tag?.slug || seenSlug.has(tag.slug)) continue;
    seenSlug.add(tag.slug);
    dedupedBySlug.push(tag);
  }

  const primaryTopicSlug = topicId ? tagRegistry.topicTagByTopicId?.[topicId] || null : null;
  if (primaryTopicSlug && !seenSlug.has(primaryTopicSlug) && tagRegistry.bySlug?.[primaryTopicSlug]) {
    dedupedBySlug.unshift(tagRegistry.bySlug[primaryTopicSlug]);
    seenSlug.add(primaryTopicSlug);
    attemptedFixes.push({
      code: 'tag_primary_topic_added',
      description: `added canonical primary topic tag: ${tagRegistry.bySlug[primaryTopicSlug].label}`,
      kind: 'frontmatter',
      field: 'tags',
      expected: null,
    });
  }

  if (articleType && articleType !== 'report') {
    const formatTag = Object.values(tagRegistry.bySlug || {}).find(
      (tag) => tag.type === 'format' && normalizeKey(tag.label) === normalizeKey(articleType)
    );
    if (formatTag && !seenSlug.has(formatTag.slug) && dedupedBySlug.length < 2) {
      dedupedBySlug.push(formatTag);
      seenSlug.add(formatTag.slug);
      attemptedFixes.push({
        code: 'tag_format_added',
        description: `added format tag: ${formatTag.label}`,
        kind: 'frontmatter',
        field: 'tags',
        expected: null,
      });
    }
  }

  const sorted = dedupedBySlug
    .map((tag) => ({ tag, priority: Number(tag.priority || 0) }))
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.tag);

  let limited = sorted;
  if (sorted.length > 6) {
    limited = sorted.slice(0, 6);
    attemptedFixes.push({
      code: 'tags_trimmed',
      description: 'trimmed tags to max 6',
      kind: 'frontmatter',
      field: 'tags',
      expected: null,
    });
  }

  const nextLabels = limited.map((tag) => tag.label);
  if (stableJson(nextLabels) !== stableJson(rawTags)) {
    frontmatter.tags = nextLabels;
    attemptedFixes.push({
      code: 'tags_canonicalized',
      description: 'normalized tags to canonical registry labels',
      kind: 'frontmatter',
      field: 'tags',
      expected: nextLabels,
    });
  }

  if (unknownTags.length > 0) issues.push('non_canonical_tags');
  if (weakTags.length > 0) issues.push('weak_useless_tags');
  if (primaryTopicSlug && !limited.some((tag) => tag.slug === primaryTopicSlug)) {
    unresolved.push('primary topic tag missing after normalization');
  }

  for (const attempt of attemptedFixes) {
    if (attempt.field === 'tags' && attempt.expected === null) {
      attempt.expected = nextLabels;
    }
  }

  return {
    attemptedFixes,
    withheldFixes,
    unresolved,
    issues,
    unknownTags,
    weakTags,
    duplicateRaw,
    tags: nextLabels,
  };
}

function sanitizeSources({
  frontmatter,
  articleTitle,
  topicRecord,
  manifest,
}) {
  const attemptedFixes = [];
  const withheldFixes = [];
  const unresolved = [];
  const issues = [];

  const rawSources = frontmatter.sources;
  if (rawSources === undefined) {
    return {
      attemptedFixes,
      withheldFixes,
      unresolved,
      issues,
      normalizedSources: [],
      removed: [],
    };
  }

  if (!Array.isArray(rawSources)) {
    issues.push('malformed_sources');
    delete frontmatter.sources;
    attemptedFixes.push({
      code: 'sources_non_array_removed',
      description: 'removed non-array sources field',
      kind: 'frontmatter',
      field: 'sources',
      expected: null,
    });
    return {
      attemptedFixes,
      withheldFixes,
      unresolved,
      issues,
      normalizedSources: [],
      removed: [{ reason: 'sources field was not an array' }],
    };
  }

  const normalizeSourceSet = (sources, sourceLabel) => {
    const out = [];
    const seen = new Set();
    const removed = [];

    for (const source of sources) {
      if (!source || typeof source !== 'object') {
        removed.push({ reason: `${sourceLabel}: source item is not an object`, source: source ?? null });
        continue;
      }
      const url = normalizeUrl(source.url);
      const title = String(source.title || '').trim();
      if (!url || !title) {
        removed.push({ reason: `${sourceLabel}: invalid source entry`, source });
        continue;
      }
      const key = url.toLowerCase();
      if (seen.has(key)) {
        removed.push({ reason: `${sourceLabel}: duplicate source URL`, source: { ...source, url } });
        continue;
      }
      seen.add(key);
      out.push({
        title,
        url,
        domain: String(source.domain || '').trim() || getHostname(url),
      });
    }

    return { out, removed };
  };

  const normalizedArticle = normalizeSourceSet(rawSources, 'article');
  const manifestPublishReady = Array.isArray(manifest?.data?.source_pack?.publish_ready_sources)
    ? manifest.data.source_pack.publish_ready_sources
    : [];
  const normalizedManifest = normalizeSourceSet(manifestPublishReady, 'manifest.publish_ready_sources');
  const manifestStrong = Boolean(manifest?.match_meta?.strong);

  if (normalizedArticle.removed.length > 0) issues.push('malformed_sources');
  if (normalizedArticle.removed.some((item) => String(item.reason).includes('duplicate'))) issues.push('duplicate_sources');

  let candidateSources = normalizedArticle.out;
  const removed = [...normalizedArticle.removed];

  if (manifestStrong && normalizedManifest.out.length > 0) {
    // Prefer manifest sources as canonical candidates, but allow relevant existing article sources.
    const byUrl = new Map();
    for (const source of normalizedManifest.out) {
      byUrl.set(source.url.toLowerCase(), source);
    }
    for (const source of normalizedArticle.out) {
      const key = source.url.toLowerCase();
      if (!byUrl.has(key)) byUrl.set(key, source);
    }
    candidateSources = Array.from(byUrl.values());
  }

  const scored = candidateSources.map((source) => {
    const overlap = titleTokenOverlap(articleTitle, source.title);
    const topicAliasHit = sourceMatchesTopicAlias(source.title, topicRecord);
    const genericTitle = sourceLooksGeneric(source.title);
    const inManifest = normalizedManifest.out.some((item) => item.url.toLowerCase() === source.url.toLowerCase());
    const explicitOffTopic = /trump|airport|dhs|funding|tsa|real madrid|champions league|caleb wilson|maternal mental health/i.test(source.title);

    let score = 0;
    if (topicAliasHit) score += 6;
    if (overlap > 0) score += (overlap * 3);
    if (inManifest) score += 2;
    if (genericTitle) score -= 2;
    if (explicitOffTopic && overlap === 0 && !topicAliasHit) score -= 6;

    return {
      source,
      overlap,
      topicAliasHit,
      genericTitle,
      inManifest,
      explicitOffTopic,
      score,
    };
  });

  const strongRelevant = scored.filter((item) => {
    if (item.explicitOffTopic) return false;
    if (item.topicAliasHit) return true;
    if (item.overlap >= 2) return true;
    if (item.overlap >= 1 && item.score >= 2) return true;
    if (item.score >= 3) return true;
    return false;
  });
  const mediumRelevant = scored.filter((item) => {
    if (strongRelevant.includes(item)) return false;
    if (item.explicitOffTopic) return false;
    return item.score > 0;
  });
  const weakOrOffTopic = scored.filter((item) => !strongRelevant.includes(item) && !mediumRelevant.includes(item));

  for (const item of weakOrOffTopic) {
    removed.push({
      reason: item.explicitOffTopic
        ? 'removed probable off-topic source based on title mismatch'
        : 'removed weak source with no meaningful title/topic overlap',
      source: item.source,
    });
  }

  let selected = strongRelevant.length > 0 ? strongRelevant : mediumRelevant;
  let finalSources = selected
    .sort((a, b) => b.score - a.score)
    .map((item) => item.source);

  if (finalSources.length > 4) {
    finalSources = finalSources.slice(0, 4);
  }

  if (finalSources.length === 0 && scored.length > 0) {
    // Keep at least one defensible source rather than deleting all.
    const fallback = [...scored].sort((a, b) => b.score - a.score)[0];
    if (fallback) {
      finalSources = [fallback.source];
      withheldFixes.push('withheld full source removal to avoid empty source list');
      unresolved.push('source relevance uncertain; retained top available source conservatively');
    }
  }

  if (weakOrOffTopic.length > 0) {
    issues.push('off_topic_sources');
  }

  if (stableJson(rawSources) !== stableJson(finalSources)) {
    if (finalSources.length > 0) {
      frontmatter.sources = finalSources;
    } else {
      delete frontmatter.sources;
    }
    attemptedFixes.push({
      code: 'sources_normalized',
      description: 'normalized sources list',
      kind: 'frontmatter',
      field: 'sources',
      expected: finalSources.length > 0 ? finalSources : null,
    });
  }

  return {
    attemptedFixes,
    withheldFixes,
    unresolved,
    issues,
    normalizedSources: finalSources,
    removed,
  };
}

function detectInitialIssues({ frontmatter, body, slug, taxonomy, topicLookup, tagRegistry, tagAliasIndex, manifest, duplicateTitleMap, previewDuplicate }) {
  const issues = [];

  const title = String(frontmatter.title || '').trim();
  const publishDate = parseDateSafe(frontmatter.publishDate);
  const articleType = String(frontmatter.article_type || '').trim().toLowerCase();
  const sectionId = resolveSectionId(taxonomy, frontmatter.section_id || frontmatter.section);
  const topicId = resolveTopicId(taxonomy, topicLookup, frontmatter.topic_id || frontmatter.subsection);
  const topicRecord = topicId ? taxonomy.topicById?.[topicId] || null : null;
  const semanticCurrentTopic = evaluateTopicSemanticFit({
    topicRecord,
    title,
    subsection: frontmatter.subsection,
    topics: frontmatter.topics,
    tags: frontmatter.tags,
    sources: Array.isArray(frontmatter.sources) ? frontmatter.sources.map((source) => source?.title) : [],
  });

  if (!title) issues.push('missing_required_frontmatter:title');
  if (!publishDate) issues.push('missing_required_frontmatter:publishDate');

  if (!ARTICLE_TYPE_SET.has(articleType)) issues.push('frontmatter_schema_mismatch:article_type');
  if (!frontmatter.section) issues.push('missing_required_frontmatter:section');
  if (!frontmatter.section_id) issues.push('missing_section_id');
  if (!frontmatter.topic_id) issues.push('missing_topic_id');

  if (!String(frontmatter.canonicalUrl || '').trim()) issues.push('missing_canonicalUrl');
  if (!String(frontmatter.imageAlt || '').trim()) issues.push('missing_imageAlt');
  if (String(frontmatter.imageAlt || '').trim() && isBrokenImageAlt(frontmatter.imageAlt)) {
    issues.push('weak_imageAlt');
  }

  if (!String(body || '').trim()) issues.push('empty_body');

  if (frontmatter.sources !== undefined && !Array.isArray(frontmatter.sources)) {
    issues.push('malformed_sources');
  }

  if (Array.isArray(frontmatter.sources)) {
    const urlSeen = new Set();
    let malformed = false;
    let duplicate = false;
    for (const source of frontmatter.sources) {
      const url = normalizeUrl(source?.url);
      const titleText = String(source?.title || '').trim();
      if (!url || !titleText) malformed = true;
      if (url) {
        const key = url.toLowerCase();
        if (urlSeen.has(key)) duplicate = true;
        urlSeen.add(key);
      }
    }
    if (malformed) issues.push('malformed_sources');
    if (duplicate) issues.push('duplicate_sources');

    if (manifest?.data?.source_pack?.publish_ready_sources) {
      const manifestUrls = new Set(
        manifest.data.source_pack.publish_ready_sources
          .map((source) => normalizeUrl(source?.url))
          .filter(Boolean)
          .map((url) => String(url).toLowerCase())
      );

      const topicRecord = topicId ? taxonomy.topicById?.[topicId] || null : null;
      const hasOffTopic = frontmatter.sources.some((source) => {
        const normalized = normalizeUrl(source?.url);
        if (!normalized) return false;
        const offManifest = manifestUrls.size > 0 && !manifestUrls.has(normalized.toLowerCase());
        const overlap = titleTokenOverlap(frontmatter.title, source?.title || '');
        const topicHit = sourceMatchesTopicAlias(source?.title || '', topicRecord);
        return offManifest && overlap === 0 && !topicHit;
      });

      if (hasOffTopic) issues.push('off_topic_sources');
    }
  }

  const rawTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  if (!Array.isArray(frontmatter.tags) && frontmatter.tags !== undefined) {
    issues.push('frontmatter_schema_mismatch:tags');
  }

  const rawSeen = new Set();
  let duplicateTags = false;
  let nonCanonicalTags = false;
  let weakTags = false;

  for (const rawTag of normalizeArrayStrings(rawTags)) {
    const key = normalizeKey(rawTag);
    if (rawSeen.has(key)) duplicateTags = true;
    rawSeen.add(key);

    const canonical = chooseCanonicalTag(rawTag, tagRegistry, tagAliasIndex, { sectionId, topicId });
    if (!canonical) {
      nonCanonicalTags = true;
      if (hasWeakTagText(rawTag)) weakTags = true;
      continue;
    }

    if (tagClearlyMismatched(canonical, sectionId, topicId)) {
      issues.push('section_topic_tag_mismatch');
    }
  }

  if (duplicateTags) issues.push('duplicate_tags');
  if (nonCanonicalTags) issues.push('non_canonical_tags');
  if (weakTags) issues.push('weak_useless_tags');

  if (topicId && sectionId) {
    const expectedSection = taxonomy.sectionByTopic?.[topicId] || null;
    if (expectedSection && expectedSection !== sectionId) {
      issues.push('section_topic_mismatch');
    }
  }
  if (topicId && semanticCurrentTopic.confidence === 'low') {
    issues.push('semantic_topic_mismatch');
  }

  const manifestTopicId = resolveTopicId(taxonomy, topicLookup, manifest?.data?.topic_id);
  if (manifest?.match_meta?.strong && manifestTopicId && topicId && manifestTopicId !== topicId) {
    issues.push('manifest_taxonomy_conflict');
  }

  const expectedCanonical = `/article/${slug}`;
  if (String(frontmatter.canonicalUrl || '').trim() && String(frontmatter.canonicalUrl).trim() !== expectedCanonical) {
    issues.push('slug_canonical_mismatch');
  }

  if (duplicateTitleMap.has(normalizeKey(title)) && duplicateTitleMap.get(normalizeKey(title)).length > 1) {
    issues.push('duplicate_title_across_live_articles');
  }

  const debugHits = detectDebugArtifacts(body);
  if (debugHits.length > 0) issues.push('visible_internal_debug_service_artifacts');

  if (previewDuplicate.byTitle.has(normalizeKey(title)) || previewDuplicate.bySlug.has(slug)) {
    issues.push('preview_like_live_duplication');
  }

  return dedupeStrings(issues);
}

function writeInventory(inventory) {
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2), 'utf-8');
}

function appendFixLog(text) {
  fs.appendFileSync(FIX_LOG_PATH, `${text}\n`, 'utf-8');
}

function writePerArticleLog(filePath, data) {
  fs.writeFileSync(filePath, data, 'utf-8');
}

function readArticleParsed(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const split = splitFrontmatter(raw);
  if (!split) return { raw, split: null, frontmatter: null, body: null, parseError: 'missing frontmatter block' };
  try {
    const frontmatter = parseFrontmatter(split.frontmatterRaw);
    return { raw, split, frontmatter, body: split.body, parseError: null };
  } catch (error) {
    return { raw, split, frontmatter: null, body: split.body, parseError: String(error?.message || error) };
  }
}

function saveBackupForArticle({ filePath, rawContent }) {
  const rel = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
  const destination = path.resolve(BACKUP_DIR, rel);
  ensureDir(path.dirname(destination));
  fs.writeFileSync(destination, rawContent, 'utf-8');
  return destination;
}

function isAttemptApplied(attempt, persistedFrontmatter) {
  if (!attempt || attempt.kind !== 'frontmatter') return false;
  const field = attempt.field;
  if (!field) return false;
  if (attempt.expected === null) {
    return !Object.prototype.hasOwnProperty.call(persistedFrontmatter, field) || persistedFrontmatter[field] === undefined;
  }
  return stableJson(persistedFrontmatter[field]) === stableJson(attempt.expected);
}

function appendGovernanceLog({ summary }) {
  const timestamp = new Date().toISOString();
  const contextEntry = `\n## Article Quality Pass ${RUN_ID}\n- Timestamp: ${timestamp}\n- Scope: audited and conservatively repaired live articles in \`src/data/post\` only\n- Runtime report: \`qwen-project-governance/qwen-runtime-reports/article-quality-pass/${RUN_ID}/\`\n- Summary: ${summary}\n`;
  fs.appendFileSync(CURRENT_CONTEXT_PATH, contextEntry, 'utf-8');

  const queueEntry = `\n### [${timestamp}] Article Quality Pass (${RUN_ID})\n- Status: done\n- Scope: full auto loop over all live articles in \`src/data/post\`\n- Output: \`qwen-project-governance/qwen-runtime-reports/article-quality-pass/${RUN_ID}/\`\n- Notes: conservative per-article repairs with validation before each write\n`;
  fs.appendFileSync(TASK_QUEUE_PATH, queueEntry, 'utf-8');

  const opsEntry = `\n### [${timestamp}] Article Quality Pass — ${RUN_ID}\n- Status: done\n- Runtime report: \`qwen-project-governance/qwen-runtime-reports/article-quality-pass/${RUN_ID}/\`\n- ${summary}\n`;
  fs.appendFileSync(OPS_LOG_PATH, opsEntry, 'utf-8');
}

function main() {
  ensureDir(RUNTIME_DIR);
  ensureDir(PER_ARTICLE_DIR);
  ensureDir(BACKUP_DIR);

  const taxonomy = readJson(TAXONOMY_REGISTRY_PATH, {});
  const tagRegistry = readJson(TAG_REGISTRY_PATH, {});

  if (!taxonomy || !taxonomy.topics || !taxonomy.sections) {
    throw new Error('Failed to load taxonomy registry');
  }
  if (!tagRegistry || !tagRegistry.bySlug) {
    throw new Error('Failed to load tag registry');
  }

  const topicLookup = buildTopicLookup(taxonomy);
  const tagAliasIndex = buildTagAliasIndex(tagRegistry);
  const manifests = buildManifestIndex(MANIFESTS_DIR);
  const previewDuplicate = collectPreviewDuplicates();

  const articleFiles = listMarkdownFiles(POSTS_DIR);

  const titleMap = new Map();
  for (const filePath of articleFiles) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const split = splitFrontmatter(raw);
    if (!split) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(split.frontmatterRaw);
    } catch {
      continue;
    }
    const titleKey = normalizeKey(fm.title);
    if (!titleKey) continue;
    if (!titleMap.has(titleKey)) titleMap.set(titleKey, []);
    titleMap.get(titleKey).push(filePath);
  }

  const inventory = [];
  const changedArticles = [];
  const unchangedArticles = [];
  const highRiskArticles = [];
  const manualReviewArticles = [];

  fs.writeFileSync(
    FIX_LOG_PATH,
    `# Article Quality Pass\n\n- Run ID: ${RUN_ID}\n- Started at: ${new Date().toISOString()}\n- Mode: ${IS_DRY_RUN ? 'dry-run' : 'write'}\n- Target directory: src/data/post\n\n`,
    'utf-8'
  );

  for (const filePath of articleFiles) {
    const filename = path.basename(filePath);
    const slug = slugFromFilePath(filePath);
    const parsed = readArticleParsed(filePath);
    const split = parsed.split;
    const raw = parsed.raw;
    const articleTitleForMatch = parsed.frontmatter?.title || '';
    const manifest = findMatchingManifest(manifests, slug, filePath, articleTitleForMatch);
    const manifestPath = manifest ? path.relative(PROJECT_ROOT, manifest.filePath).replace(/\\/g, '/') : null;

    const baseRecord = {
      file_path: path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/'),
      filename,
      slug,
      title: null,
      publishDate: null,
      article_type: null,
      section: null,
      section_id: null,
      subsection: null,
      topic_id: null,
      topics: [],
      tags: [],
      author: null,
      authorTitle: null,
      description: null,
      image: null,
      imageAlt: null,
      canonicalUrl: null,
      sources_count: 0,
      matching_publish_manifest_path: manifestPath,
      issue_list: [],
      changed: false,
      attempted_fixes: [],
      applied_fixes: [],
      withheld_fixes: [],
      fixes_applied: [],
      unresolved_items: [],
      high_risk: false,
      manual_review: false,
      backup_path: null,
      manifest_match: manifest
        ? {
          score: manifest.match_score,
          strong: Boolean(manifest.match_meta?.strong),
          deterministic: Boolean(manifest.match_meta?.deterministic),
        }
        : null,
    };

    if (!split) {
      baseRecord.issue_list = ['missing_required_frontmatter:block'];
      baseRecord.manual_review = true;
      baseRecord.high_risk = true;
      manualReviewArticles.push(baseRecord.file_path);
      highRiskArticles.push(baseRecord.file_path);
      inventory.push(baseRecord);

      writePerArticleLog(
        path.resolve(PER_ARTICLE_DIR, `${slug}.md`),
        `# ${slug}\n\n## Original Issues Found\n- Missing frontmatter block\n\n## Exact Fixes Applied\n- None (unsafe to auto-repair missing frontmatter envelope)\n\n## Fields Intentionally Left Unchanged\n- Entire file\n\n## Risks Avoided\n- Avoided fabricating frontmatter and article metadata\n\n## Unresolved Items Requiring Human Review\n- Add valid frontmatter manually\n`
      );
      appendFixLog(`- ${slug}: manual review required (missing frontmatter)`);
      writeInventory(inventory);
      continue;
    }

    let frontmatter = {};
    let parseError = null;
    try {
      frontmatter = parseFrontmatter(split.frontmatterRaw);
    } catch (error) {
      parseError = String(error?.message || error);
    }

    if (parseError) {
      baseRecord.issue_list = ['frontmatter_schema_mismatch:unparseable'];
      baseRecord.manual_review = true;
      baseRecord.high_risk = true;
      manualReviewArticles.push(baseRecord.file_path);
      highRiskArticles.push(baseRecord.file_path);
      inventory.push(baseRecord);

      writePerArticleLog(
        path.resolve(PER_ARTICLE_DIR, `${slug}.md`),
        `# ${slug}\n\n## Original Issues Found\n- Frontmatter parse failed: ${parseError}\n\n## Exact Fixes Applied\n- None (unsafe to auto-repair malformed YAML without deterministic intent)\n\n## Fields Intentionally Left Unchanged\n- Entire file\n\n## Risks Avoided\n- Avoided destructive YAML rewrite on unparseable frontmatter\n\n## Unresolved Items Requiring Human Review\n- Repair frontmatter YAML syntax manually\n`
      );
      appendFixLog(`- ${slug}: manual review required (frontmatter parse failure)`);
      writeInventory(inventory);
      continue;
    }

    const originalFrontmatter = deepClone(frontmatter);
    const originalBody = split.body;

    const initialIssues = detectInitialIssues({
      frontmatter,
      body: split.body,
      slug,
      taxonomy,
      topicLookup,
      tagRegistry,
      tagAliasIndex,
      manifest,
      duplicateTitleMap: titleMap,
      previewDuplicate,
    });

    baseRecord.title = String(frontmatter.title || '').trim() || null;
    baseRecord.publishDate = frontmatter.publishDate || null;
    baseRecord.article_type = frontmatter.article_type || null;
    baseRecord.section = frontmatter.section || null;
    baseRecord.section_id = frontmatter.section_id || null;
    baseRecord.subsection = frontmatter.subsection || null;
    baseRecord.topic_id = frontmatter.topic_id || null;
    baseRecord.topics = Array.isArray(frontmatter.topics) ? frontmatter.topics : [];
    baseRecord.tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    baseRecord.author = frontmatter.author || null;
    baseRecord.authorTitle = frontmatter.authorTitle || null;
    baseRecord.description = frontmatter.description || frontmatter.excerpt || null;
    baseRecord.image = frontmatter.image || null;
    baseRecord.imageAlt = frontmatter.imageAlt || null;
    baseRecord.canonicalUrl = frontmatter.canonicalUrl || null;
    baseRecord.sources_count = Array.isArray(frontmatter.sources) ? frontmatter.sources.length : 0;
    baseRecord.issue_list = initialIssues;

    const attemptedFixes = [];
    const appliedFixes = [];
    const withheldFixes = [];
    const unresolved = [];
    let persistedFrontmatterForRecord = deepClone(originalFrontmatter);

    const placementRepair = ensureTopicSection({
      frontmatter,
      taxonomy,
      topicLookup,
      manifest,
      tagRegistry,
      tagAliasIndex,
    });
    attemptedFixes.push(...placementRepair.attemptedFixes);
    withheldFixes.push(...placementRepair.withheldFixes);
    unresolved.push(...placementRepair.unresolved);

    const articleTypeRepair = ensureArticleType(frontmatter, placementRepair.sectionId, taxonomy, manifest);
    attemptedFixes.push(...articleTypeRepair.attemptedFixes);

    const canonicalRepair = ensureCanonicalUrl(frontmatter, slug);
    attemptedFixes.push(...canonicalRepair.attemptedFixes);

    const topicRecord = placementRepair.topicId ? taxonomy.topicById?.[placementRepair.topicId] || null : null;

    const sourceRepair = sanitizeSources({
      frontmatter,
      articleTitle: String(frontmatter.title || ''),
      topicRecord,
      manifest,
    });
    attemptedFixes.push(...sourceRepair.attemptedFixes);
    withheldFixes.push(...sourceRepair.withheldFixes);
    unresolved.push(...sourceRepair.unresolved);

    const tagRepair = sanitizeTags({
      frontmatter,
      topicId: placementRepair.topicId,
      sectionId: placementRepair.sectionId,
      tagRegistry,
      tagAliasIndex,
      articleType: String(frontmatter.article_type || '').toLowerCase(),
      placementConfidence: placementRepair.placement_confidence,
    });
    attemptedFixes.push(...tagRepair.attemptedFixes);
    withheldFixes.push(...tagRepair.withheldFixes);
    unresolved.push(...tagRepair.unresolved);

    const imageAltRepair = ensureImageAlt(frontmatter, frontmatter.title, manifest);
    attemptedFixes.push(...imageAltRepair.attemptedFixes);
    withheldFixes.push(...imageAltRepair.withheldFixes);
    unresolved.push(...imageAltRepair.unresolved);

    const bodyRepair = cleanBody(split.body);
    if (bodyRepair.removedLines.length > 0) {
      attemptedFixes.push({
        code: 'body_debug_artifacts_removed',
        description: `removed ${bodyRepair.removedLines.length} debug/service artifact line(s) from body`,
        kind: 'body',
        expected: bodyRepair.body,
      });
    }

    frontmatter = reorderFrontmatter(frontmatter);

    const nextContent = `---\n${dumpFrontmatter(frontmatter)}\n---\n${bodyRepair.body.replace(/^\n+/, '')}`;

    const validation = validateArticleState({
      filePath,
      frontmatter,
      body: bodyRepair.body,
      taxonomy,
      tagRegistry,
      tagAliasIndex,
      topicLookup,
    });

    if (!validation.valid) {
      unresolved.push(...validation.errors);
    }

    const frontmatterChanged = stableJson(frontmatter) !== stableJson(originalFrontmatter);
    const bodyChanged = bodyRepair.body !== originalBody;
    const contentChanged = nextContent !== raw;
    const shouldWrite = !IS_DRY_RUN && validation.valid && contentChanged;

    if (shouldWrite) {
      const backupPath = saveBackupForArticle({ filePath, rawContent: raw });
      baseRecord.backup_path = path.relative(PROJECT_ROOT, backupPath).replace(/\\/g, '/');
      fs.writeFileSync(filePath, nextContent, 'utf-8');

      const persisted = readArticleParsed(filePath);
      if (persisted.parseError || !persisted.frontmatter) {
        unresolved.push('post_write_parse_failed');
      } else {
        persistedFrontmatterForRecord = deepClone(persisted.frontmatter);
        const postValidation = validateArticleState({
          filePath,
          frontmatter: persisted.frontmatter,
          body: persisted.body,
          taxonomy,
          tagRegistry,
          tagAliasIndex,
          topicLookup,
        });
        if (!postValidation.valid) {
          unresolved.push(...postValidation.errors.map((error) => `post_write:${error}`));
        }

        for (const attempt of attemptedFixes) {
          if (attempt.kind === 'body') {
            if (persisted.body === attempt.expected) appliedFixes.push(attempt.description);
            else withheldFixes.push(`withheld after post-write verification: ${attempt.description}`);
            continue;
          }
          if (isAttemptApplied(attempt, persisted.frontmatter)) {
            appliedFixes.push(attempt.description);
          } else {
            withheldFixes.push(`withheld after post-write verification: ${attempt.description}`);
          }
        }

        if (imageAltRepair?.value && persisted.frontmatter.imageAlt !== imageAltRepair.value) {
          withheldFixes.push('withheld imageAlt repair: persisted value did not match expected post-write');
        }
      }
    } else {
      if (contentChanged && IS_DRY_RUN) {
        withheldFixes.push('write withheld in dry-run mode');
      } else if (contentChanged && !validation.valid) {
        withheldFixes.push('write withheld due validation failure');
      }

      for (const attempt of attemptedFixes) {
        withheldFixes.push(`not applied: ${attempt.description}`);
      }
    }

    baseRecord.changed = shouldWrite && unresolved.filter((item) => item.startsWith('post_write:')).length === 0;
    if (baseRecord.changed) changedArticles.push(baseRecord.file_path);
    else unchangedArticles.push(baseRecord.file_path);

    baseRecord.title = String(persistedFrontmatterForRecord.title || '').trim() || null;
    baseRecord.publishDate = persistedFrontmatterForRecord.publishDate || null;
    baseRecord.article_type = persistedFrontmatterForRecord.article_type || null;
    baseRecord.section = persistedFrontmatterForRecord.section || null;
    baseRecord.section_id = persistedFrontmatterForRecord.section_id || null;
    baseRecord.subsection = persistedFrontmatterForRecord.subsection || null;
    baseRecord.topic_id = persistedFrontmatterForRecord.topic_id || null;
    baseRecord.topics = Array.isArray(persistedFrontmatterForRecord.topics) ? persistedFrontmatterForRecord.topics : [];
    baseRecord.tags = Array.isArray(persistedFrontmatterForRecord.tags) ? persistedFrontmatterForRecord.tags : [];
    baseRecord.author = persistedFrontmatterForRecord.author || null;
    baseRecord.authorTitle = persistedFrontmatterForRecord.authorTitle || null;
    baseRecord.description = persistedFrontmatterForRecord.description || persistedFrontmatterForRecord.excerpt || null;
    baseRecord.image = persistedFrontmatterForRecord.image || null;
    baseRecord.imageAlt = persistedFrontmatterForRecord.imageAlt || null;
    baseRecord.canonicalUrl = persistedFrontmatterForRecord.canonicalUrl || null;
    baseRecord.sources_count = Array.isArray(persistedFrontmatterForRecord.sources) ? persistedFrontmatterForRecord.sources.length : 0;

    if (
      !validation.valid
      || unresolved.length > 0
      || initialIssues.includes('duplicate_title_across_live_articles')
      || placementRepair.placement_confidence === 'low'
    ) {
      baseRecord.manual_review = true;
      manualReviewArticles.push(baseRecord.file_path);
    }

    const highRiskSignals = [
      'frontmatter_schema_mismatch:unparseable',
      'missing_required_frontmatter:block',
      'section_topic_mismatch',
      'off_topic_sources',
      'visible_internal_debug_service_artifacts',
      'preview_like_live_duplication',
      'semantic_topic_mismatch',
      'manifest_taxonomy_conflict',
    ];
    if (initialIssues.some((issue) => highRiskSignals.some((signal) => issue.startsWith(signal))) || !validation.valid) {
      baseRecord.high_risk = true;
      highRiskArticles.push(baseRecord.file_path);
    }

    baseRecord.attempted_fixes = dedupeStrings(attemptedFixes.map((item) => item.description));
    baseRecord.applied_fixes = dedupeStrings(appliedFixes);
    baseRecord.withheld_fixes = dedupeStrings(withheldFixes);
    baseRecord.fixes_applied = baseRecord.applied_fixes;
    baseRecord.unresolved_items = dedupeStrings(unresolved);

    const perArticleLogPath = path.resolve(PER_ARTICLE_DIR, `${slug}.md`);
    const intentionallyUnchanged = [];
    if (!frontmatterChanged) intentionallyUnchanged.push('frontmatter kept as-is');
    if (!bodyChanged) intentionallyUnchanged.push('body kept as-is');
    if (!shouldWrite && contentChanged && !IS_DRY_RUN && !validation.valid) intentionallyUnchanged.push('computed repairs withheld because validation failed');
    if (!shouldWrite && contentChanged && IS_DRY_RUN) intentionallyUnchanged.push('computed repairs withheld because run mode is dry-run');

    const risksAvoided = [
      'Did not create new article files',
      'Did not touch src/data/preview-post',
      'Did not invent facts or sources',
      'Kept slug and file path stable',
      'Applied only schema/taxonomy/tag/source/canonical/body hygiene repairs',
    ];

    const perArticleMarkdown = [
      `# ${slug}`,
      '',
      '## Original Issues Found',
      ...(initialIssues.length > 0 ? initialIssues.map((issue) => `- ${issue}`) : ['- None detected']),
      '',
      '## Attempted Fixes',
      ...(baseRecord.attempted_fixes.length > 0 ? baseRecord.attempted_fixes.map((fix) => `- ${fix}`) : ['- None']),
      '',
      '## Exact Fixes Applied',
      ...(baseRecord.applied_fixes.length > 0 ? baseRecord.applied_fixes.map((fix) => `- ${fix}`) : ['- No changes applied']),
      '',
      '## Withheld Fixes',
      ...(baseRecord.withheld_fixes.length > 0 ? baseRecord.withheld_fixes.map((fix) => `- ${fix}`) : ['- None']),
      '',
      '## Fields Intentionally Left Unchanged',
      ...(intentionallyUnchanged.length > 0 ? intentionallyUnchanged.map((item) => `- ${item}`) : ['- None']),
      '',
      '## Risks Avoided',
      ...risksAvoided.map((item) => `- ${item}`),
      '',
      '## Source Removals',
      ...(sourceRepair.removed.length > 0
        ? sourceRepair.removed.map((item) => `- ${item.reason}: ${item.source?.url || JSON.stringify(item.source)}`)
        : ['- None']),
      '',
      '## Unresolved Items Requiring Human Review',
      ...(baseRecord.unresolved_items.length > 0 ? baseRecord.unresolved_items.map((item) => `- ${item}`) : ['- None']),
      '',
      '## Manifest Match',
      `- matched_manifest: ${manifestPath || 'none'}`,
      `- match_score: ${manifest?.match_score ?? 0}`,
      `- strong_manifest_match: ${manifest?.match_meta?.strong ? 'true' : 'false'}`,
      `- resolver_path: ${placementRepair.resolver_path}`,
      `- placement_confidence: ${placementRepair.placement_confidence}`,
      '',
      '## Validation Result',
      `- valid: ${validation.valid ? 'true' : 'false'}`,
      ...(validation.errors.length > 0 ? validation.errors.map((error) => `- error: ${error}`) : []),
      ...(validation.warnings.length > 0 ? validation.warnings.map((warning) => `- warning: ${warning}`) : []),
      '',
    ].join('\n');

    writePerArticleLog(perArticleLogPath, perArticleMarkdown);

    appendFixLog(
      `- ${slug}: ${baseRecord.changed ? 'changed' : 'unchanged'} | issues=${initialIssues.length} | attempted=${baseRecord.attempted_fixes.length} | applied=${baseRecord.applied_fixes.length} | withheld=${baseRecord.withheld_fixes.length} | unresolved=${baseRecord.unresolved_items.length}`
    );

    inventory.push(baseRecord);
    writeInventory(inventory);
  }

  const dedupedHighRisk = dedupeStrings(highRiskArticles);
  const dedupedManual = dedupeStrings(manualReviewArticles);

  const recurring = new Map();
  for (const record of inventory) {
    for (const issue of record.issue_list || []) {
      recurring.set(issue, (recurring.get(issue) || 0) + 1);
    }
  }

  const recurringIssues = Array.from(recurring.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([issue, count]) => ({ issue, count }));

  const summary = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    dry_run: IS_DRY_RUN,
    total_live_articles: inventory.length,
    total_articles_changed: changedArticles.length,
    total_unchanged: unchangedArticles.length,
    top_recurring_issue_patterns: recurringIssues.slice(0, 10),
    high_risk_articles: dedupedHighRisk,
    articles_needing_manual_review: dedupedManual,
    runtime_report_path: path.relative(PROJECT_ROOT, RUNTIME_DIR).replace(/\\/g, '/'),
  };

  appendFixLog('\n## Summary');
  appendFixLog(`- total live articles found: ${summary.total_live_articles}`);
  appendFixLog(`- total articles changed: ${summary.total_articles_changed}`);
  appendFixLog(`- total unchanged: ${summary.total_unchanged}`);
  appendFixLog(`- mode: ${IS_DRY_RUN ? 'dry-run' : 'write'}`);
  appendFixLog(`- high-risk articles: ${summary.high_risk_articles.length}`);
  appendFixLog(`- manual review required: ${summary.articles_needing_manual_review.length}`);

  fs.writeFileSync(INVENTORY_PATH, JSON.stringify({ summary, inventory }, null, 2), 'utf-8');

  if (!IS_DRY_RUN) {
    appendGovernanceLog({
      summary: `Total live=${summary.total_live_articles}, changed=${summary.total_articles_changed}, unchanged=${summary.total_unchanged}, high-risk=${summary.high_risk_articles.length}, manual-review=${summary.articles_needing_manual_review.length}.`,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
