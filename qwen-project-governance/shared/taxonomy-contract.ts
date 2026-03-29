// File: qwen-project-governance/shared/taxonomy-contract.ts
// Purpose: Shared taxonomy types and registry access for publisher/runtime paths.

import fs from 'node:fs';
import path from 'node:path';
import type { TaxonomyRegistry } from './contracts/taxonomy-registry.js';

export type CanonicalArticleType = 'explainer' | 'analysis' | 'report';
export type SectionId = string;
export type TopicId = string;

const REGISTRY_PATH = path.resolve(process.cwd(), 'qwen-data', 'contracts', 'taxonomy-registry.json');
let cachedRegistry: TaxonomyRegistry | null = null;

export function loadSharedTaxonomyRegistry(): TaxonomyRegistry {
  if (cachedRegistry) return cachedRegistry;
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  cachedRegistry = JSON.parse(raw) as TaxonomyRegistry;
  return cachedRegistry;
}
