import { getRssString } from '@astrojs/rss';

import { SITE, METADATA, APP_BLOG } from 'astrowind:config';
import { fetchPosts } from '~/utils/blog';
import { getPermalink } from '~/utils/permalinks';

export const GET = async () => {
  if (!APP_BLOG.isEnabled) {
    return new Response(null, {
      status: 404,
      statusText: 'Not found',
    });
  }

  const posts = await fetchPosts();

  const rss = await getRssString({
    title: `${SITE.name}’s Blog`,
    description: METADATA?.description || '',
    site: import.meta.env.SITE,
    customData: `
      <language>en</language>
      <copyright>© ${new Date().getFullYear()} ${SITE.name}. All rights reserved.</copyright>
      <managingEditor>editor@foseer.com (Foseer Editorial Team)</managingEditor>
      <webMaster>webmaster@foseer.com (Foseer Web Team)</webMaster>
      <image>
        <url>${import.meta.env.SITE}/_astro/favicon.Czy1EQHj.svg</url>
        <title>${SITE.name}</title>
        <link>${import.meta.env.SITE}</link>
        <width>144</width>
        <height>144</height>
      </image>
    `,

    items: posts.map((post) => ({
      link: getPermalink(post.permalink, 'post'),
      title: post.title,
      description: post.excerpt,
      pubDate: post.publishDate,
      author: post.author || SITE.name,
      categories: post.category ? [post.category.title] : [],
      customData: `
        <author>${post.author || SITE.name}</author>
        <category>${post.category ? post.category.title : 'News'}</category>
        <guid isPermaLink="true">${getPermalink(post.permalink, 'post')}</guid>
        ${post.updateDate ? `<lastBuildDate>${new Date(post.updateDate).toUTCString()}</lastBuildDate>` : ''}
      `,
    })),

    trailingSlash: SITE.trailingSlash,
  });

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/xml',
    },
  });
};
