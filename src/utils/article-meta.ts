// File: src/utils/article-meta.ts
// Purpose: Resolve article section/subsection and article type labels for the article metadata card.

import type { Post } from '~/types';
import { getTaxonomy } from '~/utils/foseer-taxonomy';

export function getResolvedArticlePlacement(post: Pick<Post, 'section' | 'subsection' | 'section_id' | 'topic_id'>) {
  const taxonomy = getTaxonomy();
  const sectionInfo = post.section_id ? taxonomy.sections.find((section) => section.id === post.section_id) : undefined;
  const topicInfo = post.topic_id ? taxonomy.sections.flatMap((section) => section.topics).find((topic) => topic.id === post.topic_id) : undefined;

  const sectionLabel = sectionInfo?.title || post.section?.trim() || '';
  const subsectionLabel = topicInfo?.title || post.subsection?.trim() || '';

  return {
    sectionLabel,
    subsectionLabel: subsectionLabel && subsectionLabel !== sectionLabel ? subsectionLabel : '',
  };
}

export function getArticleTypeLabel(articleType?: string) {
  const normalized = String(articleType || '').trim().toLowerCase();
  if (normalized === 'analysis') return 'Analysis';
  if (normalized === 'explainer') return 'Explainer';
  if (normalized === 'report') return 'News Report';
  return '';
}
