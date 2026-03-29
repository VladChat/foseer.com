// File: qwen-project-governance/shared/contracts/tag-registry.ts
// Purpose: Canonical contract for the controlled tag vocabulary used across drafting and publishing.

export type TagType = 'topic' | 'theme' | 'entity' | 'geography' | 'format';

export interface CanonicalTagDefinition {
  tag_id: string;
  slug: string;
  label: string;
  type: TagType;
  section_ids: string[];
  topic_ids: string[];
  aliases: string[];
  indexable: boolean;
  priority: number;
  min_posts_to_index: number;
  related_tags: string[];
}

export interface TagRegistry {
  version: number;
  generated_at: string;
  source_taxonomy_registry: string;
  tags: CanonicalTagDefinition[];
  topicTagByTopicId: Record<string, string>;
  themeTagSlugsByTopicId: Record<string, string[]>;
  entityTagSlugsByTopicId: Record<string, string[]>;
  geographyTagSlugs: string[];
  formatTagSlugs: string[];
  bySlug: Record<string, CanonicalTagDefinition>;
  byType: Record<TagType, CanonicalTagDefinition[]>;
}
