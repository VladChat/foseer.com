// File: src/utils/post-image.ts
// Purpose: Unified image resolver for article covers with fallback support.

import type { ImageMetadata } from 'astro';
import { findImage } from './images';
import fallbackCover from '~/assets/images/posts/fallback/foseer-default-cover.svg';

/**
 * Fallback image path - used when article has no cover image
 */
const FALLBACK_IMAGE = '~/assets/images/posts/fallback/foseer-default-cover.svg';

/**
 * Base path for article cover images
 */
const POSTS_IMAGES_BASE = '~/assets/images/posts/';

const isRenderableImage = (image: string | ImageMetadata | null | undefined): image is string | ImageMetadata => {
  if (!image) return false;
  if (typeof image !== 'string') return true;

  const value = image.trim();
  if (!value) return false;

  return value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://');
};

/**
 * Resolve article cover image with fallback
 * 
 * @param image - Image path from article frontmatter
 * @param slug - Article slug for dynamic image resolution
 * @returns Resolved image path or fallback
 */
export const resolvePostImage = async (
  image: string | ImageMetadata | null | undefined,
  slug?: string
): Promise<string | ImageMetadata | null> => {
  // If explicit image is provided, try to resolve it
  if (image) {
    const resolvedImage = await findImage(image);
    if (isRenderableImage(resolvedImage)) {
      return resolvedImage;
    }
  }

  // If slug is provided, try to load article-specific cover
  if (slug) {
    const slugImage = `${POSTS_IMAGES_BASE}${slug}/cover.jpg`;
    const resolvedSlugImage = await findImage(slugImage);
    if (isRenderableImage(resolvedSlugImage)) {
      return resolvedSlugImage;
    }
  }

  // Return fallback image, guaranteeing non-null output even if dynamic lookup fails.
  const resolvedFallbackImage = await findImage(FALLBACK_IMAGE);
  return isRenderableImage(resolvedFallbackImage) ? resolvedFallbackImage : fallbackCover;
};

/**
 * Generate alt text for article cover image
 * 
 * @param title - Article title
 * @param excerpt - Article excerpt (optional)
 * @returns Alt text for accessibility
 */
export const generateImageAlt = (title: string, excerpt?: string): string => {
  // Clean title for alt text
  const cleanTitle = title.replace(/["']/g, '').trim();
  
  // Simple, descriptive alt text
  return `Cover image for: ${cleanTitle}`;
};

/**
 * Get image path for article (for frontmatter storage)
 * 
 * @param slug - Article slug
 * @returns Normalized image path for storage
 */
export const getArticleImagePath = (slug: string): string => {
  return `${POSTS_IMAGES_BASE}${slug}/cover.jpg`;
};
