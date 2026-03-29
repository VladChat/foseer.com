// File: qwen-project-governance/shared/contracts/image-package.ts
// Purpose: Contract for image node output consumed by publisher and UI.

export interface ImagePackageContract {
  articleSlug: string;
  imagePath: string;
  altText: string;
  imageAlt?: string;
  provider: string;
  sourceUrl?: string | null;
  metadata?: {
    section_id?: string | null;
    topic_id?: string | null;
    assetKey?: string | null;
    queryUsed?: string | null;
    selectionMode?: string | null;
    width?: number | null;
    height?: number | null;
    format?: string | null;
    authorName?: string | null;
    [key: string]: unknown;
  };
}
