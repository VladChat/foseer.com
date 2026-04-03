// File: src/utils/topic-posts.ts
// Purpose: Helper to fetch blog posts related to a topic via canonical taxonomy fields
//
// Canonical taxonomy contract:
// - Articles are retrieved by explicit topic_id frontmatter field (primary)
// - Falls back to tags matching for backward compatibility with legacy articles

import { getCollection } from 'astro:content';

/**
 * Get posts by topic slug using canonical taxonomy fields.
 * 
 * Priority order:
 * 1. Explicit topic_id frontmatter field (canonical)
 * 2. Tags array containing topic slug (legacy fallback)
 * 
 * This ensures deterministic article placement based on explicit taxonomy
 * classification rather than accidental tag overlap.
 */
export async function getPostsByTopicSlug(topicSlug: string) {
  const posts = await getCollection('post');

  return posts
    .filter((post) => {
      // Primary: Check explicit topic_id field (canonical taxonomy contract)
      if (post.data.topic_id) {
        return post.data.topic_id === topicSlug;
      }

      // Fallback: Check tags array for backward compatibility
      return post.data.tags?.includes(topicSlug);
    })
    .sort((a, b) => new Date(b.data.publishDate).valueOf() - new Date(a.data.publishDate).valueOf());
}

/**
 * Get posts by section using canonical section_id field.
 * 
 * Priority order:
 * 1. Explicit section_id frontmatter field (canonical)
 * 2. Category field matching section slug (legacy fallback)
 */
export async function getPostsBySectionSlug(sectionSlug: string) {
  const posts = await getCollection('post');

  return posts
    .filter((post) => {
      // Primary: Check explicit section_id field (canonical taxonomy contract)
      if (post.data.section_id) {
        return post.data.section_id === sectionSlug;
      }

      // Fallback: Check category field for backward compatibility
      // Note: This is a loose match since category is human-readable
      return post.data.category?.toLowerCase().includes(sectionSlug.toLowerCase());
    })
    .sort((a, b) => new Date(b.data.publishDate).valueOf() - new Date(a.data.publishDate).valueOf());
}

/**
 * Get posts by both section and topic using canonical taxonomy fields.
 * Ensures articles are placed in the correct section/topic combination.
 */
export async function getPostsBySectionAndTopic(sectionSlug: string, topicSlug: string) {
  const posts = await getCollection('post');

  return posts
    .filter((post) => {
      const hasSectionMatch = post.data.section_id
        ? post.data.section_id === sectionSlug
        : post.data.category?.toLowerCase().includes(sectionSlug.toLowerCase());

      const hasTopicMatch = post.data.topic_id
        ? post.data.topic_id === topicSlug
        : post.data.tags?.includes(topicSlug);

      // Require both section and topic to match for precise placement
      return hasSectionMatch && hasTopicMatch;
    })
    .sort((a, b) => new Date(b.data.publishDate).valueOf() - new Date(a.data.publishDate).valueOf());
}
