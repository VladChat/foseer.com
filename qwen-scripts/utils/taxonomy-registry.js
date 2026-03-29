// File: qwen-scripts/utils/taxonomy-registry.js
// Purpose: Runtime helper for compiled taxonomy registry access inside the qwen pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const REGISTRY_PATH = path.resolve(PROJECT_ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');

let cachedRegistry = null;

export function getTaxonomyRegistryPath() {
  return REGISTRY_PATH;
}

export function loadTaxonomyRegistry() {
  if (cachedRegistry) return cachedRegistry;
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  cachedRegistry = JSON.parse(raw);
  return cachedRegistry;
}

export function resolveSectionId(sectionId) {
  const registry = loadTaxonomyRegistry();
  if (!sectionId) return null;
  return registry.legacyMappings?.sections?.[sectionId] || sectionId;
}

export function resolveTopicId(topicId) {
  const registry = loadTaxonomyRegistry();
  if (!topicId) return null;
  return registry.legacyMappings?.topics?.[topicId] || topicId;
}

export function getSectionRecord(sectionId) {
  const registry = loadTaxonomyRegistry();
  const resolved = resolveSectionId(sectionId);
  return resolved ? registry.sectionById?.[resolved] || null : null;
}

export function getTopicRecord(topicId) {
  const registry = loadTaxonomyRegistry();
  const resolved = resolveTopicId(topicId);
  return resolved ? registry.topicById?.[resolved] || null : null;
}

export function getSectionDiscoveryQueries(sectionId) {
  const registry = loadTaxonomyRegistry();
  const resolved = resolveSectionId(sectionId);
  return Array.isArray(registry.discoveryHints?.bySection?.[resolved])
    ? registry.discoveryHints.bySection[resolved]
    : [];
}

export function getTopicDiscoveryQueries(topicId) {
  const registry = loadTaxonomyRegistry();
  const resolved = resolveTopicId(topicId);
  return Array.isArray(registry.discoveryHints?.byTopic?.[resolved])
    ? registry.discoveryHints.byTopic[resolved]
    : [];
}

export function getTopicIdsBySection(sectionId) {
  const registry = loadTaxonomyRegistry();
  const resolved = resolveSectionId(sectionId);
  return Array.isArray(registry.topicsBySection?.[resolved])
    ? registry.topicsBySection[resolved]
    : [];
}


function normalizeHintCorpus(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function containsNormalizedPhrase(text, phrase) {
  const normalizedText = normalizeHintCorpus(text);
  const normalizedPhrase = normalizeHintCorpus(phrase);
  if (!normalizedText || !normalizedPhrase) return false;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const pattern = new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i');
  return pattern.test(normalizedText);
}

export function matchTaxonomyHints(value, url = '') {
  const registry = loadTaxonomyRegistry();
  const text = normalizeHintCorpus(`${value || ''} ${url || ''}`);
  const topicScores = [];
  const sectionScores = new Map();

  for (const topic of registry.topics || []) {
    let score = 0;
    const aliases = Array.isArray(topic.aliases) ? topic.aliases : [];
    const phrases = [topic.label, topic.id, topic.slug, ...aliases]
      .map((item) => normalizeHintCorpus(item))
      .filter(Boolean);

    for (const normalized of phrases) {
      if (!normalized) continue;
      if (containsNormalizedPhrase(text, normalized)) {
        score += normalized.split(' ').length >= 2 ? 4 : 2;
        continue;
      }
      const parts = normalized.split(' ').filter(Boolean);
      if (parts.length >= 2 && parts.every((part) => containsNormalizedPhrase(text, part))) {
        score += 3;
      }
    }

    if (score > 0) {
      topicScores.push({ id: topic.id, score, section_id: topic.section_id });
      sectionScores.set(topic.section_id, (sectionScores.get(topic.section_id) || 0) + score);
    }
  }

  for (const section of registry.sections || []) {
    const phrases = [section.label, section.id, section.slug]
      .map((item) => normalizeHintCorpus(item))
      .filter(Boolean);
    for (const normalized of phrases) {
      if (!normalized) continue;
      if (containsNormalizedPhrase(text, normalized)) {
        sectionScores.set(section.id, (sectionScores.get(section.id) || 0) + 1);
      }
    }
  }

  topicScores.sort((a, b) => b.score - a.score);
  const sectionCandidates = Array.from(sectionScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, 3);

  const topicCandidates = topicScores.map((item) => item.id).slice(0, 3);
  const detectedTopicId = topicScores[0]?.score >= 3 ? topicScores[0].id : null;
  const detectedSectionId = detectedTopicId
    ? registry.sectionByTopic?.[detectedTopicId] || topicScores[0]?.section_id || sectionCandidates[0] || null
    : sectionCandidates[0] || null;

  return {
    detectedSectionId,
    detectedTopicId,
    sectionCandidates,
    topicCandidates,
    confidence: topicScores[0]?.score || sectionScores.get(detectedSectionId) || 0,
  };
}
