// File: qwen-project-governance/shared/contracts/validators.ts
// Purpose: Reusable validation helpers for compiled taxonomy registry coverage and integrity.

import type { TaxonomyRegistry } from './taxonomy-registry.js';

export interface RegistryValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

export function validateRegistryShape(registry: TaxonomyRegistry): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  const sectionIds = new Set<string>();
  const topicIds = new Set<string>();

  for (const section of registry.sections) {
    if (sectionIds.has(section.id)) {
      issues.push({ level: 'error', message: `Duplicate section id: ${section.id}` });
    }
    sectionIds.add(section.id);
  }

  for (const topic of registry.topics) {
    if (topicIds.has(topic.id)) {
      issues.push({ level: 'error', message: `Duplicate topic id: ${topic.id}` });
    }
    topicIds.add(topic.id);

    if (!sectionIds.has(topic.section_id)) {
      issues.push({ level: 'error', message: `Topic ${topic.id} references missing section ${topic.section_id}` });
    }
  }

  for (const [sectionId, topicIdsForSection] of Object.entries(registry.topicsBySection)) {
    if (!sectionIds.has(sectionId)) {
      issues.push({ level: 'error', message: `topicsBySection contains unknown section ${sectionId}` });
    }
    for (const topicId of topicIdsForSection) {
      if (!topicIds.has(topicId)) {
        issues.push({ level: 'error', message: `topicsBySection.${sectionId} references unknown topic ${topicId}` });
      }
    }
  }

  return issues;
}
