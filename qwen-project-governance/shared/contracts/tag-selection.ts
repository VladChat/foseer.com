// File: qwen-project-governance/shared/contracts/tag-selection.ts
// Purpose: Canonical result of the tag picker node for a single article.

export interface TagSelectionItem {
  slug: string;
  label: string;
  type: 'topic' | 'theme' | 'entity' | 'geography' | 'format';
  score: number;
  reason: string;
}

export interface TagSelectionResult {
  tags: string[];
  tag_slugs: string[];
  primary_topic_tag: string | null;
  primary_topic_slug: string | null;
  selected: TagSelectionItem[];
  warnings: string[];
  diagnostics: {
    section_id: string | null;
    topic_id: string | null;
    article_type: string | null;
    source_entity_count: number;
    source_title_count: number;
  };
}
