// File: qwen-scripts/validate-taxonomy-registry.js
// Purpose: Smoke-check the compiled taxonomy registry and topic metrics coverage.

import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './utils/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const ROOT = PROJECT_ROOT;
const REGISTRY_PATH = path.resolve(ROOT, 'qwen-data', 'contracts', 'taxonomy-registry.json');
const METRICS_PATH = path.resolve(ROOT, 'src', 'data', 'topic-metrics.json');

function fail(message) {
  console.error(`[validate-taxonomy-registry] ERROR: ${message}`);
  process.exitCode = 1;
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
const metrics = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));

const sectionIds = registry.sections.map((section) => section.id);
const topicIds = registry.topics.map((topic) => topic.id);

if (new Set(sectionIds).size !== sectionIds.length) fail('Duplicate section ids detected.');
if (new Set(topicIds).size !== topicIds.length) fail('Duplicate topic ids detected.');

for (const topic of registry.topics) {
  if (!sectionIds.includes(topic.section_id)) {
    fail(`Topic ${topic.id} references missing section ${topic.section_id}.`);
  }
}

for (const [sectionId, topicIdsForSection] of Object.entries(registry.topicsBySection || {})) {
  if (!sectionIds.includes(sectionId)) fail(`topicsBySection contains unknown section ${sectionId}.`);
  for (const topicId of topicIdsForSection) {
    if (!topicIds.includes(topicId)) fail(`topicsBySection.${sectionId} references unknown topic ${topicId}.`);
  }
}

for (const [legacyTopicId, canonicalTopicId] of Object.entries(registry.legacyMappings?.topics || {})) {
  if (!topicIds.includes(canonicalTopicId)) {
    fail(`Legacy topic mapping ${legacyTopicId} -> ${canonicalTopicId} points to a missing topic.`);
  }
}

for (const sectionId of sectionIds) {
  if (!metrics.sections?.[sectionId]) fail(`Missing section metrics for ${sectionId}.`);
}

for (const topicId of topicIds) {
  if (!metrics.topics?.[topicId]) fail(`Missing topic metrics for ${topicId}.`);
}

if (!process.exitCode) {
  console.log(`[validate-taxonomy-registry] OK: ${sectionIds.length} sections, ${topicIds.length} topics, metrics coverage complete.`);
}
