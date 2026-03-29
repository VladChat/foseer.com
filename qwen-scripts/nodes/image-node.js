// File: qwen-scripts/nodes/image-node.js
// Purpose: Wrapper node that produces a standardized image package from draft + taxonomy context.

import { getArticleImage } from '../image-support.js';

export async function generateImagePackage(selected, articleSlug, providerApiKeys = {}) {
  const draft = selected?.draft || {};
  const image = await getArticleImage(draft, articleSlug, providerApiKeys, {
    brief: selected?.brief || null,
    sourcePack: selected?.sourcePack || null,
    placement: selected?.placement || null,
  });

  return {
    ...image,
    metadata: {
      ...(image.metadata || {}),
      section_id: draft.section_id || selected?.brief?.section_id || selected?.placement?.section_id || null,
      topic_id: draft.topic_id || selected?.brief?.topic_id || selected?.placement?.topic_id || null,
    },
  };
}
