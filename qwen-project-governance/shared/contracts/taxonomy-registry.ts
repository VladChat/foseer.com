// File: qwen-project-governance/shared/contracts/taxonomy-registry.ts
// Purpose: Shared contract for the compiled taxonomy registry consumed by downstream nodes.

export type RegistrySectionKind = 'core' | 'special';
export type CanonicalArticleType = 'report' | 'analysis' | 'explainer';

export interface RegistrySection {
  id: string;
  slug: string;
  label: string;
  description?: string;
  kind: RegistrySectionKind;
  topic_ids: string[];
}

export interface RegistryTopic {
  id: string;
  slug: string;
  label: string;
  description?: string;
  section_id: string;
  section_slug: string;
  section_label: string;
  aliases: string[];
}

export interface RegistryLegacyMappings {
  topics: Record<string, string>;
  sections: Record<string, string>;
}

export interface RegistryDiscoveryHints {
  bySection: Record<string, string[]>;
  byTopic: Record<string, string[]>;
}

export interface RegistryImageHints {
  bySection: Record<string, string[]>;
  byTopic: Record<string, string[]>;
}

export interface RegistryWriterHints {
  defaultArticleTypeBySection: Record<string, CanonicalArticleType>;
  reportTopicIds: string[];
}

export interface TaxonomyRegistry {
  version: string;
  generated_at: string;
  source_path: string;
  sections: RegistrySection[];
  topics: RegistryTopic[];
  sectionById: Record<string, RegistrySection>;
  topicById: Record<string, RegistryTopic>;
  topicsBySection: Record<string, string[]>;
  sectionByTopic: Record<string, string>;
  aliases: {
    sections: Record<string, string>;
    topics: Record<string, string>;
  };
  legacyMappings: RegistryLegacyMappings;
  navigation: {
    coreSectionIds: string[];
    footerBrowseIds: string[];
    headerTopicLimit: number;
  };
  discoveryHints: RegistryDiscoveryHints;
  imageHints: RegistryImageHints;
  writerHints: RegistryWriterHints;
}
