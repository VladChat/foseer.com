import { z, defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const metadataDefinition = () =>
  z
    .object({
      title: z.string().optional(),
      ignoreTitleTemplate: z.boolean().optional(),

      canonical: z.string().url().optional(),

      robots: z
        .object({
          index: z.boolean().optional(),
          follow: z.boolean().optional(),
        })
        .optional(),

      description: z.string().optional(),

      openGraph: z
        .object({
          url: z.string().optional(),
          siteName: z.string().optional(),
          images: z
            .array(
              z.object({
                url: z.string(),
                width: z.number().optional(),
                height: z.number().optional(),
              })
            )
            .optional(),
          locale: z.string().optional(),
          type: z.string().optional(),
        })
        .optional(),

      twitter: z
        .object({
          handle: z.string().optional(),
          site: z.string().optional(),
          cardType: z.string().optional(),
        })
        .optional(),
    })
    .optional();

const postCollection = defineCollection({
  loader: glob({ 
    pattern: ['*.md', '*.mdx'], 
    base: 'src/data/post',
    ignore: ['_quarantine/**'],
  }),
  schema: z.object({
    publishDate: z.date().optional(),
    updateDate: z.date().optional(),
    draft: z.boolean().optional(),

    title: z.string(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    imagePublicUrl: z.string().optional(),
    imageCaption: z.string().optional(),
    imageProvider: z.string().optional(),
    imageAuthorName: z.string().optional(),
    imageAuthorUrl: z.string().optional(),
    imageSourceUrl: z.string().optional(),

    // Legacy fields (kept for backward compatibility)
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    section: z.string().optional(),
    subsection: z.string().optional(),
    author: z.string().optional(),
    authorTitle: z.string().optional(),
    sources: z.array(z.object({ title: z.string(), url: z.string().url(), domain: z.string().optional() })).optional(),

    // Canonical taxonomy fields (new)
    article_type: z.enum(['explainer', 'analysis', 'report']).optional(),
    section_id: z.string().optional(),
    topic_id: z.string().optional(),

    metadata: metadataDefinition(),
  }),
});

const previewPostCollection = defineCollection({
  loader: glob({ pattern: ['*.md', '*.mdx'], base: 'src/data/preview-post' }),
  schema: z.object({
    publishDate: z.date().optional(),
    updateDate: z.date().optional(),
    draft: z.boolean().optional(),

    title: z.string(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    imagePublicUrl: z.string().optional(),
    imageCaption: z.string().optional(),
    imageProvider: z.string().optional(),
    imageAuthorName: z.string().optional(),
    imageAuthorUrl: z.string().optional(),
    imageSourceUrl: z.string().optional(),

    // Legacy fields (kept for backward compatibility)
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    section: z.string().optional(),
    subsection: z.string().optional(),
    author: z.string().optional(),
    authorTitle: z.string().optional(),
    sources: z.array(z.object({ title: z.string(), url: z.string().url(), domain: z.string().optional() })).optional(),

    // Canonical taxonomy fields (new)
    article_type: z.enum(['explainer', 'analysis', 'report']).optional(),
    section_id: z.string().optional(),
    topic_id: z.string().optional(),

    metadata: metadataDefinition(),
  }),
});

export const collections = {
  post: postCollection,
  previewPost: previewPostCollection,
};
