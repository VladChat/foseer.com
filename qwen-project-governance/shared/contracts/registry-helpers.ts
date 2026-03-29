// File: qwen-project-governance/shared/contracts/registry-helpers.ts
// Purpose: Read the compiled taxonomy registry from disk and provide common lookup helpers.

import fs from 'node:fs';
import path from 'node:path';
import type { TaxonomyRegistry } from './taxonomy-registry.js';

const REGISTRY_PATH = path.resolve(process.cwd(), 'qwen-data', 'contracts', 'taxonomy-registry.json');

let cachedRegistry: TaxonomyRegistry | null = null;

export function getTaxonomyRegistryPath(): string {
  return REGISTRY_PATH;
}

export function loadTaxonomyRegistry(): TaxonomyRegistry {
  if (cachedRegistry) return cachedRegistry;
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  cachedRegistry = JSON.parse(raw) as TaxonomyRegistry;
  return cachedRegistry;
}

export function getRegistrySectionIds(): string[] {
  return loadTaxonomyRegistry().sections.map((section) => section.id);
}

export function getRegistryTopicIds(): string[] {
  return loadTaxonomyRegistry().topics.map((topic) => topic.id);
}

export function getRegistryTopicSection(topicId: string): string | null {
  const registry = loadTaxonomyRegistry();
  const resolvedTopicId = registry.legacyMappings.topics[topicId] || topicId;
  return registry.sectionByTopic[resolvedTopicId] || null;
}
