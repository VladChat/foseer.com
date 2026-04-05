// File: qwen-scripts/compile-rss-feed-registry.js
// Purpose: Compile and validate RSS feed registry for runtime discovery usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const SOURCE_PATH = path.resolve(PROJECT_ROOT, 'src', 'data', 'rss-feeds.json');
const FALLBACK_RUNTIME_SOURCE_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'rss-feed-registry.json');
const TAXONOMY_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');
const OUTPUT_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'rss-feed-registry.json');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadSourceFeedRecords() {
  if (fs.existsSync(SOURCE_PATH)) {
    const parsed = readJson(SOURCE_PATH);
    assert(Array.isArray(parsed), `[compile-rss-feed-registry] Source file must be an array: ${path.relative(PROJECT_ROOT, SOURCE_PATH)}`);
    return {
      sourcePath: SOURCE_PATH,
      sourceKind: 'authoring_source',
      records: parsed,
    };
  }

  if (fs.existsSync(FALLBACK_RUNTIME_SOURCE_PATH)) {
    const parsed = readJson(FALLBACK_RUNTIME_SOURCE_PATH);
    const feeds = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.feeds)
        ? parsed.feeds
        : null;
    assert(Array.isArray(feeds), `[compile-rss-feed-registry] Fallback runtime source is invalid: ${path.relative(PROJECT_ROOT, FALLBACK_RUNTIME_SOURCE_PATH)}`);
    return {
      sourcePath: FALLBACK_RUNTIME_SOURCE_PATH,
      sourceKind: 'runtime_fallback',
      records: feeds,
    };
  }

  throw new Error('[compile-rss-feed-registry] No RSS feed source found. Expected src/data/rss-feeds.json or qwen-data/contracts/rss-feed-registry.json');
}

function loadTaxonomy() {
  assert(fs.existsSync(TAXONOMY_REGISTRY_PATH), `[compile-rss-feed-registry] Taxonomy registry not found: ${path.relative(PROJECT_ROOT, TAXONOMY_REGISTRY_PATH)}`);
  const taxonomy = readJson(TAXONOMY_REGISTRY_PATH);

  const sectionIds = new Set((taxonomy.sections || []).map((section) => normalizeText(section.id)).filter(Boolean));
  const topicIds = new Set((taxonomy.topics || []).map((topic) => normalizeText(topic.id)).filter(Boolean));

  return {
    taxonomy,
    sectionIds,
    topicIds,
    sectionAliases: {
      ...(taxonomy.aliases?.sections || {}),
      ...(taxonomy.legacyMappings?.sections || {}),
    },
    topicAliases: {
      ...(taxonomy.aliases?.topics || {}),
      ...(taxonomy.legacyMappings?.topics || {}),
    },
  };
}

function resolveSectionHint(rawValue, helpers) {
  const raw = normalizeText(rawValue);
  if (!raw) return null;
  if (helpers.sectionIds.has(raw)) return raw;

  const byAlias = normalizeText(helpers.sectionAliases?.[raw]);
  if (byAlias && helpers.sectionIds.has(byAlias)) return byAlias;

  for (const section of helpers.taxonomy.sections || []) {
    if (normalizeText(section.label) === raw) return normalizeText(section.id);
  }

  return null;
}

function resolveTopicHint(rawValue, helpers) {
  const raw = normalizeText(rawValue);
  if (!raw) return null;
  if (helpers.topicIds.has(raw)) return raw;

  const byAlias = normalizeText(helpers.topicAliases?.[raw]);
  if (byAlias && helpers.topicIds.has(byAlias)) return byAlias;

  for (const topic of helpers.taxonomy.topics || []) {
    if (normalizeText(topic.label) === raw) return normalizeText(topic.id);
  }

  return null;
}

