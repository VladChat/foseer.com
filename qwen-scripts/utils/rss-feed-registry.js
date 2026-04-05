// File: qwen-scripts/utils/rss-feed-registry.js
// Purpose: Runtime loader for compiled RSS feed registry used by discovery providers.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const RSS_FEED_REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'rss-feed-registry.json');

let cachedRegistry = null;

function normalizeFeed(feed = {}) {
  return {
    id: String(feed.id || '').trim().toLowerCase(),
    url: String(feed.url || '').trim(),
    publisher: String(feed.publisher || '').trim(),
    sectionHints: Array.isArray(feed.sectionHints)
      ? Array.from(new Set(feed.sectionHints.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    topicHints: Array.isArray(feed.topicHints)
      ? Array.from(new Set(feed.topicHints.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    enabled: feed.enabled !== false,
    priority: Number(feed.priority ?? 1),
    maxItemsPerPoll: Math.max(1, Number(feed.maxItemsPerPoll ?? 3)),
    freshnessHours: Math.max(1, Number(feed.freshnessHours ?? 72)),
    ...(feed.notes ? { notes: String(feed.notes).trim() } : {}),
  };
}

function normalizeRegistry(parsed = {}) {
  const feedsRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.feeds)
      ? parsed.feeds
      : [];

  const feeds = feedsRaw
    .map((feed) => normalizeFeed(feed))
    .filter((feed) => feed.id && feed.url && feed.publisher)
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      return left.id.localeCompare(right.id);
    });

  return {
    version: String(parsed?.version || '1.0.0'),
    generated_at: parsed?.generated_at || null,
    source_path: parsed?.source_path || null,
    feed_count: feeds.length,
    feeds,
  };
}

export function getRssFeedRegistryPath() {
  return RSS_FEED_REGISTRY_PATH;
}

export function loadRssFeedRegistry({ forceReload = false } = {}) {
  if (!forceReload && cachedRegistry) return cachedRegistry;

  if (!fs.existsSync(RSS_FEED_REGISTRY_PATH)) {
    cachedRegistry = normalizeRegistry({});
    return cachedRegistry;
  }

  const parsed = JSON.parse(fs.readFileSync(RSS_FEED_REGISTRY_PATH, 'utf-8'));
  cachedRegistry = normalizeRegistry(parsed);
  return cachedRegistry;
}

export function getEnabledRssFeeds(options = {}) {
  const registry = loadRssFeedRegistry(options);
  return registry.feeds.filter((feed) => feed.enabled !== false);
}
