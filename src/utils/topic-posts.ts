// File: src/utils/topic-posts.ts
// Purpose: Helper to fetch blog posts related to a topic via tags

import { getCollection } from 'astro:content';

export async function getPostsByTopicSlug(topicSlug: string) {
  const posts = await getCollection('post');
  return posts.filter((post) =>
    post.data.tags?.includes(topicSlug)
  );
}