function normalizeFeedRecord(rawRecord, index, seenFeedIds, helpers) {
  assert(rawRecord && typeof rawRecord === 'object' && !Array.isArray(rawRecord), `[compile-rss-feed-registry] Feed at index ${index} must be an object`);

  const id = normalizeText(rawRecord.id);
  assert(id, `[compile-rss-feed-registry] Feed at index ${index} has missing/empty id`);
  assert(!seenFeedIds.has(id), `[compile-rss-feed-registry] Duplicate feed id: ${id}`);
  seenFeedIds.add(id);

  const url = String(rawRecord.url || '').trim();
  assert(url, `[compile-rss-feed-registry] Feed '${id}' missing url`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`[compile-rss-feed-registry] Feed '${id}' has invalid url: ${url}`);
  }
  assert(['http:', 'https:'].includes(parsedUrl.protocol), `[compile-rss-feed-registry] Feed '${id}' url must be http/https: ${url}`);

  const publisher = String(rawRecord.publisher || '').trim();
  assert(publisher, `[compile-rss-feed-registry] Feed '${id}' missing publisher`);

  const sectionHintsRaw = Array.isArray(rawRecord.sectionHints) ? rawRecord.sectionHints : [];
  const topicHintsRaw = Array.isArray(rawRecord.topicHints) ? rawRecord.topicHints : [];

  const normalizedSectionHints = unique(sectionHintsRaw.map((value) => {
    const resolved = resolveSectionHint(value, helpers);
    if (!resolved) {
      throw new Error(`[compile-rss-feed-registry] Feed '${id}' has unknown section hint: ${String(value)}`);
    }
    return resolved;
  }));

  const normalizedTopicHints = unique(topicHintsRaw.map((value) => {
    const resolved = resolveTopicHint(value, helpers);
    if (!resolved) {
      throw new Error(`[compile-rss-feed-registry] Feed '${id}' has unknown topic hint: ${String(value)}`);
    }
    return resolved;
  }));

  const topicDerivedSectionHints = normalizedTopicHints
    .map((topicId) => normalizeText(helpers.taxonomy.sectionByTopic?.[topicId]))
    .filter((sectionId) => sectionId && helpers.sectionIds.has(sectionId));

  const finalSectionHints = unique([...normalizedSectionHints, ...topicDerivedSectionHints]);
  assert(finalSectionHints.length > 0, `[compile-rss-feed-registry] Feed '${id}' must provide at least one valid section/topic hint`);

  const enabled = rawRecord.enabled !== false;

  const priority = Number(rawRecord.priority ?? 1);
  assert(Number.isFinite(priority) && priority >= 0 && priority <= 5, `[compile-rss-feed-registry] Feed '${id}' has invalid priority`);

  const maxItemsPerPoll = Math.round(Number(rawRecord.maxItemsPerPoll ?? 3));
  assert(Number.isFinite(maxItemsPerPoll) && maxItemsPerPoll > 0 && maxItemsPerPoll <= 50, `[compile-rss-feed-registry] Feed '${id}' has invalid maxItemsPerPoll`);

  const freshnessHours = Math.round(Number(rawRecord.freshnessHours ?? 72));
  assert(Number.isFinite(freshnessHours) && freshnessHours > 0 && freshnessHours <= 24 * 14, `[compile-rss-feed-registry] Feed '${id}' has invalid freshnessHours`);

  const notes = rawRecord.notes ? String(rawRecord.notes).trim() : undefined;

  return {
    id,
    url: parsedUrl.toString(),
    publisher,
    sectionHints: finalSectionHints,
    topicHints: normalizedTopicHints,
    enabled,
    priority,
    maxItemsPerPoll,
    freshnessHours,
    ...(notes ? { notes } : {}),
  };
}

export function buildRssFeedRegistry() {
  const source = loadSourceFeedRecords();
  const helpers = loadTaxonomy();
  const seenFeedIds = new Set();

  const feeds = source.records
    .map((record, index) => normalizeFeedRecord(record, index, seenFeedIds, helpers))
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.id.localeCompare(right.id);
    });

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    source_path: path.relative(PROJECT_ROOT, source.sourcePath).replace(/\\/g, '/'),
    source_kind: source.sourceKind,
    taxonomy_registry_path: path.relative(PROJECT_ROOT, TAXONOMY_REGISTRY_PATH).replace(/\\/g, '/'),
    feed_count: feeds.length,
    feeds,
  };
}

export function writeRssFeedRegistry() {
  const registry = buildRssFeedRegistry();
  ensureDir(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  console.log(`[compile-rss-feed-registry] Wrote ${registry.feed_count} feeds to ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  return registry;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  writeRssFeedRegistry();
}
